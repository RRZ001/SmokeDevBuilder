/**
 * Deteksi apakah model yang dipakai bisa "melihat" gambar.
 *
 * Relevansinya: hasil `browser_check` mengirim screenshot ke model. Kalau model
 * yang aktif TEXT-ONLY (mis. DeepSeek V3/V4 chat, DeepSeek R1), mengirim gambar
 * akan ditolak provider — atau lebih buruk, diam-diam diabaikan sehingga agent
 * mengira dirinya sudah melihat halaman padahal tidak. Karena itu screenshot
 * hanya dikirim kalau kemampuannya benar-benar diketahui.
 *
 * Urutan penentuan:
 *  1. Override eksplisit dari env (untuk pengujian / gateway lain).
 *  2. Heuristik pola id model (instan, tanpa jaringan) — cukup untuk model yang
 *     sudah dikenal; hasilnya bisa `true`, `false`, atau `unknown`.
 *  3. Kalau `unknown`: tanya OpenRouter `/models` (publik, tanpa API key) dan
 *     pakai `architecture.input_modalities`. Hasilnya di-cache 10 menit.
 *     Kegagalan jaringan TIDAK fatal — dianggap belum diketahui → gambar tidak
 *     dikirim, dan agent diberi tahu supaya mengandalkan hasil teks.
 */

const TTL_MS = 10 * 60 * 1000;

type ModalityCache = { at: number; vision: Set<string> };
const globalForVision = globalThis as unknown as { __acVision?: ModalityCache };

/** Pola pasti mendukung gambar (berdasarkan keluarga model). */
const VISION_PATTERNS = [
  /^anthropic\/claude-(3|opus|sonnet|haiku|fable)/,
  /^openai\/gpt-(4|5)/,
  /^openai\/o[34]/,
  /^google\/(gemini|gemma-3)/,
  /^z-ai\/glm-.*(v|flash|vision)/,
  /^moonshotai\/kimi-(k3|k2\.5|vision|latest)/,
  /^qwen\/.*(vl|omni)/,
  /^mistralai\/(pixtral|mistral-(large|medium|small)|magistral)/,
  /^x-ai\/grok/,
  /^meta-llama\/llama-4/,
  /^xiaomi\/mimo-v2\.(5|6)-pro/,
  /^minimax\/minimax-m[23]/,
  /-vision/,
  /vision-/,
];

/** Pola pasti TEXT-ONLY (sengaja didaftarkan agar tidak salah kirim gambar). */
const TEXT_ONLY_PATTERNS = [
  /^deepseek\/deepseek-(chat|r1|coder)/,
  /^deepseek\/deepseek-v[34](-|$)/,
  /^deepseek\/deepseek-v[34]\.\d+(-(pro|mod|flash))?$/,
  /^z-ai\/glm-4\.5(-air)?$/,
  /^moonshotai\/kimi-k2(\.\d+)?(-|$)/,
  /coder/,
  /-instruct$/,
];

export type VisionSupport = 'yes' | 'no' | 'unknown';

/** Heuristik lokal: tanpa jaringan, deterministik, mudah diuji. */
export function visionByPattern(model: string): VisionSupport {
  const id = (model || '').toLowerCase().trim();
  if (!id) return 'unknown';
  if (TEXT_ONLY_PATTERNS.some((re) => re.test(id))) return 'no';
  if (VISION_PATTERNS.some((re) => re.test(id))) return 'yes';
  return 'unknown';
}

/** Override pengujian/gateway: daftar model yang mendukung gambar, dipisah koma. */
function envOverride(): { yes: Set<string>; no: Set<string> } | null {
  const raw = (process.env.VISION_MODELS || '').trim();
  if (!raw) return null;
  const yes = new Set<string>();
  const no = new Set<string>();
  for (const token of raw.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)) {
    if (token.startsWith('!')) no.add(token.slice(1));
    else yes.add(token);
  }
  return { yes, no };
}

async function liveVisionModels(): Promise<Set<string> | null> {
  const cached = globalForVision.__acVision;
  if (cached && Date.now() - cached.at < TTL_MS) return cached.vision;
  try {
    const base = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    const res = await fetch(`${base}/models`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: Array<{ id?: string; architecture?: { input_modalities?: string[] } }>;
    };
    const vision = new Set<string>();
    for (const model of json.data ?? []) {
      const modalities = model.architecture?.input_modalities;
      if (model.id && Array.isArray(modalities) && modalities.includes('image')) vision.add(model.id.toLowerCase());
    }
    globalForVision.__acVision = { at: Date.now(), vision };
    return vision;
  } catch {
    return null;
  }
}

/**
 * Apakah model ini bisa menerima gambar? `false` = jangan kirim gambar.
 * Selalu aman: kegagalan jaringan menghasilkan `false` (agent tetap dapat
 * diagnostik teks dari browser_check).
 */
export async function supportsVision(model: string): Promise<boolean> {
  const id = (model || '').toLowerCase().trim();
  if (!id) return false;

  const override = envOverride();
  if (override) {
    if (override.no.has(id)) return false;
    if (override.yes.has(id)) return true;
  }

  const pattern = visionByPattern(id);
  if (pattern === 'yes') return true;
  if (pattern === 'no') return false;

  const live = await liveVisionModels();
  if (live) return live.has(id);
  return false;
}
