/**
 * Satu tempat untuk membaca konfigurasi dari environment.
 * Semua nilai sensitif HANYA dibaca di server (route handler / lib server).
 */

export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

/**
 * Hosting serverless (Vercel, AWS Lambda, dsb): tidak punya disk yang
 * persisten, sehingga SQLite hanya bisa dipakai sebagai penyimpanan sementara
 * di /tmp. Untuk data permanen di lingkungan seperti ini WAJIB pakai Supabase.
 */
export const IS_VERCEL = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
export const IS_SERVERLESS = IS_VERCEL || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
/** true = data lokal tidak akan bertahan antar-request (hanya di memori /tmp). */
export const EPHEMERAL_STORAGE = IS_SERVERLESS;
/** Lokasi default file SQLite: /tmp di serverless, ./data di server biasa. */
export const DEFAULT_SQLITE_PATH = IS_SERVERLESS
  ? '/tmp/agentcloud.sqlite'
  : 'data/agentcloud.sqlite';

export const OPENROUTER_API_KEY_ENV = (process.env.OPENROUTER_API_KEY || '').trim();
export const OPENROUTER_SITE_URL = (process.env.OPENROUTER_SITE_URL || '').trim();
export const OPENROUTER_APP_NAME = (process.env.OPENROUTER_APP_NAME || 'AgentCloud').trim();

export const E2B_API_KEY_ENV = (process.env.E2B_API_KEY || '').trim();
export const E2B_SANDBOX_TIMEOUT_MS = clampInt(process.env.E2B_SANDBOX_TIMEOUT_MS, 60_000, 86_400_000, 600_000);

/**
 * Normalisasi nilai SUPABASE_URL.
 *
 * Cara orang menempelkan nilai ke panel Environment Variables sering tidak persis,
 * dan supabase-js menolak semuanya dengan pesan yang sama ("Invalid supabaseUrl").
 * Bentuk yang lazim dan ditangani di sini:
 *   "https://abc.supabase.co"                  -> tanda kutip ikut ter-copy
 *   SUPABASE_URL=https://abc.supabase.co       -> baris .env ter-paste utuh
 *   abcdefghijklmnopqrst                       -> hanya Project Reference ID
 *   abc.supabase.co                            -> skema https:// lupa diikutkan
 *   https://abc.supabase.co/                   -> garis miring di akhir
 */
export function normalizeSupabaseUrl(raw: string): string {
  let value = (raw || '').trim();
  if (!value) return '';

  // Baris .env ter-paste utuh (mis. "SUPABASE_URL=https://...") atau beberapa baris.
  const looksLikeEnvLine = /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(value);
  if (/[\r\n]/.test(value) || looksLikeEnvLine) {
    const lines = value.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
    const candidate =
      lines.find((line) => /^supabase_url\s*=/i.test(line)) ??
      lines.find((line) => /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) ??
      lines[0];
    value = candidate.includes('=') ? candidate.slice(candidate.indexOf('=') + 1).trim() : candidate;
  }

  value = value.replace(/^['"`]+|['"`]+$/g, '').trim(); // buang tanda kutip
  value = value.replace(/\s+/g, '');                    // URL tidak boleh mengandung spasi
  if (!value) return '';

  if (!/^https?:\/\//i.test(value)) {
    // Tanpa skema: kalau bentuknya persis project reference Supabase
    // (20 karakter huruf kecil/angka, mis. "abcdefghijklmnopqrst") lengkapi
    // menjadi <ref>.supabase.co. Selain itu cukup tambahkan https:// dan
    // biarkan validasi di bawah yang menilai (salah bentuk = dilaporkan jelas).
    value = /^[a-z0-9]{20}$/.test(value) ? `https://${value}.supabase.co` : `https://${value}`;
  }

  // Ambil ORIGIN saja. supabase-js menambahkan sendiri "/rest/v1" dan "/auth/v1",
  // jadi kalau nilai dari dashboard mengandung path (mis. ".../rest/v1") requestnya
  // menjadi ".../rest/v1/rest/v1/..." dan PostgREST menjawab
  // "Invalid path specified in request URL". Query & garis miring juga dibuang di sini.
  try {
    const url = new URL(value);
    if (!url.hostname.includes('.')) return '';
    return url.origin;
  } catch {
    return '';
  }
}

/** Service role / anon key juga sering ter-copy bersama kutip atau spasi. */
function normalizeKey(raw: string): string {
  return (raw || '').trim().replace(/^['"`]+|['"`]+$/g, '').replace(/\s+/g, '');
}

const RAW_SUPABASE_URL = (
  process.env.SUPABASE_URL ||
  // Alias yang dipakai integrasi Supabase di Vercel (Supabase Integration).
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  ''
).trim();

export const SUPABASE_URL = normalizeSupabaseUrl(RAW_SUPABASE_URL);
/** true = SUPABASE_URL diisi tapi formatnya tidak bisa dipakai (ditampilkan di UI/health). */
export const SUPABASE_URL_INVALID = Boolean(RAW_SUPABASE_URL) && !SUPABASE_URL;
export const SUPABASE_KEY = normalizeKey(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '');
export const SUPABASE_USES_SERVICE_ROLE = Boolean(normalizeKey(process.env.SUPABASE_SERVICE_ROLE_KEY || ''));

export const DB_PATH = process.env.AGENTCLOUD_DB_PATH || '';

/** Folder kerja proyek di dalam sandbox. */
export const SANDBOX_PROJECT_DIR = (process.env.SANDBOX_PROJECT_DIR || '/home/user/project').trim();
/** Port default dev server (harus sama dengan port yang dipakai agent). */
export const DEFAULT_PREVIEW_PORT = clampInt(process.env.DEFAULT_PREVIEW_PORT, 1024, 65535, 3000);

export const MAX_AGENT_STEPS = clampInt(process.env.AGENT_MAX_STEPS, 1, 40, 12);
export const MAX_AUTO_DEBUG_ROUNDS = clampInt(process.env.AGENT_MAX_AUTO_DEBUG, 0, 10, 2);

/**
 * Kendali biaya (token OpenRouter):
 *  - MAX_OUTPUT_TOKENS: batas token keluaran per langkah (mencegah model
 *    "ngobrol panjang" yang dibayar mahal). Default 8192 cukup untuk menulis
 *    satu file besar sekaligus.
 *  - HISTORY_TOOL_DETAILS: hanya N pemanggilan tool TERAKHIR yang isinya dikirim
 *    utuh ke model; yang lebih lama diringkas (isi file diganti penanda ukuran).
 *    Ini penekan biaya terbesar: argumen `write_file` memuat isi file lengkap dan
 *    tanpa kompaksi akan terkirim ulang di setiap langkah.
 *  - HISTORY_CHAR_BUDGET: batas keras ukuran prompt; bila terlampaui, kompaksi
 *    diperketat otomatis.
 *  - TOOL_OUTPUT_CHARS: batas panjang hasil tool yang dikirim balik ke model.
 *  - HISTORY_MESSAGES: batas jumlah pesan yang ikut dibangun.
 */
export const MAX_OUTPUT_TOKENS = clampInt(process.env.AGENT_MAX_OUTPUT_TOKENS, 256, 64_000, 8192);
export const HISTORY_TOOL_DETAILS = clampInt(process.env.AGENT_HISTORY_TOOL_DETAILS, 0, 50, 4);
export const HISTORY_CHAR_BUDGET = clampInt(process.env.AGENT_HISTORY_CHAR_BUDGET, 8_000, 400_000, 60_000);
export const HISTORY_MESSAGES = clampInt(process.env.AGENT_HISTORY_MESSAGES, 4, 100, 24);
export const TOOL_OUTPUT_CHARS = clampInt(process.env.AGENT_TOOL_OUTPUT_CHARS, 400, 40_000, 4_000);
export const HISTORY_TOOL_OUTPUT_CHARS = clampInt(process.env.AGENT_HISTORY_TOOL_OUTPUT_CHARS, 100, 8_000, 600);

/**
 * Base URL OpenRouter. Bisa di-override lewat env untuk memakai proxy/gateway
 * sendiri atau untuk pengujian (mis. mock server).
 */
export const OPENROUTER_BASE_URL = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');

export function capabilities(activeStorage?: 'supabase' | 'sqlite') {
  const active = activeStorage ?? (SUPABASE_URL && SUPABASE_KEY ? 'supabase' : 'sqlite');
  return {
    openrouterFromEnv: Boolean(OPENROUTER_API_KEY_ENV),
    e2bFromEnv: Boolean(E2B_API_KEY_ENV),
    supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_KEY),
    supabaseRole: SUPABASE_USES_SERVICE_ROLE ? 'service_role' : SUPABASE_KEY ? 'anon' : 'none',
    /** true = SUPABASE_URL diisi tapi formatnya tidak bisa dipakai (tampil di UI). */
    supabaseUrlInvalid: SUPABASE_URL_INVALID,
    sandboxDir: SANDBOX_PROJECT_DIR,
    defaultPreviewPort: DEFAULT_PREVIEW_PORT,
    /** Serverless (mis. Vercel): tanpa Supabase yang benar-benar aktif, data tidak persisten. */
    serverless: IS_SERVERLESS,
    storageEphemeral: EPHEMERAL_STORAGE && active !== 'supabase',
  };
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
