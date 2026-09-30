import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { DB_PATH } from '@/lib/config';
import type {
  Message,
  NewMessage,
  NewProject,
  Project,
  ProjectPatch,
  Settings,
  SettingsPatch,
  Store,
} from './types';

export const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'agentcloud.sqlite');

type Row = Record<string, unknown>;

/**
 * Driver fallback: SQLite lokal (better-sqlite3).
 * Dipakai otomatis kalau Supabase belum dikonfigurasi atau sedang tidak bisa diakses.
 */
export class SqliteStore implements Store {
  private db: Database.Database;
  readonly path: string;

  constructor(filePath?: string) {
    const target = filePath || DB_PATH || DEFAULT_DB_PATH;
    this.path = target;
    if (target !== ':memory:') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
    }
    this.db = new Database(target);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  /** Idempotent bootstrap - dibungkus satu transaksi supaya tidak fsync per statement. */
  private migrate(): void {
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ac_settings (
          owner_id TEXT PRIMARY KEY,
          openrouter_api_key TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ac_projects (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          sandbox_id TEXT,
          preview_port INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ac_messages (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          parts TEXT,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_ac_projects_owner ON ac_projects (owner_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ac_messages_project ON ac_messages (project_id, created_at ASC);
      `);
    })();
  }

  async ping(): Promise<void> {
    this.db.prepare('SELECT 1').get();
  }

  async getSettings(ownerId: string): Promise<Settings | null> {
    const row = this.db.prepare('SELECT * FROM ac_settings WHERE owner_id = ?').get(ownerId) as Row | undefined;
    return row ? rowToSettings(row) : null;
  }

  async saveSettings(ownerId: string, patch: SettingsPatch): Promise<Settings> {
    const current = (await this.getSettings(ownerId)) ?? {
      owner_id: ownerId,
      openrouter_api_key: '',
      model: '',
      updated_at: new Date().toISOString(),
    };
    const next: Settings = {
      ...current,
      ...patch,
      owner_id: ownerId,
      updated_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO ac_settings (owner_id, openrouter_api_key, model, updated_at)
         VALUES (@owner_id, @openrouter_api_key, @model, @updated_at)
         ON CONFLICT(owner_id) DO UPDATE SET
           openrouter_api_key = excluded.openrouter_api_key,
           model = excluded.model,
           updated_at = excluded.updated_at`,
      )
      .run(next);
    return next;
  }

  async listProjects(ownerId: string): Promise<Project[]> {
    const rows = this.db
      .prepare('SELECT * FROM ac_projects WHERE owner_id = ? ORDER BY updated_at DESC')
      .all(ownerId) as Row[];
    return rows.map(rowToProject);
  }

  async getProject(ownerId: string, id: string): Promise<Project | null> {
    const row = this.db
      .prepare('SELECT * FROM ac_projects WHERE id = ? AND owner_id = ?')
      .get(id, ownerId) as Row | undefined;
    return row ? rowToProject(row) : null;
  }

  async createProject(ownerId: string, input: NewProject): Promise<Project> {
    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      owner_id: ownerId,
      name: input.name.trim() || 'Proyek baru',
      description: (input.description ?? '').trim(),
      sandbox_id: null,
      preview_port: null,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO ac_projects (id, owner_id, name, description, sandbox_id, preview_port, created_at, updated_at)
         VALUES (@id, @owner_id, @name, @description, @sandbox_id, @preview_port, @created_at, @updated_at)`,
      )
      .run(project);
    return project;
  }

  async updateProject(ownerId: string, id: string, patch: ProjectPatch): Promise<Project | null> {
    const current = await this.getProject(ownerId, id);
    if (!current) return null;
    const next: Project = { ...current, ...patch, owner_id: ownerId, updated_at: new Date().toISOString() };
    this.db
      .prepare(
        `UPDATE ac_projects SET name = @name, description = @description, sandbox_id = @sandbox_id,
           preview_port = @preview_port, updated_at = @updated_at
         WHERE id = @id AND owner_id = @owner_id`,
      )
      .run(next);
    return next;
  }

  async deleteProject(ownerId: string, id: string): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM ac_messages WHERE project_id = ? AND owner_id = ?').run(id, ownerId);
      this.db.prepare('DELETE FROM ac_projects WHERE id = ? AND owner_id = ?').run(id, ownerId);
    })();
  }

  async listMessages(ownerId: string, projectId: string, limit = 200): Promise<Message[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM ac_messages WHERE project_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT ?
         ) ORDER BY created_at ASC`,
      )
      .all(projectId, ownerId, limit) as Row[];
    return rows.map(rowToMessage);
  }

  async addMessage(input: NewMessage): Promise<Message> {
    const message: Message = {
      id: randomUUID(),
      project_id: input.project_id,
      owner_id: input.owner_id,
      role: input.role,
      content: input.content ?? '',
      parts: input.parts ?? null,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO ac_messages (id, project_id, owner_id, role, content, parts, created_at)
         VALUES (@id, @project_id, @owner_id, @role, @content, @parts, @created_at)`,
      )
      .run({ ...message, parts: message.parts ? JSON.stringify(message.parts) : null });
    this.db.prepare('UPDATE ac_projects SET updated_at = ? WHERE id = ?').run(message.created_at, input.project_id);
    return message;
  }

  async clearMessages(ownerId: string, projectId: string): Promise<void> {
    this.db.prepare('DELETE FROM ac_messages WHERE project_id = ? AND owner_id = ?').run(projectId, ownerId);
  }
}

function rowToSettings(row: Row): Settings {
  return {
    owner_id: String(row.owner_id),
    openrouter_api_key: String(row.openrouter_api_key ?? ''),
    model: String(row.model ?? ''),
    updated_at: String(row.updated_at),
  };
}

function rowToProject(row: Row): Project {
  return {
    id: String(row.id),
    owner_id: String(row.owner_id),
    name: String(row.name ?? ''),
    description: String(row.description ?? ''),
    sandbox_id: row.sandbox_id ? String(row.sandbox_id) : null,
    preview_port: row.preview_port == null ? null : Number(row.preview_port),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function rowToMessage(row: Row): Message {
  let parts: Message['parts'] = null;
  if (typeof row.parts === 'string' && row.parts) {
    try {
      parts = JSON.parse(row.parts);
    } catch {
      parts = null;
    }
  } else if (row.parts && typeof row.parts === 'object') {
    parts = row.parts as Message['parts'];
  }
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    owner_id: String(row.owner_id),
    role: String(row.role) as Message['role'],
    content: String(row.content ?? ''),
    parts,
    created_at: String(row.created_at),
  };
}

/** Singleton per proses (dipakai bersama semua route handler). */
const globalForDb = globalThis as unknown as { __acSqlite?: SqliteStore };

export function getSqliteStore(): SqliteStore {
  if (!globalForDb.__acSqlite) {
    globalForDb.__acSqlite = new SqliteStore();
  }
  return globalForDb.__acSqlite;
}
