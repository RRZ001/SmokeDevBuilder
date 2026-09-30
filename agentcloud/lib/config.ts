/**
 * Satu tempat untuk membaca konfigurasi dari environment.
 * Semua nilai sensitif HANYA dibaca di server (route handler / lib server).
 */

export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

export const OPENROUTER_API_KEY_ENV = (process.env.OPENROUTER_API_KEY || '').trim();
export const OPENROUTER_SITE_URL = (process.env.OPENROUTER_SITE_URL || '').trim();
export const OPENROUTER_APP_NAME = (process.env.OPENROUTER_APP_NAME || 'AgentCloud').trim();

export const E2B_API_KEY_ENV = (process.env.E2B_API_KEY || '').trim();
export const E2B_SANDBOX_TIMEOUT_MS = clampInt(process.env.E2B_SANDBOX_TIMEOUT_MS, 60_000, 86_400_000, 600_000);

export const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
export const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
export const SUPABASE_USES_SERVICE_ROLE = Boolean((process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim());

export const DB_PATH = process.env.AGENTCLOUD_DB_PATH || '';

/** Folder kerja proyek di dalam sandbox. */
export const SANDBOX_PROJECT_DIR = (process.env.SANDBOX_PROJECT_DIR || '/home/user/project').trim();
/** Port default dev server (harus sama dengan port yang dipakai agent). */
export const DEFAULT_PREVIEW_PORT = clampInt(process.env.DEFAULT_PREVIEW_PORT, 1024, 65535, 3000);

export const MAX_AGENT_STEPS = clampInt(process.env.AGENT_MAX_STEPS, 1, 40, 12);
export const MAX_AUTO_DEBUG_ROUNDS = clampInt(process.env.AGENT_MAX_AUTO_DEBUG, 0, 10, 2);

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export function capabilities() {
  return {
    openrouterFromEnv: Boolean(OPENROUTER_API_KEY_ENV),
    e2bFromEnv: Boolean(E2B_API_KEY_ENV),
    supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_KEY),
    supabaseRole: SUPABASE_USES_SERVICE_ROLE ? 'service_role' : SUPABASE_KEY ? 'anon' : 'none',
    sandboxDir: SANDBOX_PROJECT_DIR,
    defaultPreviewPort: DEFAULT_PREVIEW_PORT,
  };
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
