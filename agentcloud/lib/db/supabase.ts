import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { SUPABASE_KEY, SUPABASE_URL } from '@/lib/config';
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

export const TABLES = {
  settings: 'ac_settings',
  projects: 'ac_projects',
  messages: 'ac_messages',
} as const;

type Row = Record<string, unknown>;

let client: SupabaseClient | null = null;

/**
 * Klien Supabase dibuat secara lazy (dynamic import) supaya:
 *  - aplikasi tetap ringan & tanpa warning saat Supabase belum dipakai,
 *  - kegagalan konfigurasi Supabase tidak pernah menghalangi startup.
 */
export async function getSupabaseClient(): Promise<SupabaseClient | null> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  if (!client) {
    const { createClient } = await import('@supabase/supabase-js');
    client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'x-application-name': 'agentcloud' } },
    });
  }
  return client;
}

/** Driver utama: Supabase Postgres (skema: supabase/schema.sql). */
export class SupabaseStore implements Store {
  constructor(private readonly db: SupabaseClient) {}

  private async run<T>(label: string, fn: () => Promise<{ data: T | null; error: unknown }>): Promise<T> {
    const { data, error } = await fn();
    if (error) {
      const message = typeof error === 'object' && error && 'message' in error ? String((error as Error).message) : String(error);
      throw new Error(`[supabase:${label}] ${message}`);
    }
    return (data ?? null) as T;
  }

  async ping(): Promise<void> {
    await this.run('ping', async () => {
      const res = await this.db.from(TABLES.settings).select('owner_id').limit(1);
      return { data: res.data as unknown, error: res.error };
    });
  }

  async getSettings(ownerId: string): Promise<Settings | null> {
    const rows = await this.run<Row[]>('getSettings', async () => {
      const res = await this.db.from(TABLES.settings).select('*').eq('owner_id', ownerId).limit(1);
      return { data: res.data as Row[] | null, error: res.error };
    });
    return rows && rows[0] ? rowToSettings(rows[0]) : null;
  }

  async saveSettings(ownerId: string, patch: SettingsPatch): Promise<Settings> {
    const current = await this.getSettings(ownerId);
    const next: Settings = {
      owner_id: ownerId,
      openrouter_api_key: patch.openrouter_api_key ?? current?.openrouter_api_key ?? '',
      model: patch.model ?? current?.model ?? '',
      updated_at: new Date().toISOString(),
    };
    await this.run('saveSettings', async () => {
      const res = await this.db.from(TABLES.settings).upsert(next, { onConflict: 'owner_id' }).select('*').limit(1);
      return { data: res.data as Row[] | null, error: res.error };
    });
    return next;
  }

  async listProjects(ownerId: string): Promise<Project[]> {
    const rows = await this.run<Row[]>('listProjects', async () => {
      const res = await this.db
        .from(TABLES.projects)
        .select('*')
        .eq('owner_id', ownerId)
        .order('updated_at', { ascending: false });
      return { data: res.data as Row[] | null, error: res.error };
    });
    return (rows ?? []).map(rowToProject);
  }

  async getProject(ownerId: string, id: string): Promise<Project | null> {
    const rows = await this.run<Row[]>('getProject', async () => {
      const res = await this.db.from(TABLES.projects).select('*').eq('id', id).eq('owner_id', ownerId).limit(1);
      return { data: res.data as Row[] | null, error: res.error };
    });
    return rows && rows[0] ? rowToProject(rows[0]) : null;
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
    const rows = await this.run<Row[]>('createProject', async () => {
      const res = await this.db.from(TABLES.projects).insert(project).select('*').limit(1);
      return { data: res.data as Row[] | null, error: res.error };
    });
    return rows && rows[0] ? rowToProject(rows[0]) : project;
  }

  async updateProject(ownerId: string, id: string, patch: ProjectPatch): Promise<Project | null> {
    const current = await this.getProject(ownerId, id);
    if (!current) return null;
    const next: Project = { ...current, ...patch, owner_id: ownerId, updated_at: new Date().toISOString() };
    const rows = await this.run<Row[]>('updateProject', async () => {
      const res = await this.db
        .from(TABLES.projects)
        .update({
          name: next.name,
          description: next.description,
          sandbox_id: next.sandbox_id,
          preview_port: next.preview_port,
          updated_at: next.updated_at,
        })
        .eq('id', id)
        .eq('owner_id', ownerId)
        .select('*')
        .limit(1);
      return { data: res.data as Row[] | null, error: res.error };
    });
    return rows && rows[0] ? rowToProject(rows[0]) : next;
  }

  async deleteProject(ownerId: string, id: string): Promise<void> {
    await this.run('deleteProject.messages', async () => {
      const res = await this.db.from(TABLES.messages).delete().eq('project_id', id).eq('owner_id', ownerId);
      return { data: null, error: res.error };
    });
    await this.run('deleteProject', async () => {
      const res = await this.db.from(TABLES.projects).delete().eq('id', id).eq('owner_id', ownerId);
      return { data: null, error: res.error };
    });
  }

  async listMessages(ownerId: string, projectId: string, limit = 200): Promise<Message[]> {
    const rows = await this.run<Row[]>('listMessages', async () => {
      const res = await this.db
        .from(TABLES.messages)
        .select('*')
        .eq('owner_id', ownerId)
        .eq('project_id', projectId)
        .order('created_at', { ascending: true })
        .limit(limit);
      return { data: res.data as Row[] | null, error: res.error };
    });
    return (rows ?? []).map(rowToMessage);
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
    const rows = await this.run<Row[]>('addMessage', async () => {
      const res = await this.db.from(TABLES.messages).insert(message).select('*').limit(1);
      return { data: res.data as Row[] | null, error: res.error };
    });
    await this.run('addMessage.touchProject', async () => {
      const res = await this.db
        .from(TABLES.projects)
        .update({ updated_at: message.created_at })
        .eq('id', input.project_id)
        .eq('owner_id', input.owner_id);
      return { data: null, error: res.error };
    });
    return rows && rows[0] ? rowToMessage(rows[0]) : message;
  }

  async clearMessages(ownerId: string, projectId: string): Promise<void> {
    await this.run('clearMessages', async () => {
      const res = await this.db.from(TABLES.messages).delete().eq('project_id', projectId).eq('owner_id', ownerId);
      return { data: null, error: res.error };
    });
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
  const parts = Array.isArray(row.parts) ? (row.parts as Message['parts']) : null;
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
