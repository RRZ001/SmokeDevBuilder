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
 *
 * Dua pelajaran dari pemakaian nyata (Okt 2026, insiden "Sistem kasir"):
 *  1. **JANGAN menebak alias produksi.** Nama `<nama>.vercel.app` bisa sudah
 *     dipakai orang lain; Vercel lalu memberikan alias bersufiks acak
 *     (mis. `sistem-kasir-drab.vercel.app`). Menebak `sistem-kasir.vercel.app`
 *     berarti menampilkan link milik orang lain. Hanya URL yang benar-benar
 *     DICETAK CLI yang boleh dipakai.
 *  2. Proses CLI harus punya penanda selesai EKSPLISIT (`__AC_DEPLOY_EXIT__<kode>`),
 *     karena keluaran "guidance" CLI (saran langkah berikutnya) muncul juga saat
 *     deployment GAGAL dibangun — tanpa penanda itu statusnya menggantung
 *     "masih berjalan" selamanya.
 */

export type DeployState = 'running' | 'done' | 'failed';

export type DeployStatus = {
  state: DeployState;
  /** URL permanen hasil deploy (dari keluaran CLI; null bila belum terbaca). */
  url: string | null;
  /** Semua URL .vercel.app yang terlihat di log (untuk diagnosa). */
  urls: string[];
  /** Pesan error ringkas bila gagal. */
  error: string | null;
};

/** Path file log deploy di dalam sandbox (dipakai untuk polling). */
export const DEPLOY_LOG_PATH = '/home/user/.agentcloud-deploy.log';
/**
 * PID proses deploy yang sedang berjalan.
 *
 * Dipakai untuk MEMUTUSKAN apakah "tekan Deploy sekali lagi" berarti MELANJUTKAN
 * (proses masih hidup, hanya belum selesai) atau MEMULAI ULANG (prosesnya sudah
 * tidak ada, mis. sandbox di-pause di tengah deploy) — tanpa ini, tombol Deploy
 * yang ditekan ulang selalu memulai deploy BARU dan membuang hasil yang sedang
 * berjalan.
 */
export const DEPLOY_PID_PATH = '/home/user/.agentcloud-deploy.pid';
/** Penanda CLI Vercel sudah tersedia di sandbox. */
export const VERCEL_MARKER = '/home/user/.agentcloud-vercel-ready';
/** Batas waktu satu deploy (unggah + build di sisi Vercel). */
export const DEPLOY_TIMEOUT_MS = 240_000;
/** Jeda antar pemeriksaan log. */
export const DEPLOY_POLL_MS = 3_000;
/** Penanda akhir proses (kode keluar CLI) yang ditulis ke file log. */
export const DEPLOY_EXIT_PREFIX = '__AC_DEPLOY_EXIT__';

/**
 * Batas jumlah pemanggilan tool `deploy` DALAM SATU giliran agent.
 *
 * Insiden nyata (Okt 2026): pesan hasil tool berbunyi "panggil tool deploy sekali
 * lagi untuk melanjutkan", jadi agent mengulanginya di setiap langkah — chat user
 * penuh puluhan baris "Deploy masih berjalan. Saya akan cek sekali lagi" sampai
 * batas langkah (12) tercapai, tanpa pernah memberi jawaban.
 */
export const DEPLOY_TOOL_MAX_CALLS = 2;

/**
 * Setelah deploy berjalan selama ini, ia dianggap MACET (bukan "sedang sibuk"):
 * deploy Vercel normal selesai dalam 1-3 menit. Kalau prosesnya masih "hidup"
 * tetapi tidak pernah selesai (mis. menunggu input, jaringan sandbox putus),
 * agent harus BERHENTI menunggu dan menyerahkannya ke user + panel Preview.
 */
export const DEPLOY_STALL_MS = 8 * 60_000;

/** Perintah membaca waktu mulai deploy (mtime file PID di dalam sandbox). */
export function deployStartedAtScript(path: string = DEPLOY_PID_PATH): string {
  return `stat -c %Y ${path} 2>/dev/null || echo 0`;
}

/** Epoch-ms kapan deploy dimulai (null kalau tidak terbaca). */
export function parseDeployStartedAt(output: string): number | null {
  const value = Number(String(output || '').trim().split(/\s+/).pop());
  if (!Number.isFinite(value) || value <= 0) return null;
  // `stat -c %Y` = detik; nilainya bisa juga sudah ms bila tidak masuk akal kecil.
  return value > 1e12 ? value : value * 1000;
}

/** "3 menit 12 detik" — dipakai di pesan status deploy. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes >= 60) return `${Math.floor(minutes / 60)} jam ${minutes % 60} menit`;
  if (minutes > 0) return `${minutes} menit ${seconds} detik`;
  return `${seconds} detik`;
}

/**
 * Pesan penutup saat deploy belum selesai dan agent TIDAK boleh memanggil tool
 * `deploy` lagi di giliran ini: jelaskan apa yang terjadi + apa yang harus
 * dilakukan user (bukan menyuruh agent mengulang polling).
 */
export function deployStillRunningMessage(options: { ageMs: number; stalled: boolean; url?: string | null }): string {
  const age = formatDuration(options.ageMs);
  if (options.stalled) {
    return (
      `deploy_macet: deploy sudah berjalan ${age} tanpa selesai — kemungkinan prosesnya tertahan di sisi Vercel/sandbox ` +
      '(bukan build yang sedang sibuk). JANGAN panggil tool `deploy` lagi. Laporkan ke user apa adanya: deploy belum ' +
      'menghasilkan link, tunjukkan beberapa baris log terakhir sebagai bukti, dan sarankan menekan tombol ' +
      '**Deploy ke Vercel** sekali lagi di panel Preview (panel itu memantau sendiri) atau menunggu lalu mencoba lagi.'
    );
  }
  return (
    `deploy_belum_selesai: deploy masih berjalan ${age} di Vercel dan belum menghasilkan link. ` +
    'JANGAN panggil tool `deploy` lagi di giliran ini dan jangan mengulang kalimat yang sama. ' +
    'Laporkan ke user: linknya belum bisa dipastikan, panel Preview tetap memantau sendiri, dan user bisa menekan ' +
    'tombol **Deploy ke Vercel** sekali lagi untuk mengambil linknya begitu selesai. Lanjutkan hanya kalau user meminta.'
  );
}

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

/** Alias produksi bila nama proyek masih bebas (hanya untuk tebakan/tampilan). */
export function productionAlias(projectName: string): string {
  return `https://${toVercelProjectName(projectName)}.vercel.app`;
}

/**
 * Perintah menautkan folder proyek ke sebuah nama proyek Vercel.
 *
 * Dipakai menggantikan opsi `--name` pada `deploy` yang sudah DEPRECATED
 * (lihat dokumentasi CLI Vercel). `link --project` juga bisa dipakai untuk nama
 * yang berbeda dari nama folder dan berjalan non-interaktif dengan `--yes`.
 */
export function buildLinkCommand(options: { projectName?: string; scope?: string } = {}): string {
  const parts = ['npx', '--yes', 'vercel@latest', 'link', '--yes'];
  const name = options.projectName ? toVercelProjectName(options.projectName) : '';
  if (name) parts.push('--project', name);
  const scope = (options.scope || '').trim();
  if (scope) parts.push('--scope', scope);
  return parts.join(' ');
}

/**
 * Perintah deploy. `--yes` = non-interaktif (proyek dibuat/dipakai otomatis).
 * TIDAK memakai `--name` (deprecated): nama proyek diatur lewat `link` di atas.
 */
export function buildDeployCommand(options: { prod?: boolean; scope?: string } = {}): string {
  const parts = ['npx', '--yes', 'vercel@latest', 'deploy', '--yes'];
  if (options.prod !== false) parts.push('--prod');
  const scope = (options.scope || '').trim();
  if (scope) parts.push('--scope', scope);
  return parts.join(' ');
}

/**
 * Perintah yang dijalankan di background: keluaran ke file log, diakhiri penanda
 * berisi kode keluar CLI (satu-satunya tanda "proses ini sudah berakhir").
 */
export function deployShellCommand(command: string, logPath: string = DEPLOY_LOG_PATH): string {
  return `${command} > ${logPath} 2>&1; echo "${DEPLOY_EXIT_PREFIX}$?" >> ${logPath}`;
}

/** Perintah untuk memastikan CLI Vercel tersedia (sekali per sandbox). */
export function vercelInstallCommand(): string {
  return 'npx --yes vercel@latest --version';
}

/** Perintah pemeriksaan apakah proses deploy masih hidup. */
export function processAliveScript(pid: number): string {
  return `kill -0 ${Math.trunc(pid)} 2>/dev/null && echo ALIVE || echo GONE`;
}

export function parseProcessAlive(output: string): boolean {
  return /ALIVE/.test(output || '');
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
 * URL dari sebuah baris hasil CLI, mis. "✅  Production: https://x.vercel.app [12s]".
 *
 * Label dan URL harus berada di BARIS YANG SAMA: blok saran CLI menulis label di
 * satu baris dan perintah+URL di baris berikutnya ("Check the production
 * response:" lalu "  vercel curl https://…"), sehingga pencocokan longgar akan
 * salah menganggap blok saran sebagai hasil sukses.
 */
function urlAfterLabel(line: string, labels: string[]): string | null {
  const pattern = new RegExp(`^[^\\w]*(?:${labels.join('|')})\\b[^:]*:\\s*(https:\\/\\/\\S+)`, 'i');
  const match = line.match(pattern);
  return match ? match[1].replace(/[.,)]+$/, '') : null;
}

/**
 * URL permanen dari keluaran CLI (dibaca dari belakang supaya baris hasil terakhir
 * yang menang). Urutan prioritas: Production → Aliased → Preview.
 * Mengembalikan null kalau CLI tidak mencetak URL semacam itu.
 */
export function permanentUrlFromLog(text: string): string | null {
  const lines = (text || '').split('\n').filter((line) => line.trim());
  const lookups: Array<(line: string) => string | null> = [
    (line) => urlAfterLabel(line, ['production']),
    (line) => urlAfterLabel(line, ['aliased', 'alias']),
    (line) => urlAfterLabel(line, ['preview']),
  ];
  for (const lookup of lookups) {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const found = lookup(lines[i]);
      if (found) return found;
    }
  }
  return null;
}

/**
 * URL yang dipakai untuk ditampilkan ke user:
 *  1. URL produksi/alias yang benar-benar dicetak CLI,
 *  2. kalau tidak ada, URL deployment pertama yang terlihat (jujur apa adanya —
 *     jangan mengarang alias yang mungkin milik orang lain).
 */
export function pickPrimaryUrl(urls: string[], logText = ''): string | null {
  const permanent = permanentUrlFromLog(logText);
  if (permanent) return permanent;
  return urls[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Deployment Protection (Vercel Authentication)                                */
/* -------------------------------------------------------------------------- */

/** Basis API publik Vercel (dipakai dengan token user, tidak pernah di klien). */
export const VERCEL_API_BASE = 'https://api.vercel.com';

/** Info proyek Vercel dari API — termasuk alias produksi & status proteksinya. */
export type VercelProjectInfo = {
  id: string | null;
  name: string | null;
  /**
   * Alias produksi STABIL milik proyek ini (mis. `sistem-kasir-smoke-dev-builder.vercel.app`),
   * dibaca dari `targets.production.alias`. Ini bukan tebakan: nilainya berasal
   * dari catatan proyek user sendiri, jadi aman ditampilkan sebagai link permanen
   * (berbeda dengan URL ber-hash yang berubah tiap deploy).
   */
  productionAliases: string[];
  /** true = Vercel Authentication (Deployment Protection) aktif untuk proyek ini. */
  protected: boolean;
  /** Jenis proteksi dari API (`prod_deployment_urls_and_all_previews` dll). */
  protectionType: string | null;
  /** Halaman pengaturan Deployment Protection proyek ini. */
  settingsUrl: string | null;
};

/** Parameter `teamId`/slug untuk API Vercel (kosong = akun pribadi). */
function scopeQuery(scope?: string | null): string {
  const value = (scope || '').trim();
  return value ? `?teamId=${encodeURIComponent(value)}` : '';
}

/**
 * Permintaan info proyek ke API Vercel (GET) — untuk mengetahui alias produksi
 * dan apakah proyeknya dikunci Deployment Protection.
 */
export function buildProjectInfoRequest(options: { projectName: string; scope?: string | null }): {
  url: string;
  method: 'GET';
} {
  const name = toVercelProjectName(options.projectName);
  return {
    url: `${VERCEL_API_BASE}/v9/projects/${encodeURIComponent(name)}${scopeQuery(options.scope)}`,
    method: 'GET',
  };
}

/**
 * Permintaan MEMATIKAN Vercel Authentication untuk sebuah proyek.
 *
 * Dokumentasi Vercel menyebutkan `ssoProtection: null` = Vercel Authentication
 * dimatikan, dan mematikannya langsung membuka SEMUA deployment yang sudah ada
 * (tidak perlu deploy ulang) — inilah sebabnya link user bisa dibuka publik
 * tanpa menunggu build baru.
 */
export function buildDisableProtectionRequest(options: { projectName: string; scope?: string | null }): {
  url: string;
  method: 'PATCH';
  body: string;
} {
  const name = toVercelProjectName(options.projectName);
  return {
    url: `${VERCEL_API_BASE}/v9/projects/${encodeURIComponent(name)}${scopeQuery(options.scope)}`,
    method: 'PATCH',
    body: JSON.stringify({ ssoProtection: null }),
  };
}

/** Halaman pengaturan Deployment Protection sebuah proyek Vercel. */
export function deploymentProtectionSettingsUrl(options: { projectName: string; scope?: string | null }): string {
  const name = toVercelProjectName(options.projectName);
  const scope = (options.scope || '').trim();
  return scope ? `https://vercel.com/${scope}/${name}/settings/deployment-protection` : `https://vercel.com/${name}`;
}

/** Ambil alias produksi dari objek `targets.production.alias` milik proyek. */
function productionAliasesFrom(targets: unknown): string[] {
  const production = (targets as { production?: { alias?: unknown } } | null)?.production;
  const alias = production?.alias;
  if (!Array.isArray(alias)) return [];
  const hosts = alias
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, ''))
    .filter(Boolean);
  const unique = [...new Set(hosts)];
  // Domain `*.vercel.app` didahulukan (pasti milik proyek ini dan selalu aktif);
  // domain custom ikut sebagai cadangan tanpa mengalahkan yang utama.
  return unique.sort((a, b) => Number(b.endsWith('.vercel.app')) - Number(a.endsWith('.vercel.app')));
}

/**
 * Baca respons GET /v9/projects/{name} jadi info yang dipakai UI.
 * Mengembalikan null kalau bentuknya tidak dikenali (jangan menebak).
 */
export function parseProjectInfo(json: unknown, options: { scope?: string | null } = {}): VercelProjectInfo | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name : null;
  if (!name) return null;
  const sso = obj.ssoProtection;
  const protectedFlag = Boolean(sso && typeof sso === 'object');
  const protectionType =
    sso && typeof sso === 'object' && typeof (sso as { deploymentType?: unknown }).deploymentType === 'string'
      ? String((sso as { deploymentType: string }).deploymentType)
      : null;
  return {
    id: typeof obj.id === 'string' ? obj.id : null,
    name,
    productionAliases: productionAliasesFrom(obj.targets),
    protected: protectedFlag,
    protectionType,
    settingsUrl: deploymentProtectionSettingsUrl({ projectName: name, scope: options.scope }),
  };
}

/** Hasil pemeriksaan sebuah link deploy (dari sisi server, redirect tidak diikuti). */
export type DeployLinkProbe = {
  /** Status HTTP; 0 = request gagal sama sekali. */
  status: number;
  location?: string | null;
  body?: string | null;
  setCookie?: string | null;
  error?: string | null;
};

export type DeployLinkVerdict = {
  /** true = pengunjung tanpa sesi Vercel melihat aplikasinya (link layak dibagikan). */
  public: boolean;
  /** true = link dikunci Deployment Protection (login Vercel / password). */
  restricted: boolean;
  /** Klasifikasi untuk pesan & penanganan. */
  kind:
    | 'public'
    | 'redirect'
    | 'vercel-authentication'
    | 'restricted'
    | 'not-found'
    | 'deployment-missing'
    | 'empty-deployment'
    | 'server-error'
    | 'unreachable';
  status: number;
  reason: string | null;
};

/**
 * Nilai apakah sebuah link deploy benar-benar bisa dibuka publik.
 *
 * INSIDEN NYATA (Okt 2026): proyek Vercel baru punya **Vercel Authentication
 * (Deployment Protection)** aktif, sehingga URL deploy menjawab 302 ke
 * `vercel.com/sso-api` dan pengunjung yang tidak punya sesi Vercel berhak hanya
 * melihat halaman login/404 — user melaporkannya sebagai "link permanennya error"
 * padahal build-nya sukses. Deteksi ini yang membedakan "link siap dibagikan"
 * dari "link hidup tapi terkunci".
 */
export function judgeDeployLink(probe: DeployLinkProbe): DeployLinkVerdict {
  const status = Number.isFinite(probe.status) ? Math.trunc(probe.status) : 0;
  const location = (probe.location || '').toLowerCase();
  const body = (probe.body || '').toLowerCase();
  const cookie = (probe.setCookie || '').toLowerCase();

  if (status === 0) {
    return {
      public: false,
      restricted: false,
      kind: 'unreachable',
      status,
      reason: probe.error || 'Link deploy tidak bisa dihubungi dari server.',
    };
  }

  const sso =
    location.includes('/sso-api') ||
    location.includes('vercel.com/login') ||
    body.includes('/sso-api?url=') ||
    cookie.includes('_vercel_sso_nonce') ||
    /vercel authentication|authentication required/.test(body);
  if (sso || status === 401 || status === 403) {
    return {
      public: false,
      restricted: true,
      kind: sso ? 'vercel-authentication' : 'restricted',
      status,
      reason: sso
        ? 'Deployment Protection (Vercel Authentication) aktif'
        : 'Link dilindungi password/proteksi Vercel',
    };
  }

  if (status >= 200 && status < 300) {
    return { public: true, restricted: false, kind: 'public', status, reason: null };
  }
  if (status >= 300 && status < 400) {
    return { public: true, restricted: false, kind: 'redirect', status, reason: null };
  }
  if (status === 404) {
    /**
     * Dua jenis 404 Vercel yang BEDA artinya (dibuktikan dari insiden nyata):
     *  - "The deployment could not be found on Vercel" + `DEPLOYMENT_NOT_FOUND`
     *    → hostname itu tidak lagi terhubung ke deployment apa pun.
     *  - "The page could not be found" + `NOT_FOUND` (plain text, SEMUA path
     *    termasuk /favicon.ico) → deployment ADA tapi tidak menyajikan halaman
     *    apa pun: biasanya folder yang dikirim ke Vercel bukan folder aplikasi
     *    (mis. aplikasi hidup di sub-folder) atau folder aplikasinya kosong.
     */
    if (/deployment could not be found|deployment_not_found/i.test(body)) {
      return {
        public: false,
        restricted: false,
        kind: 'deployment-missing',
        status,
        reason: 'Deployment tidak lagi terhubung ke hostname ini (DEPLOYMENT_NOT_FOUND)',
      };
    }
    if (/the page could not be found|page could not be found/i.test(body)) {
      return {
        public: false,
        restricted: false,
        kind: 'empty-deployment',
        status,
        reason: 'Deployment tidak menyajikan halaman apa pun (Vercel: "The page could not be found")',
      };
    }
    return {
      public: false,
      restricted: false,
      kind: 'not-found',
      status,
      reason: /not_found|doesn.t exist/.test(body) ? 'Halaman 404 dari Vercel' : 'Halaman 404',
    };
  }
  return {
    public: false,
    restricted: false,
    kind: 'server-error',
    status,
    reason: `Server menjawab HTTP ${status}`,
  };
}

/** Pesan siap-tampil saat link dikunci Vercel Authentication. */
export function vercelAuthenticationNote(options: { projectName?: string; scope?: string | null } = {}): string {
  const settings = deploymentProtectionSettingsUrl({
    projectName: options.projectName || 'proyek',
    scope: options.scope,
  });
  return (
    'Link ini hidup, tapi terkunci Deployment Protection (Vercel Authentication) — pengunjung lain ' +
    'dibawa ke halaman login Vercel, dan tanpa akun berhak mereka melihat "This page doesn\'t exist" ' +
    '(persis seperti error yang terlihat). Matikan: Vercel → proyek → Settings → Deployment Protection → Vercel Authentication, ' +
    `atau lewat tombol "Matikan proteksi" di panel Preview. ${settings}`
  );
}

/**
 * Pesan siap-tampil untuk user saat link deploy terkunci/masalah, plus langkah
 * perbaikannya. Dipakai UI, log agent, dan tool `deploy`.
 */
export function deployLinkNote(
  verdict: DeployLinkVerdict,
  options: { projectName?: string; scope?: string | null; url?: string | null } = {},
): string | null {
  const settings = deploymentProtectionSettingsUrl({
    projectName: options.projectName || 'proyek',
    scope: options.scope,
  });
  switch (verdict.kind) {
    case 'vercel-authentication':
      return vercelAuthenticationNote(options);
    case 'restricted':
      return `Link ini masih dilindungi (password/proteksi Vercel), jadi belum bisa dibuka pengunjung. Periksa Deployment Protection: ${settings}`;
    case 'deployment-missing':
      return (
        'Hostname ini tidak lagi terhubung ke deployment apa pun (Vercel: DEPLOYMENT_NOT_FOUND / ' +
        '"The deployment could not be found"). Jalankan deploy lagi — kalau tetap, buka proyeknya di dashboard Vercel ' +
        'dan pastikan deployment produksinya ada & sehat.'
      );
    case 'empty-deployment':
      return (
        'Deployment berhasil dibuat, TAPI tidak menyajikan halaman apa pun: Vercel menjawab "The page could not be found" ' +
        'untuk SEMUA alamat (termasuk /favicon.ico). Penyebab tersering: folder yang dikirim ke Vercel bukan folder aplikasi ' +
        '(mis. aplikasi ada di sub-folder sementara akar proyeknya kosong), atau file aplikasinya sudah tidak ada di sandbox. ' +
        'Periksa folder aplikasi (harus ada package.json atau index.html) lalu deploy lagi.'
      );
    case 'not-found':
      return 'Halaman ini tidak ada di aplikasi yang dideploy (404 dari aplikasi), jadi pengunjung melihat halaman 404. Periksa alamat awalnya lalu deploy lagi.';
    case 'server-error':
      return `Deployment menjawab HTTP ${verdict.status}. Cek log build di dashboard Vercel.`;
    case 'unreachable':
      return `Link deploy belum bisa dihubungi dari server${verdict.reason ? ` (${verdict.reason})` : ''}. Coba buka langsung; kalau tetap gagal, deploy ulang.`;
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Menemukan FOLDER APLIKASI di dalam sandbox                                   */
/* -------------------------------------------------------------------------- */

export type AppDirCandidate = {
  /** Path absolut folder yang berisi tanda aplikasi (package.json/index.html). */
  dir: string;
  /** Jumlah file di folder itu (tanpa node_modules/.next). */
  files: number;
};

export type AppDirScan = {
  /** true = folder akar proyek sendiri sudah berisi package.json/index.html. */
  rootHasApp: boolean;
  /** Folder-folder calon (kedalaman 1-2) yang berisi tanda aplikasi. */
  candidates: AppDirCandidate[];
  /** true = perintah pemindaian gagal dijalankan (jangan menyimpulkan apa pun). */
  failed: boolean;
};

/**
 * Skrip pemindaian folder aplikasi (dijalankan DI DALAM sandbox, satu perintah).
 *
 * Latar belakang insiden nyata: aplikasi user sering dibuat di SUB-FOLDER
 * (`/home/user/project/sistem-kasir`) sementara tombol Deploy mengirim folder
 * akarnya. Vercel membangun "situs kosong" yang menjawab 404 ("The page could
 * not be found") di SEMUA alamat — user melihatnya sebagai "link permanen error"
 * padahal CLI melaporkan sukses.
 */
export function buildAppDirScanScript(root: string): string {
  const dir = shellSingleQuote(root);
  return `
set -u
ROOT=${dir}
cd "$ROOT" 2>/dev/null || { echo "__AC_NO_ROOT__"; exit 0; }
is_app() { [ -f "$1/package.json" ] || [ -f "$1/index.html" ] || [ -f "$1/index.htm" ] || ls "$1"/*.html >/dev/null 2>&1; }
count_files() { find "$1" -type f -not -path '*/node_modules/*' -not -path '*/.next/*' -not -path '*/.git/*' 2>/dev/null | wc -l | tr -d ' '; }
if is_app "$ROOT"; then echo "__AC_ROOT_APP__ $(count_files "$ROOT")"; fi
for d in "$ROOT"/*/; do
  [ -d "$d" ] || continue
  case "$d" in */node_modules/|*/.next/|*/.git/|*/dist/|*/build/|*/.vercel/|*/coverage/) continue;; esac
  if is_app "$d"; then echo "__AC_CAND__ \${d%/} $(count_files "$d")"; fi
  for d2 in "$d"*/; do
    [ -d "$d2" ] || continue
    case "$d2" in */node_modules/|*/.next/|*/.git/|*/dist/|*/build/|*/.vercel/|*/coverage/) continue;; esac
    if is_app "$d2"; then echo "__AC_CAND__ \${d2%/} $(count_files "$d2")"; fi
  done
done
`.trim();
}

function shellSingleQuote(value: string): string {
  return `'${(value || '').replace(/'/g, `'\\''`)}'`;
}

/** Baca keluaran skrip pemindaian. */
export function parseAppDirScan(output: string): AppDirScan {
  const text = output || '';
  if (text.includes('__AC_NO_ROOT__')) return { rootHasApp: false, candidates: [], failed: true };
  let rootHasApp = false;
  const candidates: AppDirCandidate[] = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const rootMatch = line.match(/^__AC_ROOT_APP__\s+(\d+)?/);
    if (rootMatch) {
      rootHasApp = true;
      continue;
    }
    const candMatch = line.match(/^__AC_CAND__\s+(\S+)\s+(\d+)?/);
    if (candMatch) candidates.push({ dir: candMatch[1], files: Number(candMatch[2] ?? 0) || 0 });
  }
  return { rootHasApp, candidates, failed: false };
}

/**
 * Pilih folder yang akan dikirim ke Vercel.
 *
 * Urutan keputusan (dari yang paling pasti):
 *  1. folder tempat dev server terakhir dijalankan (catatan registry di sandbox) —
 *     itu BUKTI aplikasinya hidup di sana, bukan tebakan;
 *  2. folder akar proyek, kalau akarnya memang berisi aplikasi;
 *  3. satu-satunya folder calon;
 *  4. folder calon dengan file terbanyak (kasus banyak sub-proyek).
 * Mengembalikan null kalau tidak ada tanda aplikasi sama sekali — pemanggil
 * sebaiknya memperingatkan user alih-alih mengirim folder kosong ke Vercel.
 */
export function chooseAppDir(input: {
  scan: AppDirScan;
  root: string;
  /** cwd dev server yang pernah dicatat di sandbox (paling dipercaya). */
  registryCwds?: string[];
}): { dir: string; source: 'registry' | 'root' | 'candidate'; files: number; note: string } | null {
  const { scan, root } = input;
  if (scan.failed) return null;
  const registry = (input.registryCwds ?? []).filter(Boolean);
  const normalize = (p: string) => p.replace(/\/+$/, '');
  const rootPath = normalize(root);
  const candidates = scan.candidates.map((c) => ({ ...c, dir: normalize(c.dir) }));

  for (const cwd of registry.map(normalize)) {
    if (cwd === rootPath && scan.rootHasApp) {
      return { dir: rootPath, source: 'registry', files: 0, note: `folder aplikasi = folder akar proyek (tempat dev server dijalankan: ${cwd})` };
    }
    const hit = candidates.find((c) => c.dir === cwd);
    if (hit) {
      return { dir: hit.dir, source: 'registry', files: hit.files, note: `folder aplikasi terdeteksi dari catatan dev server: ${hit.dir}` };
    }
  }

  if (scan.rootHasApp && candidates.length === 0) {
    return { dir: rootPath, source: 'root', files: 0, note: 'folder akar proyek sudah berisi aplikasi' };
  }
  if (!scan.rootHasApp && candidates.length === 1) {
    return {
      dir: candidates[0].dir,
      source: 'candidate',
      files: candidates[0].files,
      note: `aplikasi ada di sub-folder: ${candidates[0].dir} (folder akar proyek tidak berisi aplikasi)`,
    };
  }
  if (scan.rootHasApp) {
    return { dir: rootPath, source: 'root', files: 0, note: 'folder akar proyek dipakai (ada juga sub-folder berisi aplikasi)' };
  }
  if (candidates.length > 1) {
    const best = [...candidates].sort((a, b) => b.files - a.files)[0];
    return {
      dir: best.dir,
      source: 'candidate',
      files: best.files,
      note: `beberapa sub-folder berisi aplikasi (${candidates.map((c) => c.dir).join(', ')}); dipakai yang file-nya terbanyak: ${best.dir}`,
    };
  }
  return null;
}

/** Baris error khas CLI Vercel. */
const ERROR_PATTERNS: RegExp[] = [
  /^Error:/i,
  /Invalid token/i,
  /not authorized/i,
  /The specified token is not valid/i,
  /No more than .* deployments/i,
  /Command failed/i,
  /npm ERR!/i,
  /ENOENT/i,
  /Failed to compile/i,
  /Module not found/i,
  /Cannot find module/i,
  /exited with \d+/i,
];

/**
 * Blok "saran langkah berikutnya" yang dicetak CLI SETELAH deployment gagal
 * dibangun. Keberadaannya adalah tanda kegagalan, bukan tanda sukses.
 */
const GUIDANCE_MARKERS: RegExp[] = [
  /Create a new deployment from the same source:/i,
  /View build logs:/i,
  /Check the production response:/i,
];

/**
 * Error yang PASTI mengakhiri deploy (bukan peringatan sementara), sehingga bisa
 * dilaporkan gagal walau penanda akhir proses belum sempat terbaca.
 */
const TERMINAL_ERROR_PATTERNS: RegExp[] = [
  /invalid token/i,
  /The specified token is not valid/i,
  /not authorized/i,
  /No more than .* deployments/i,
];

export function looksLikeFailureGuidance(text: string): boolean {
  return GUIDANCE_MARKERS.filter((re) => re.test(text)).length >= 2;
}

/** Baris yang paling menjelaskan penyebab kegagalan. */
export function failureLine(text: string): string | null {
  const lines = (text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (ERROR_PATTERNS.some((re) => re.test(lines[i]))) return lines[i];
  }
  return null;
}

/** Baca penanda akhir proses dari log. */
export function readExitCode(text: string): number | null {
  const match = (text || '').match(new RegExp(`${DEPLOY_EXIT_PREFIX}\\s*(-?\\d+)`));
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isFinite(code) ? code : null;
}

/**
 * Nilai status deploy dari isi log.
 *
 * Tanda selesai yang dipakai (berurutan): penanda akhir proses
 * (`__AC_DEPLOY_EXIT__`), lalu baris hasil `Production:`/`Preview:`/`✅` untuk
 * kompatibilitas. Selama tidak ada keduanya dan proses belum berakhir → 'running'.
 */
export function parseDeployStatus(
  log: string,
  options: { token?: string | null; projectName?: string } = {},
): DeployStatus {
  const text = redactSecrets(log || '', options.token);
  const urls = extractDeployUrls(text);
  if (!text.trim()) return { state: 'running', url: null, urls: [], error: null };

  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const tail = lines.slice(-18).join('\n');
  const exitCode = readExitCode(text);
  const permanent = permanentUrlFromLog(text);

  if (exitCode === null) {
    // Belum ada penanda akhir proses: pakai baris hasil CLI (kompatibilitas —
    // barisnya sering diawali simbol seperti "✅"), lalu blok saran CLI sebagai
    // tanda kegagalan, dan terakhir error yang sifatnya final (token ditolak).
    if (permanent) return { state: 'done', url: permanent, urls, error: null };
    if (looksLikeFailureGuidance(tail) || TERMINAL_ERROR_PATTERNS.some((re) => re.test(text))) {
      return { state: 'failed', url: null, urls, error: failureLine(text) ?? 'Deployment gagal dibangun di sisi Vercel.' };
    }
    return { state: 'running', url: null, urls, error: null };
  }

  // Proses sudah berakhir.
  if (exitCode === 0) {
    return { state: 'done', url: permanent ?? urls[0] ?? null, urls, error: null };
  }
  return {
    state: 'failed',
    url: null,
    urls,
    error: failureLine(text) ?? `CLI Vercel berhenti dengan kode ${exitCode}.`,
  };
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
  if (/Failed to compile|Module not found|Cannot find module|exited with \d+|build failed|Command \"npm run build\"/i.test(text)) {
    return (
      `Vercel gagal MEMBANGUN aplikasi: ${text}. ` +
      'Jalankan `npm run build` di sandbox untuk mereproduksi kegagalannya, perbaiki penyebabnya (biasanya paket yang belum ada di package.json atau error TypeScript), lalu deploy lagi.'
    );
  }
  return text;
}
