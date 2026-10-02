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

export type ListenScope = 'all' | 'loopback' | 'none' | 'unknown';

export type PublicProbe = {
  /** Status HTTP dari URL publik; '000' berarti request gagal sama sekali. */
  status: string;
  online: boolean;
  /** true = yang menjawab adalah halaman error proxy E2B, bukan aplikasi user. */
  proxyError: boolean;
};

export type ServerRecord = {
  port: number;
  command: string;
  cwd: string;
  startedAt: number;
};

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
 *    hidup, halamannya sendiri yang bermasalah.
 */
export function evaluatePublicProbe(status: number, body: string): PublicProbe {
  const code = Number.isFinite(status) && status > 0 ? String(status) : '000';
  const proxyError = isProxyErrorBody(body);
  const gateway = status >= 502 && status <= 504;
  const online = code !== '000' && !proxyError && !gateway;
  return { status: code, online, proxyError };
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
}): ServerReadiness {
  const { localCode, listenScope, publicProbe } = input;
  const localUp = localCode !== '000';

  if (publicProbe.online) return { ready: true, warning: null, reason: null };

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
  // hanya halaman/route-nya yang bermasalah.
  return { ready: true, warning: null, reason: null };
}

export type RecoveryPlan = { action: 'none' | 'revive'; reason: string | null };

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
};

/**
 * Rencana pemulihan otomatis untuk panel Preview.
 *  - revive = jalankan ulang perintah server yang tersimpan di sandbox.
 */
export function planPreviewRecovery(input: {
  publicOnline: boolean;
  localCode: string;
  listenScope: ListenScope;
  hasServerRecord: boolean;
}): RecoveryPlan {
  const { publicOnline, localCode, listenScope, hasServerRecord } = input;
  if (publicOnline) return { action: 'none', reason: null };

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
    return {
      action: 'revive',
      reason: 'Dev server tidak merespons — dijalankan ulang otomatis dari perintah terakhir yang dipakai agent.',
    };
  }

  if (localCode !== '000') {
    return { action: 'none', reason: 'Port terbuka di sandbox tetapi proxy E2B belum meneruskan. Coba lagi sebentar.' };
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
    out.push({
      port,
      command,
      cwd: typeof rec.cwd === 'string' && rec.cwd.trim() ? rec.cwd.trim() : '',
      startedAt: Number(rec.startedAt) || 0,
    });
  }
  return out;
}

export function serializeServerRegistry(records: ServerRecord[]): string {
  return JSON.stringify(parseServerRegistry(JSON.stringify(records)), null, 0);
}
