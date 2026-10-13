/**
 * Logika MURNI untuk deploy ke Vercel (tanpa I/O) — diuji di
 * tests/vercel-deploy.mts tanpa kredit E2B maupun panggilan jaringan.
 *
 * Kenapa deploy dijalankan dari DALAM sandbox: file proyek ada di sana, dan CLI
 * Vercel butuh seluruh foldernya untuk diunggah. Yang penting untuk keamanan:
 * token dikirim lewat `envs` perintah (bukan argumen `--token`, yang akan terlihat
 * di daftar argumen proses), dan SEMUA keluaran disaring `redactSecrets()` sebelum
 * dikirim ke UI maupun model — token user tidak boleh bocor ke mana pun.
 *
 * Deploy dijalankan sebagai proses LATAR di dalam sandbox dengan keluaran ke file
 * log, lalu statusnya dibaca dengan polling. Alasannya: deploy bisa lebih lama
 * daripada batas durasi fungsi hosting, dan proses latar tidak ikut mati saat
 * request berakhir.
 */

export type DeployState = 'running' | 'done' | 'failed';

export type DeployStatus = {
  state: DeployState;
  /** URL permanen hasil deploy (alias produksi bila bisa ditentukan). */
  url: string | null;
  /** Semua URL .vercel.app yang terlihat di log (untuk diagnosa). */
  urls: string[];
  /** Pesan error ringkas bila gagal. */
  error: string | null;
};

/** Path file log deploy di dalam sandbox (dipakai untuk polling). */
export const DEPLOY_LOG_PATH = '/home/user/.agentcloud-deploy.log';
/** Penanda CLI Vercel sudah tersedia di sandbox. */
export const VERCEL_MARKER = '/home/user/.agentcloud-vercel-ready';
/** Batas waktu satu deploy (unggah + build di sisi Vercel). */
export const DEPLOY_TIMEOUT_MS = 240_000;
/** Jeda antar pemeriksaan log. */
export const DEPLOY_POLL_MS = 3_000;

/** Nama proyek Vercel yang sah: huruf kecil, angka, dan tanda hubung. */
export function toVercelProjectName(raw: string): string {
  const cleaned = (raw || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52)
    .replace(/-+$/, '');
  return cleaned || 'agentcloud-app';
}

/** Alias produksi yang dipakai Vercel untuk sebuah nama proyek. */
export function productionAlias(projectName: string): string {
  return `https://${toVercelProjectName(projectName)}.vercel.app`;
}

/**
 * Perintah CLI yang dijalankan di sandbox.
 *
 * `--yes` = non-interaktif (project Vercel dibuat/dipakai otomatis). Deploy
 * berikutnya ke folder yang sama memakai project yang sama karena CLI menyimpan
 * penautan di `.vercel/`.
 */
export function buildDeployCommand(options: { projectName?: string; prod?: boolean; scope?: string } = {}): string {
  const parts = ['npx', '--yes', 'vercel@latest', 'deploy', '--yes'];
  if (options.prod !== false) parts.push('--prod');
  const name = options.projectName ? toVercelProjectName(options.projectName) : '';
  if (name) parts.push('--name', name);
  const scope = (options.scope || '').trim();
  if (scope) parts.push('--scope', scope);
  return parts.join(' ');
}

/** Perintah yang dijalankan di background: keluaran dialihkan ke file log. */
export function deployShellCommand(command: string, logPath: string = DEPLOY_LOG_PATH): string {
  return `${command} > ${logPath} 2>&1`;
}

/** Perintah untuk memastikan CLI Vercel tersedia (sekali per sandbox). */
export function vercelInstallCommand(): string {
  return `npx --yes vercel@latest --version`;
}

/**
 * Buang token dari teks apa pun sebelum ditampilkan/dikirim ke model.
 * Selain nilai token yang diketahui, pola `--token=...` / `VERCEL_TOKEN=...` juga
 * dimasking sebagai jaring pengaman.
 */
export function redactSecrets(text: string, token?: string | null): string {
  let out = text ?? '';
  const secret = (token ?? '').trim();
  if (secret.length >= 6) out = out.split(secret).join('••••••');
  out = out.replace(/(--token[= ])\S+/gi, '$1••••••');
  out = out.replace(/(VERCEL_TOKEN=)\S+/gi, '$1••••••');
  return out;
}

const URL_RE = /https:\/\/[a-z0-9][a-z0-9.-]*\.vercel\.app\b/gi;

/** Ambil semua URL .vercel.app dari keluaran CLI. */
export function extractDeployUrls(text: string): string[] {
  const found = (text || '').match(URL_RE) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,)]+$/, '')))];
}

/**
 * Pilih URL yang paling berguna untuk user.
 *
 * CLI mencetak URL deployment (yang mengandung hash, berubah tiap deploy).
 * Karena kita TAHU nama proyeknya, alias produksinya bisa ditentukan dengan pasti
 * (`https://<nama>.vercel.app`) dan itu yang ditampilkan — link ini stabil dan
 * bertahan walaupun sandbox dihapus.
 */
export function pickPrimaryUrl(urls: string[], projectName?: string): string | null {
  if (!urls.length && !projectName) return null;
  const slug = projectName ? toVercelProjectName(projectName) : '';
  if (slug) {
    const alias = productionAlias(slug);
    if (urls.includes(alias)) return alias;
    const hashUrl = urls.find((u) => u.startsWith(`https://${slug}-`) && u.endsWith('.vercel.app'));
    if (hashUrl) return alias;
  }
  return urls[0] ?? null;
}

/** Baris error khas CLI Vercel. */
const ERROR_PATTERNS: RegExp[] = [
  /Error:/i,
  /Invalid token/i,
  /not authorized/i,
  /The specified token is not valid/i,
  /No more than .* deployments/i,
  /Command failed/i,
  /npm ERR!/i,
  /ENOENT/i,
];

/**
 * Nilai status deploy dari isi log.
 *
 * PENTING: CLI menulis "Inspect: https://vercel.com/..." sementara proses masih
 * berjalan, jadi keberadaan URL saja BUKAN tanda selesai. Tanda selesai adalah
 * baris hasil ("Production: https://…", "Preview: https://…") atau tanda centang.
 */
export function parseDeployStatus(
  log: string,
  options: { token?: string | null; projectName?: string } = {},
): DeployStatus {
  const text = redactSecrets(log || '', options.token);
  const urls = extractDeployUrls(text);
  if (!text.trim()) return { state: 'running', url: null, urls: [], error: null };

  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const tail = lines.slice(-14).join('\n');

  const resultLine = lines.find((line) => /^(Production|Preview):\s*https:\/\//i.test(line));
  const succeeded = Boolean(resultLine) || /✅/.test(tail) || /Deployed to production/i.test(tail);

  if (succeeded) {
    const fromResult = resultLine ? extractDeployUrls(resultLine) : [];
    const chosen = pickPrimaryUrl(fromResult.length ? fromResult : urls, options.projectName);
    return { state: 'done', url: chosen, urls, error: null };
  }

  if (ERROR_PATTERNS.some((re) => re.test(tail))) {
    const errorLine = [...lines].reverse().find((line) => ERROR_PATTERNS.some((re) => re.test(line))) ?? lines[lines.length - 1];
    return { state: 'failed', url: null, urls, error: String(errorLine).slice(0, 400) };
  }

  return { state: 'running', url: null, urls, error: null };
}

/** Pesan ramah untuk kondisi kegagalan yang umum. */
export function explainDeployError(raw: string | null): string {
  const text = (raw || '').trim();
  if (!text) return 'Deploy gagal tanpa pesan yang jelas. Coba lagi atau periksa dashboard Vercel.';
  if (/invalid token|not valid|not authorized|forbidden|401/i.test(text)) {
    return 'Token Vercel tidak valid atau sudah dicabut. Buat token baru di vercel.com/account/tokens, lalu simpan lagi di Settings.';
  }
  if (/ENOENT|command not found/i.test(text)) {
    return 'Perintah Vercel tidak bisa dijalankan di sandbox (CLI belum siap). Coba deploy lagi.';
  }
  if (/No more than|deployments per day|rate limit/i.test(text)) {
    return 'Kuota deploy Vercel harian habis. Coba lagi besok atau tingkatkan plan Vercel.';
  }
  return text;
}
