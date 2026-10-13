/**
 * Diagnosa halaman/keluaran dev server.
 *
 * Kenapa ada: dev server bisa MENJAWAB (HTTP 200/500) sambil menampilkan halaman
 * error kompilasi, bukan aplikasi user. Insiden nyata (Okt 2026, proyek "Sistem
 * kasir"): `next dev` menjawab 500 dengan halaman "Failed to compile — Module not
 * found: Can't resolve 'class-variance-authority'", tetapi kesiapan preview dinilai
 * hanya dari "ada status HTTP" → agent melaporkan "Preview sudah bisa dibuka dan
 * landing page terlihat profesional", sementara user melihat layar error.
 *
 * Modul ini MURNI (tanpa I/O) supaya bisa diuji tanpa kredit E2B, dan tugasnya:
 * mengenali halaman/keluaran error itu, menyebut paket yang hilang, lalu
 * menyusun perintah perbaikan yang bisa langsung dijalankan agent.
 */

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export type PreviewIssue = {
  /** 'missing-package' = ada modul/paket yang belum terpasang. */
  kind: 'missing-package' | 'compile';
  /** Judul singkat untuk UI. */
  title: string;
  /** Potongan pesan error asli (untuk user & model). */
  detail: string;
  /** Paket yang tidak ditemukan (kosong kalau bukan masalah paket). */
  packages: string[];
  /** Perintah perbaikan yang disarankan (mis. `npm install lucide-react`). */
  fixCommand: string | null;
};

/** Modul bawaan Node — tidak boleh disarankan untuk di-install dari npm. */
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram',
  'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder',
  'sys', 'test', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

/**
 * Pola pesan "modul tidak ditemukan" dari berbagai toolchain.
 * Grup pertama yang cocok berisi nama spesifier-nya.
 */
const MISSING_MODULE_PATTERNS: RegExp[] = [
  /Module not found: (?:Error: )?Can't resolve '([^']+)'/gi, // webpack / Next.js
  /Module not found: (?:Error: )?Can't resolve "([^"]+)"/gi,
  /Cannot find module '([^']+)'/gi, // Node / ts-node
  /Cannot find module "([^"]+)"/gi,
  /error TS2307: Cannot find module '([^']+)'/gi, // TypeScript
  /Failed to resolve import "([^"]+)"/gi, // Vite
  /Failed to resolve import '([^']+)'/gi,
  /Could not resolve "([^"]+)"/gi, // esbuild
  /Cannot find package '([^']+)'/gi, // ESM ERR_MODULE_NOT_FOUND
  /ERR_MODULE_NOT_FOUND[^\n]*?'([^']+)'/gi,
];

/** Tanda khas halaman error dev server (bukan aplikasi user yang sedang jalan). */
const ERROR_PAGE_SIGNATURES: RegExp[] = [
  /Failed to compile/i, // Next.js dev overlay
  /This error occurred during the build process and can only be dismissed by fixing the error/i,
  /Unhandled Runtime Error/i, // Next.js runtime overlay
  /__next_error__/, // penanda halaman error Next.js
  /Failed to resolve import/i, // Vite
  /Pre-transform error/i, // Vite
  /\[plugin:[^\]]+\] .*error/i, // Vite/Rollup plugin error
  /Vite Error/i,
  /Internal Server Error: .*Module not found/i,
  /Error: Cannot find module/i,
  /Module not found: (?:Error: )?Can't resolve/i,
];

/** Ekstrak nama PAKET dari spesifier modul (buang path relatif & modul bawaan Node). */
export function packageNameFromSpecifier(specifier: string): string | null {
  const raw = (specifier || '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw) return null;
  if (raw.startsWith('.') || raw.startsWith('/')) return null; // file lokal
  if (raw.startsWith('node:')) return null;
  if (raw.includes('?')) return null; // berisi query (mis. impor aset)
  if (/^[a-z]+:[a-z]/i.test(raw)) return null; // skema lain (data:, http:)
  const segments = raw.split('/').filter(Boolean);
  if (!segments.length) return null;
  const base = raw.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
  if (!base) return null;
  if (NODE_BUILTINS.has(base)) return null;
  // Nama paket npm yang sah (termasuk scope).
  if (!/^(@[a-z0-9-._~]+\/)?[a-z0-9-._~]+$/i.test(base)) return null;
  return base;
}

/** Kumpulkan paket yang hilang dari sebuah teks (log/pesan error). Urut & unik. */
export function extractMissingPackages(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const pattern of MISSING_MODULE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const pkg = packageNameFromSpecifier(match[1] ?? '');
      if (pkg) found.add(pkg);
    }
  }
  return [...found].sort();
}

export function hasErrorPageSignature(text: string): boolean {
  if (!text) return false;
  return ERROR_PAGE_SIGNATURES.some((re) => re.test(text));
}

/** Ambil cuplikan baris yang benar-benar menjelaskan masalah (untuk user & model). */
export function issueDetail(text: string, maxChars = 600): string {
  const lines = (text || '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim());
  const interesting = lines.filter((line) =>
    /Can't resolve|Cannot find module|Failed to resolve|Could not resolve|Failed to compile|Unhandled Runtime Error|Pre-transform error|ERR_MODULE_NOT_FOUND|TS2307/i.test(
      line,
    ),
  );
  const picked = (interesting.length ? interesting : lines).slice(0, 6).join('\n').trim();
  return picked.slice(0, maxChars);
}

export function packageManagerFromLockfile(files: string[]): PackageManager {
  const list = files.map((f) => f.trim().toLowerCase()).filter(Boolean);
  if (list.some((f) => f === 'pnpm-lock.yaml' || f.endsWith('/pnpm-lock.yaml'))) return 'pnpm';
  if (list.some((f) => f === 'yarn.lock' || f.endsWith('/yarn.lock'))) return 'yarn';
  if (list.some((f) => /^bun\.lockb?$/.test(f) || /\bbun\.lockb?$/.test(f))) return 'bun';
  return 'npm';
}

export function installCommand(manager: PackageManager, packages: string[]): string {
  const list = [...new Set(packages.filter(Boolean))].join(' ');
  if (!list) return '';
  switch (manager) {
    case 'pnpm':
      return `pnpm add ${list}`;
    case 'yarn':
      return `yarn add ${list}`;
    case 'bun':
      return `bun add ${list}`;
    default:
      return `npm install ${list}`;
  }
}

/**
 * Deteksi masalah dari halaman yang disajikan dev server, log-nya, atau keduanya.
 *
 * Aturan penting supaya tidak salah tuduh: teks yang bisa muncul di halaman
 * APLIKASI SENDIRI (mis. dokumentasi yang memuat kata "Module not found") tidak
 * dianggap masalah. Karena itu diperlukan tanda kuat (halaman error framework)
 * atau status HTTP >= 500 yang disertai baris "modul tidak ditemukan".
 */
export function detectPreviewIssue(input: {
  status?: number;
  body?: string;
  log?: string;
  packageManager?: PackageManager;
}): PreviewIssue | null {
  const body = input.body ?? '';
  const log = input.log ?? '';
  const combined = [log, body].filter(Boolean).join('\n');
  if (!combined.trim()) return null;

  const status = Number(input.status) || 0;
  const signature = hasErrorPageSignature(combined);
  const packages = extractMissingPackages(combined);
  const serverError = status >= 500;

  if (!signature && !(serverError && packages.length)) return null;

  const manager = input.packageManager ?? 'npm';
  const detail = issueDetail(combined);

  if (packages.length) {
    return {
      kind: 'missing-package',
      title: `Modul belum terpasang: ${packages.join(', ')}`,
      detail,
      packages,
      fixCommand: installCommand(manager, packages),
    };
  }

  return {
    kind: 'compile',
    title: 'Dev server menampilkan halaman error kompilasi',
    detail,
    packages: [],
    fixCommand: null,
  };
}

/** Ringkasan siap-pakai untuk pesan ke user/agent. */
export function summarizeIssue(issue: PreviewIssue | null | undefined): string | null {
  if (!issue) return null;
  const parts = [`Preview menampilkan halaman error, bukan aplikasi user: ${issue.title}.`];
  if (issue.detail) parts.push(`Pesan: ${issue.detail.split('\n')[0]}`);
  if (issue.fixCommand) parts.push(`Perbaikan: jalankan \`${issue.fixCommand}\` di folder proyek, lalu jalankan ulang servernya.`);
  else parts.push('Perbaiki error kompilasi di atas, lalu jalankan ulang servernya.');
  return parts.join(' ');
}
