export type Role = 'user' | 'assistant' | 'system';

export type TextBlock = { type: 'text'; text: string };
export type ReasoningBlock = { type: 'reasoning'; text: string };
export type NoticeBlock = { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string };
/** Pemakaian token & perkiraan biaya satu giliran (agar pemakaian terlihat). */
export type UsageBlock = {
  type: 'usage';
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  costUsd?: number;
};
export type ToolBlock = {
  type: 'tool';
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'ok' | 'error';
  output?: string;
  previewUrl?: string;
};

/** Blok terurut - disimpan di kolom `parts` supaya UI bisa merender ulang chat lama. */
export type Block = TextBlock | ReasoningBlock | NoticeBlock | UsageBlock | ToolBlock;

export type Project = {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  sandbox_id: string | null;
  preview_port: number | null;
  created_at: string;
  updated_at: string;
};

export type Message = {
  id: string;
  project_id: string;
  owner_id: string;
  role: Role;
  content: string;
  parts: Block[] | null;
  created_at: string;
};

export type Settings = {
  owner_id: string;
  openrouter_api_key: string;
  model: string;
  updated_at: string;
};

/**
 * Satu file proyek yang disimpan di database.
 *
 * Alasan keberadaannya: isi sandbox E2B bisa hilang (dihapus, di-kill, proyek
 * dibuat ulang). Dengan menyimpan file di database, proyek bisa DIPULIHKAN ke
 * sandbox mana pun sehingga pekerjaan user tidak hilang dan tidak perlu
 * dibangun ulang dari nol (yang membakar token).
 */
export type ProjectFile = {
  project_id: string;
  owner_id: string;
  path: string;
  content: string;
  size: number;
  /** Waktu modifikasi di sandbox (epoch detik) - dipakai mendeteksi perubahan. */
  mtime: number;
  updated_at: string;
};

/** Metadata file tanpa isi, untuk mendeteksi file mana yang perlu dikirim. */
export type FileMeta = { path: string; size: number; mtime: number };

export type FileUpsert = { path: string; content: string; size: number; mtime: number };

export type NewProject = { name: string; description?: string };
export type NewMessage = {
  project_id: string;
  owner_id: string;
  role: Role;
  content: string;
  parts?: Block[] | null;
};

export type ProjectPatch = Partial<Pick<Project, 'name' | 'description' | 'sandbox_id' | 'preview_port'>>;
export type SettingsPatch = Partial<Pick<Settings, 'openrouter_api_key' | 'model'>>;

export interface Store {
  getSettings(ownerId: string): Promise<Settings | null>;
  saveSettings(ownerId: string, patch: SettingsPatch): Promise<Settings>;
  listProjects(ownerId: string): Promise<Project[]>;
  getProject(ownerId: string, id: string): Promise<Project | null>;
  createProject(ownerId: string, input: NewProject): Promise<Project>;
  updateProject(ownerId: string, id: string, patch: ProjectPatch): Promise<Project | null>;
  deleteProject(ownerId: string, id: string): Promise<void>;
  listMessages(ownerId: string, projectId: string, limit?: number): Promise<Message[]>;
  addMessage(input: NewMessage): Promise<Message>;
  clearMessages(ownerId: string, projectId: string): Promise<void>;
  /** Metadata semua file proyek (tanpa isi) - untuk mendeteksi perubahan. */
  listFileMeta(ownerId: string, projectId: string): Promise<FileMeta[]>;
  /** Seluruh file proyek BESERTA isinya - dipakai saat memulihkan ke sandbox. */
  listFiles(ownerId: string, projectId: string): Promise<ProjectFile[]>;
  /** Simpan/perbarui file (upsert per path). Mengembalikan jumlah file tersimpan. */
  upsertFiles(ownerId: string, projectId: string, files: FileUpsert[]): Promise<number>;
  /** Hapus file yang sudah tidak ada lagi di sandbox. */
  deleteFiles(ownerId: string, projectId: string, paths: string[]): Promise<number>;
  countFiles(ownerId: string, projectId: string): Promise<number>;
  ping(): Promise<void>;
}
