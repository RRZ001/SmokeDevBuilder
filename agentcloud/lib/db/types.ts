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
  ping(): Promise<void>;
}
