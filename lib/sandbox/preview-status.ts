/**
 * Logika MURNI untuk menilai kesiapan dev server & preview.
 *
 * Semua fungsi di sini tidak menyentuh sandbox/jaringan supaya bisa diuji tanpa
 * kredit E2B (lihat tests/preview-recovery.mts).
 *
 * Latar belakang bug nyata yang memunculkan modul ini:
 * `curl http://127.0.0.1:<port>` DARI DALAM sandbox bisa menjawab 200 walaupun
 * server hanya bind ke loopback. Proxy port E2B berjalan di luar network
 * namespace sandbox, sehingga URL publiknya menjawab "Closed Port Error /
 * Connection refused on port ...". Akibatnya agent melaporkan "Preview siap",
 * iframe menampilkan halaman error E2B, dan user melihat preview yang "selalu
 * rusak". Karena itu kesiapan WAJIB dinilai dari URL publik, bukan dari
 * localhost.
 */

import {
  detectPreviewIssue,
  installCommand,
  summarizeIssue,
  type PackageManager,
  type PreviewIssue,
} from '@/lib/sandbox/diagnostics';

export type ListenScope = 'all' | 'loopback' | 'none' | 'unknown';

export type PublicProbe = {
  /** Status HTTP dari URL publik; '000' berarti request gagal sama sekali. */
  status: string;
  online: boolean;
  /** true = yang menjawab adalah halaman error proxy E2B, bukan aplikasi user. */
  proxyError: boolean;
  /**
   * Halaman yang disajikan dev server TAPI bukan aplikasi user (mis. halaman
   * "Failed to compile"/"Module not found"). `online` tetap true karena server
   * memang hidup — tetapi preview-nya belum bisa dipakai.
   */
  issue?: PreviewIssue | null;
  /**
   * Identitas halaman yang benar-benar disajikan (judul/h1/panjang teks).
   *
   * Dipakai untuk menjawab keluhan nyata: agent bilang "desain sudah saya
   * perbarui", user melihat halaman lama. Dengan judul/h1/panjang teks, agent &
   * panel Preview bisa menunjukkan HALAMAN MANA yang sedang tersaji — bukan
   * sekadar "HTTP 200".
   */
  page?: PageSummary | null;
};

/** Ringkasan halaman yang benar-benar disajikan server (dari HTML-nya). */
export type PageSummary = {
  title: string | null;
  h1: string | null;
  textLength: number;
  /** Jumlah <link rel="stylesheet"> dan <script src> (indikasi halaman kosong/polos). */
  stylesheets: number;
  scripts: number;
};

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Baca identitas halaman dari HTML mentah.
 *
 * Sengaja sederhana (regex, bukan parser HTML): yang dibutuhkan hanya judul, h1,
 * perkiraan panjang teks, dan berapa aset CSS/JS yang dirujuk supaya halaman
 * "polos tanpa CSS" bisa dibedakan dari halaman yang benar-benar berdesain.
 */
export function extractPageSummary(html: string): PageSummary {
  const text = html || '';
  const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const h1 = text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const stylesheets = (text.match(/<link[^>]+rel=["']?stylesheet/gi) ?? []).length;
  const scripts = (text.match(/<script[^>]+src=/gi) ?? []).length;
  // Perkiraan teks yang dilihat user: buang tag & isi <script>/<style>.
  const visible = text
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    title: title ? decodeEntities(title).slice(0, 160) || null : null,
    h1: h1 ? decodeEntities(h1.replace(/<[^>]+>/g, ' ')).slice(0, 160) || null : null,
    textLength: visible.length,
    stylesheets,
    scripts,
  };
}

/** Satu baris identitas halaman untuk ditampilkan ke user/agent. */
export function summarizePage(page: PageSummary | null | undefined): string | null {
  if (!page) return null;
  const name = page.h1 ?? page.title;
  if (!name) return null;
  return `${name} (${page.textLength} karakter teks, ${page.stylesheets} CSS)`;
}

/* -------------------------------------------------------------------------- */
/* Folder yang benar-benar disajikan dev server                                */
/* -------------------------------------------------------------------------- */

/** Normalisasi path folder (buang garis miring di ujung). */
export function normalizeDir(dir: string): string {
  return (dir || '').replace(/\/+$/, '');
}

/** Apakah `filePath` berada di dalam `dir`? */
export function isInsideDir(filePath: string, dir: string): boolean {
  const file = normalizeDir(filePath);
  const base = normalizeDir(dir);
  if (!file || !base) return false;
  return file === base || file.startsWith(`${base}/`);
}

/**
 * Peringatan untuk agent saat file yang baru ditulis TIDAK berada di folder yang
 * disajikan dev server.
 *
 * Keluhan nyata: user minta "perbarui desain", agent mengaku sudah selesai, tetapi
 * preview tetap menampilkan versi lama. Penyebab paling sering bukan modelnya —
 * file ditulis ke folder lain daripada yang disajikan dev server (aplikasi berada
 * di sub-folder), sehingga perubahan tidak pernah terlihat.
 */
export function servedFolderWarning(options: {
  /** Path file yang baru ditulis. */
  wrotePath: string;
  /** Folder yang sedang disajikan dev server (dari registry, bisa kosong). */
  servedDirs: string[];
  /** Folder akar proyek (untuk pesan). */
  projectDir?: string;
}): string | null {
  const dirs = options.servedDirs.map(normalizeDir).filter(Boolean);
  if (!dirs.length) return null;
  if (dirs.some((dir) => isInsideDir(options.wrotePath, dir))) return null;
  const where = normalizeDir(options.wrotePath).replace(/\/[^/]*$/, '') || '/';
  return (
    `catatan: file ini ditulis ke ${where}, sedangkan dev server yang sedang berjalan menyajikan ${dirs.join(', ')} — ` +
    'perubahan ini TIDAK akan terlihat di preview. Tulis/perbaiki file di dalam folder yang disajikan itu, ' +
    'atau jalankan ulang server dengan `cwd` yang benar (lihat catatan server di /home/user/.agentcloud-servers.json).'
  );
}

export type ServerRecord = {
  port: number;
  command: string;
  cwd: string;
  /** Kapan perintah ini DIJALANKAN (epoch ms). */
  startedAt: number;
  /**
   * Kapan server ini pertama kali terbukti melayani URL publik (epoch ms).
   * null/absen = masih dalam masa penyalaan untuk peluncuran ini.
   *
   * Dipakai untuk membedakan "server baru saja dijalankan, beri waktu" dari
   * "server sudah pernah siap lalu mati" — yang pertama HARUS ditunggu (kalau
   * tidak, pemulihan otomatis akan membunuh server yang sedang kompilasi dan
   * mengulanginya selamanya), yang kedua harus langsung dijalankan ulang.
   */
  readyAt?: number | null;
};

/**
 * Masa tenggang setelah sebuah perintah server dijalankan, sebelum pemulihan
 * otomatis boleh membunuh & menjalankannya ulang.
 *
 * Angka ini lebih panjang dari waktu start dev server biasa (Vite/Next di sandbox
 * dingin bisa 30–90 detik) karena kesalahan di sini mahal: pemulihan yang
 * terburu-buru mematikan proses yang sedang menyala, lalu mengulanginya dari nol.
 */
export const STARTUP_GRACE_MS = 150_000;

/** Batas berapa lama satu request boleh menunggu server sebelum menjawab ke UI. */
export const MAX_WAIT_MS = 20_000;

/** Ciri khas halaman error proxy E2B (lihat "Closed Port Error" di UI). */
const PROXY_ERROR_PATTERNS = [
  /Closed Port Error/i,
  /Connection refused on port/i,
  /no service running on port/i,
  /Please ensure that your service is properly configured and running on the specified port/i,
];

export function isProxyErrorBody(body: string): boolean {
  if (!body) return false;
  return PROXY_ERROR_PATTERNS.some((re) => re.test(body));
}

/**
 * Nilai hasil permintaan ke URL preview publik.
 *  - '000'               -> request gagal (DNS/timeout/jaringan) => belum online.
 *  - halaman error proxy -> belum online (server tidak listen untuk proxy E2B).
 *  - 502/503/504         -> gateway error, tidak pernah datang dari dev server
 *                           yang sehat => belum online.
 *  - status lain (termasuk 4xx/500 dari aplikasi) -> ONLINE: servernya memang
 *    hidup, halamannya sendiri yang bermasalah. Kalau halaman itu ternyata
 *    halaman error kompilasi (`issue`), server dianggap hidup TAPI preview-nya
 *    belum siap dipakai (lihat decideServerReadiness).
 */
export function evaluatePublicProbe(status: number, body: string, log?: string): PublicProbe {
  const code = Number.isFinite(status) && status > 0 ? String(status) : '000';
  const proxyError = isProxyErrorBody(body);
  const gateway = status >= 502 && status <= 504;
  const online = code !== '000' && !proxyError && !gateway;
  const issue = online ? detectPreviewIssue({ status, body, log }) : null;
  // Identitas halaman ikut dilaporkan supaya "preview tidak berubah" bisa
  // dibuktikan dari isi halaman, bukan dari asumsi.
  const page = online && body ? extractPageSummary(body) : null;
  return { status: code, online, proxyError, issue, page };
}

export type Readiness = { state: 'ready' | 'dead' | 'timeout' | 'unknown'; code: string | null };

/** Baca keluaran skrip penunggu: "READY 200" / "DEAD" / "TIMEOUT". */
export function parseReadiness(output: string): Readiness {
  const text = output || '';
  const ready = text.match(/READY\s+(\d{3})/);
  if (ready) return { state: 'ready', code: ready[1] };
  if (/\bDEAD\b/.test(text)) return { state: 'dead', code: null };
  if (/\bTIMEOUT\b/.test(text)) return { state: 'timeout', code: null };
  return { state: 'unknown', code: null };
}

/**
 * Tentukan cakupan alamat listen dari keluaran `ss -ltn` (kolom alamat saja).
 * Hanya baris yang port-nya cocok yang diperhatikan.
 */
export function parseListenScope(ssOutput: string, port: number): ListenScope {
  const lines = (ssOutput || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return 'none';

  const addresses = lines
    .map((line) => line.split(/\s+/).pop() || '') // ambil kolom alamat lokal
    .filter((addr) => new RegExp(`[:.]${port}$`).test(addr));
  if (!addresses.length) return 'none';

  const anyPublic = addresses.some((addr) => /^(\*|0\.0\.0\.0|\[::\]|::):?/.test(addr));
  if (anyPublic) return 'all';
  const anyLoopback = addresses.some((addr) => /^(127\.|\[::1\]|::1)/.test(addr));
  if (anyLoopback) return 'loopback';
  return 'unknown';
}

export type FrameworkHint = 'next' | 'vite' | 'astro' | 'nuxt' | 'sveltekit' | 'remix' | null;

/** Tebak framework dari isi package.json (untuk menentukan flag bind yang tepat). */
export function detectFrameworkFromPackageJson(raw: string | null | undefined): FrameworkHint {
  if (!raw) return null;
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return null;
  }
  const p = pkg as Record<string, unknown>;
  const deps = {
    ...((p.dependencies as Record<string, string>) ?? {}),
    ...((p.devDependencies as Record<string, string>) ?? {}),
  };
  const has = (name: string) => Object.prototype.hasOwnProperty.call(deps, name);
  if (has('next')) return 'next';
  if (has('nuxt') || has('nuxt3')) return 'nuxt';
  if (has('astro')) return 'astro';
  if (has('@sveltejs/kit') || has('svelte')) return 'sveltekit';
  if (has('@remix-run/dev') || has('@remix-run/node')) return 'remix';
  if (has('vite')) return 'vite';
  return null;
}

/**
 * Tentukan flag bind 0.0.0.0 untuk sebuah perintah.
 *
 * Cara kerja: tebak dari teks perintah lebih dulu; kalau perintahnya generik
 * (mis. `npm run dev`) pakai petunjuk framework dari package.json. Inilah yang
 * membuat perbaikan otomatis bekerja untuk kasus paling umum.
 */
export function hostOverrideFor(command: string, framework: FrameworkHint = null): string | null {
  const cmd = (command || '').trim();
  if (!cmd) return null;
  if (/--host(name)?[= ]\s*0\.0\.0\.0|--bind[= ]\s*0\.0\.0\.0|-H[= ]\s*0\.0\.0\.0/.test(cmd)) return null;

  const fromText = (): string | null => {
    if (/\bnext\b/.test(cmd)) return '--hostname 0.0.0.0';
    if (/\b(vite|astro|nuxt|remix|svelte-kit|sveltekit|webpack|parcel|serve|http-server|ng serve)\b/.test(cmd)) {
      return '--host 0.0.0.0';
    }
    if (/python3?\s+-m\s+http\.server/.test(cmd)) return '--bind 0.0.0.0';
    return null;
  };

  const fromFramework = (): string | null => {
    switch (framework) {
      case 'next':
        return '--hostname 0.0.0.0';
      case 'vite':
      case 'astro':
      case 'nuxt':
      case 'sveltekit':
      case 'remix':
        return '--host 0.0.0.0';
      default:
        return null;
    }
  };

  const flag = fromText() ?? fromFramework();
  if (!flag) return null;
  return appendScriptArgs(cmd, flag);
}

/**
 * Tempelkan flag ke perintah dengan benar.
 * `npm/pnpm/yarn/bun run <script>` butuh pemisah `--` supaya flag diteruskan ke
 * script-nya (kalau tidak, npm menolaknya sebagai opsi npm yang tidak dikenal).
 */
export function appendScriptArgs(command: string, flag: string): string {
  const cmd = command.trim();
  if (!flag) return cmd;
  const isPackageScript = /(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?[\w:-]+/.test(cmd) || /^\s*(npm|pnpm|yarn|bun)\b/.test(cmd);
  const hasSeparator = /\s--\s/.test(cmd);
  if (isPackageScript && !hasSeparator) return `${cmd} -- ${flag}`;
  return `${cmd} ${flag}`;
}

export type ServerReadiness = {
  /** true = server benar-benar bisa dipakai user lewat URL publik. */
  ready: boolean;
  /** Catatan tambahan untuk agent/user (null kalau semuanya jelas). */
  warning: string | null;
  /** Penjelasan kenapa belum siap (null kalau sudah siap). */
  reason: string | null;
  /** Masalah halaman (mis. modul belum terpasang) yang membuat preview belum siap. */
  issue?: PreviewIssue | null;
};

/**
 * Putuskan kesiapan server dari tiga sumber: cek lokal, cakupan bind, dan hasil
 * probe URL publik.
 *
 * Kasus khusus yang penting: kalau probe publik gagal karena masalah JARINGAN
 * ('000', tanpa halaman error proxy) sementara server lokal menjawab dan
 * bind-nya sudah 0.0.0.0, kita anggap siap tapi beri peringatan - supaya
 * kegagalan jaringan sementara di sisi server aplikasi ini tidak membuat agent
 * berputar-putar memperbaiki hal yang sebenarnya benar.
 */
export function decideServerReadiness(input: {
  localCode: string;
  listenScope: ListenScope;
  publicProbe: PublicProbe;
  /** Paket manager terdeteksi dari lockfile (dipakai menyusun perintah perbaikan). */
  packageManager?: PackageManager;
}): ServerReadiness {
  const { localCode, listenScope, publicProbe, packageManager } = input;
  const localUp = localCode !== '000';

  /**
   * Server MENJAWAB, tapi yang disajikan adalah halaman error kompilasi (mis.
   * Next.js "Failed to compile — Module not found"). Ini insiden nyata: preview
   * dulu dinyatakan siap karena ada status HTTP, sehingga agent melapor "preview
   * sudah bisa dibuka" sementara user melihat layar error. Preview belum dianggap
   * siap sampai halamannya benar-benar aplikasi user.
   */
  const baseIssue = publicProbe.issue ?? detectPreviewIssue({ status: Number(publicProbe.status) });
  // Kalau pemanggil sudah mendeteksi package manager dari lockfile, perintah
  // perbaikannya disusun ulang memakai manager itu (mis. `pnpm add ...`).
  const issue =
    baseIssue && baseIssue.packages.length && packageManager
      ? { ...baseIssue, fixCommand: installCommand(packageManager, baseIssue.packages) }
      : baseIssue;
  if (publicProbe.online && issue) {
    return { ready: false, warning: null, reason: summarizeIssue(issue), issue };
  }

  if (publicProbe.online) return { ready: true, warning: null, reason: null, issue: null };

  if (publicProbe.proxyError || (Number(publicProbe.status) >= 502 && Number(publicProbe.status) <= 504)) {
    if (listenScope === 'loopback') {
      return {
        ready: false,
        warning: null,
        reason:
          'Server hanya mendengarkan di 127.0.0.1 (loopback) sehingga proxy E2B tidak bisa menjangkaunya. ' +
          'Bind ke 0.0.0.0: Vite/Astro/Svelte/Remix → "--host 0.0.0.0", Next.js → "--hostname 0.0.0.0", ' +
          "Express/Node → app.listen(port, '0.0.0.0').",
      };
    }
    if (!localUp) {
      return {
        ready: false,
        warning: null,
        reason: 'Belum ada proses yang mendengarkan di port ini di dalam sandbox (server mati atau gagal start).',
      };
    }
    return {
      ready: false,
      warning: null,
      reason: 'Port terbuka di dalam sandbox, tetapi proxy E2B masih menolak. Coba jalankan ulang servernya sesaat lagi.',
    };
  }

  if (publicProbe.status === '000') {
    if (localUp && listenScope === 'all') {
      return {
        ready: true,
        warning:
          'URL publik belum bisa diverifikasi dari server aplikasi ini (masalah jaringan sementara). Server lokal sudah listen di 0.0.0.0.',
        reason: null,
      };
    }
    return {
      ready: false,
      warning: null,
      reason: localUp
        ? 'Server lokal menjawab, tetapi URL publik belum bisa dihubungi.'
        : 'Belum ada proses yang mendengarkan di port ini di dalam sandbox.',
    };
  }

  // Ada status HTTP nyata & bukan halaman error proxy: aplikasinya hidup,
  // hanya halaman/route-nya yang bermasalah (4xx/5xx dari app sendiri tetap
  // dianggap siap — yang tidak boleh dianggap siap adalah halaman error
  // kompilasi dev server, dan itu sudah ditangani di atas).
  return { ready: true, warning: null, reason: null, issue: null };
}

export type RecoveryPlan = {
  /**
   * 'none'   = tidak ada yang bisa/perlu dilakukan otomatis.
   * 'wait'   = server sedang menyala / port sudah terbuka; tunggu sebentar,
   *            JANGAN dijalankan ulang (menjalankan ulang akan mematikannya).
   * 'revive' = jalankan ulang perintah server yang tersimpan.
   */
  action: 'none' | 'wait' | 'revive';
  reason: string | null;
  /** Untuk 'wait': saran berapa lama lagi server diberi waktu (ms). */
  waitMs?: number;
};

/**
 * Bentuk status preview yang dikirim ke UI (dipakai route preview).
 * `status`/`online` berasal dari URL PUBLIK karena itu yang benar-benar
 * dirasakan user; `localStatus`/`listenScope` adalah hasil cek dari dalam
 * sandbox untuk mendiagnosa.
 */
export type PreviewStatus = {
  url: string;
  port: number;
  status: string;
  online: boolean;
  localStatus: string;
  listenScope: ListenScope;
  proxyError: boolean;
  restarted: boolean;
  startedCommand: string | null;
  reason: string | null;
  /** true = server sedang disiapkan/ditunggu (jangan dianggap gagal dulu). */
  pending: boolean;
  /** Halaman error (mis. modul belum terpasang) yang membuat preview belum bisa dipakai. */
  issue?: PreviewIssue | null;
  /** Identitas halaman yang benar-benar tersaji (judul/h1/panjang teks). */
  page?: PageSummary | null;
};

/**
 * Rencana pemulihan otomatis untuk panel Preview.
 *
 *  - wait   = jangan sentuh apa pun: server baru dijalankan dan mungkin masih
 *             mengunduh/kompilasi (inilah yang mencegah "bunuh lalu ulang" tanpa
 *             henti), atau port sudah terbuka dan proxy E2B butuh sesaat lagi.
 *  - revive = jalankan ulang perintah server yang tersimpan di sandbox.
 */
export function planPreviewRecovery(input: {
  publicOnline: boolean;
  localCode: string;
  listenScope: ListenScope;
  hasServerRecord: boolean;
  /** Umur peluncuran terakhir (ms), null kalau tidak ada catatan. */
  sinceLaunchMs?: number | null;
  /** Umur sejak server terakhir terbukti siap (ms), null = belum pernah siap. */
  sinceReadyMs?: number | null;
  /**
   * Masalah halaman (mis. halaman error kompilasi). Kalau ada, menjalankan ulang
   * server TIDAK akan menolong — yang perlu diperbaiki kodenya/dependency-nya —
   * jadi pemulihan otomatis harus berhenti dan melaporkan masalahnya.
   */
  issue?: PreviewIssue | null;
}): RecoveryPlan {
  const {
    publicOnline,
    localCode,
    listenScope,
    hasServerRecord,
    sinceLaunchMs = null,
    sinceReadyMs = null,
    issue = null,
  } = input;

  if (publicOnline && !issue) return { action: 'none', reason: null };
  if (issue) return { action: 'none', reason: summarizeIssue(issue) };

  if (listenScope === 'loopback') {
    if (hasServerRecord) {
      return {
        action: 'revive',
        reason: 'Server hanya listen di 127.0.0.1 — dijalankan ulang dengan bind 0.0.0.0 agar URL publik E2B bisa menjangkaunya.',
      };
    }
    return {
      action: 'none',
      reason:
        'Server hanya mendengarkan di 127.0.0.1 (localhost), jadi URL publik E2B menolaknya. Jalankan ulang dengan bind 0.0.0.0: ' +
        'Vite/Astro → "--host 0.0.0.0", Next.js → "--hostname 0.0.0.0", Node/Express → app.listen(port, "0.0.0.0").',
    };
  }

  if (hasServerRecord) {
    const stillStarting =
      sinceLaunchMs != null && sinceReadyMs == null && sinceLaunchMs >= 0 && sinceLaunchMs < STARTUP_GRACE_MS;
    if (stillStarting) {
      return {
        action: 'wait',
        waitMs: STARTUP_GRACE_MS - sinceLaunchMs,
        reason:
          'Dev server baru dijalankan dan sedang menyala (unduh dependency/kompilasi) — preview akan muncul otomatis, tidak perlu dijalankan ulang.',
      };
    }
    return {
      action: 'revive',
      reason: 'Dev server tidak merespons — dijalankan ulang otomatis dari perintah terakhir yang dipakai agent.',
    };
  }

  if (localCode !== '000') {
    return {
      action: 'wait',
      waitMs: 12_000,
      reason: 'Port terbuka di sandbox tetapi proxy E2B belum meneruskan. Coba lagi sebentar.',
    };
  }

  return {
    action: 'none',
    reason:
      'Belum ada dev server yang berjalan di port ini. Minta agent menjalankannya lewat tool start_server, atau jalankan sendiri dari tab Terminal.',
  };
}

/** Terima JSON registry apa pun; kembalikan hanya entri yang bentuknya sah. */
export function parseServerRegistry(raw: string | null | undefined): ServerRecord[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [];
  const out: ServerRecord[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const port = Number(rec.port);
    const command = typeof rec.command === 'string' ? rec.command.trim() : '';
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || !command) continue;
    const readyAt = Number(rec.readyAt);
    out.push({
      port,
      command,
      cwd: typeof rec.cwd === 'string' && rec.cwd.trim() ? rec.cwd.trim() : '',
      startedAt: Number(rec.startedAt) || 0,
      // Absen/nol = belum pernah terbukti siap pada peluncuran ini.
      readyAt: Number.isFinite(readyAt) && readyAt > 0 ? readyAt : null,
    });
  }
  return out;
}

export function serializeServerRegistry(records: ServerRecord[]): string {
  return JSON.stringify(parseServerRegistry(JSON.stringify(records)), null, 0);
}
