import type { Sandbox } from '@e2b/code-interpreter';
import { SANDBOX_PROJECT_DIR } from '@/lib/config';
import {
  BROWSER_DIR,
  BROWSER_MARKER,
  BROWSER_SCRIPT_PATH,
  BROWSER_SHOT_PATH,
  browserScript,
  judgeReport,
  parseBrowserReport,
  summarizeBrowserReport,
  viewportFor,
} from '@/lib/sandbox/browser';
import {
  decideServerReadiness,
  detectFrameworkFromPackageJson,
  evaluatePublicProbe,
  hostOverrideFor,
  parseListenScope,
  parseReadiness,
  parseServerRegistry,
  serializeServerRegistry,
  type FrameworkHint,
  type ListenScope,
  type PublicProbe,
  type Readiness,
  type ServerRecord,
} from '@/lib/sandbox/preview-status';
import {
  detectPreviewIssue,
  packageManagerFromLockfile,
  summarizeIssue,
  type PackageManager,
  type PreviewIssue,
} from '@/lib/sandbox/diagnostics';
import {
  DEPLOY_LOG_PATH,
  DEPLOY_POLL_MS,
  DEPLOY_TIMEOUT_MS,
  VERCEL_MARKER,
  buildDeployCommand,
  deployShellCommand,
  explainDeployError,
  parseDeployStatus,
  redactSecrets,
  type DeployState,
  type DeployStatus,
} from '@/lib/deploy/vercel';
import { humanSize, joinSandboxPath, normalize, relPath, truncate } from '@/lib/util';

export type ToolContext = {
  sandbox: Sandbox;
  sandboxId: string;
  /** Callback untuk meneruskan output terminal ke UI secara live. */
  onOutput?: (text: string) => void;
  /**
   * Kredensial deploy milik user (dari Settings, dibaca server-side).
   * Agent TIDAK pernah melihat nilainya — hanya hasil deploy-nya.
   */
  deploy?: { token: string; scope: string; projectName?: string };
};

export type ToolResult = {
  ok: boolean;
  output: string;
  previewUrl?: string;
  port?: number;
  /**
   * Screenshot hasil `browser_check` (data URL JPEG). Dikirim ke model HANYA
   * kalau modelnya mendukung gambar; UI menampilkannya selama sesi berjalan.
   */
  image?: { dataUrl: string; caption: string };
};

export type FileEntry = { path: string; name: string; type: 'file' | 'dir'; size: number };

const MAX_OUTPUT = 8_000;
const SKIP_DIRS = ['node_modules', '.git', '.next', 'dist', 'build', '.cache', '__pycache__', '.venv', '.turbo', 'coverage'];

/** Registry proses background per sandbox (agar bisa distop / ditampilkan di UI). */
const globalForTools = globalThis as unknown as {
  __acServers?: Map<string, Map<number, { pid: number; command: string; startedAt: number }>>;
};

function servers(sandboxId: string): Map<number, { pid: number; command: string; startedAt: number }> {
  if (!globalForTools.__acServers) globalForTools.__acServers = new Map();
  let map = globalForTools.__acServers.get(sandboxId);
  if (!map) {
    map = new Map();
    globalForTools.__acServers.set(sandboxId, map);
  }
  return map;
}

export function listServers(sandboxId: string): Array<{ port: number; pid: number; command: string; startedAt: number }> {
  return [...servers(sandboxId).entries()].map(([port, info]) => ({ port, ...info }));
}

/* -------------------------------------------------------------------------- */
/* Path & command guards                                                      */
/* -------------------------------------------------------------------------- */

export function resolvePath(input: string): string {
  const raw = (input || '').trim();
  if (!raw) return SANDBOX_PROJECT_DIR;
  if (raw.startsWith('/')) {
    const abs = normalize(raw);
    if (abs.startsWith('/home/user')) return abs;
    throw new Error(`Path di luar area kerja tidak diizinkan: ${input}. Gunakan path relatif terhadap ${SANDBOX_PROJECT_DIR}.`);
  }
  return joinSandboxPath(SANDBOX_PROJECT_DIR, raw);
}

const DANGEROUS = [
  /rm\s+(-[a-zA-Z]*\s+)*\/(\s|$)/,
  /rm\s+(-[a-zA-Z]*\s+)*\/home\/user\s*$/m,
  /\bmkfs(\.\w+)?\b/,
  /\b(shutdown|reboot|poweroff|halt)\b/,
  /:\(\)\s*\{.*\};\s*:/,
  /dd\s+if=.*of=\/dev\//,
];

export function assertSafeCommand(command: string): void {
  for (const pattern of DANGEROUS) {
    if (pattern.test(command)) {
      throw new Error(`Perintah ditolak oleh pengaman sandbox: ${command}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Operasi inti sandbox                                                       */
/* -------------------------------------------------------------------------- */

export type CommandOutcome = { ok: boolean; stdout: string; stderr: string; exitCode: number | null };

export async function runCommand(
  sandbox: Sandbox,
  command: string,
  options: { cwd?: string; timeoutMs?: number; onOutput?: (text: string) => void } = {},
): Promise<CommandOutcome> {
  assertSafeCommand(command);
  const result = await sandbox.commands.run(command, {
    cwd: options.cwd || SANDBOX_PROJECT_DIR,
    timeoutMs: options.timeoutMs ?? 120_000,
    onStdout: options.onOutput ? (chunk) => options.onOutput?.(chunk) : undefined,
    onStderr: options.onOutput ? (chunk) => options.onOutput?.(chunk) : undefined,
  });
  const exitCode = typeof result.exitCode === 'number' ? result.exitCode : result.error ? 1 : 0;
  return { ok: exitCode === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? result.error ?? '', exitCode };
}

export async function listProjectFiles(sandbox: Sandbox, subPath?: string): Promise<FileEntry[]> {
  const root = subPath ? resolvePath(subPath) : SANDBOX_PROJECT_DIR;
  const prune = SKIP_DIRS.map((d) => `-name ${d}`).join(' -o ');
  const command = `
cd ${shellQuote(root)} 2>/dev/null || { echo "__MISSING__"; exit 0; }
find . -maxdepth 4 \\( ${prune} \\) -prune -o -printf '%y\\t%s\\t%p\\n' 2>/dev/null | head -600
`.trim();
  const res = await runCommand(sandbox, command, { cwd: '/', timeoutMs: 60_000 });
  const out = res.stdout || '';
  if (out.includes('__MISSING__')) return [];
  const entries: FileEntry[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [type, size, ...rest] = line.split('\t');
    const p = rest.join('\t');
    if (!p || p === '.') continue;
    const rel = p.replace(/^\.\//, '');
    entries.push({
      path: rel,
      name: rel.split('/').pop() || rel,
      type: type === 'd' ? 'dir' : 'file',
      size: Number.parseInt(size ?? '0', 10) || 0,
    });
  }
  return entries;
}

export async function readProjectFile(sandbox: Sandbox, path: string): Promise<{ path: string; content: string; size: number }> {
  const abs = resolvePath(path);
  try {
    const content = await sandbox.files.read(abs);
    return { path: relPath(abs, SANDBOX_PROJECT_DIR), content: String(content), size: String(content).length };
  } catch (err) {
    throw new Error(`Gagal membaca ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function writeProjectFile(sandbox: Sandbox, path: string, content: string): Promise<{ path: string; bytes: number }> {
  const abs = resolvePath(path);
  const dir = abs.slice(0, abs.lastIndexOf('/')) || SANDBOX_PROJECT_DIR;
  if (dir) {
    await runCommand(sandbox, `mkdir -p ${shellQuote(dir)}`, { cwd: '/', timeoutMs: 30_000 });
  }
  await sandbox.files.write(abs, content);
  return { path: relPath(abs, SANDBOX_PROJECT_DIR), bytes: Buffer.byteLength(content, 'utf8') };
}

/**
 * Catatan server yang pernah dijalankan, disimpan DI DALAM sandbox.
 *
 * Kenapa di sandbox, bukan di database/memori server: (1) bertahan saat sandbox
 * di-pause lalu bangun (memory+disk disimpan E2B), padahal proses server
 * aplikasi ini bisa berganti (serverless); (2) otomatis ikut terhapus saat
 * sandbox dibunuh, jadi tidak ada catatan basi yang menunjuk sandbox lain.
 */
export const SERVER_REGISTRY_PATH = '/home/user/.agentcloud-servers.json';

export async function readServerRegistry(sandbox: Sandbox): Promise<ServerRecord[]> {
  try {
    const raw = await sandbox.files.read(SERVER_REGISTRY_PATH);
    return parseServerRegistry(typeof raw === 'string' ? raw : String(raw));
  } catch {
    return [];
  }
}

async function writeServerRegistry(sandbox: Sandbox, records: ServerRecord[]): Promise<void> {
  try {
    await sandbox.files.write(SERVER_REGISTRY_PATH, serializeServerRegistry(records));
  } catch {
    /* registry hanya untuk pemulihan otomatis - jangan gagalkan start server */
  }
}

/**
 * Catat bahwa sebuah perintah server BARU dijalankan di port ini.
 *
 * Ditulis SAAT peluncuran (bukan hanya setelah server terbukti siap) karena dua
 * hal penting bergantung padanya:
 *  1. Masa tenggang pemulihan otomatis (`STARTUP_GRACE_MS`) — tanpa catatan ini,
 *     polling Preview akan menganggap "belum ada server" lalu membunuh proses
 *     yang sedang kompilasi dan mengulanginya terus.
 *  2. `readyAt: null` menandai peluncuran ini belum pernah terbukti siap.
 */
export async function markServerLaunched(
  sandbox: Sandbox,
  record: { port: number; command: string; cwd?: string },
): Promise<void> {
  const records = await readServerRegistry(sandbox);
  await writeServerRegistry(sandbox, [
    ...records.filter((r) => r.port !== record.port),
    { port: record.port, command: record.command, cwd: record.cwd ?? '', startedAt: Date.now(), readyAt: null },
  ]);
}

/** Tandai server ini benar-benar sudah melayani URL publik (untuk peluncuran ini). */
export async function markServerReady(sandbox: Sandbox, port: number): Promise<void> {
  const records = await readServerRegistry(sandbox);
  const found = records.find((r) => r.port === port);
  if (!found || found.readyAt) return;
  await writeServerRegistry(sandbox, records.map((r) => (r.port === port ? { ...r, readyAt: Date.now() } : r)));
}

async function forgetServer(sandbox: Sandbox, port: number): Promise<void> {
  const records = await readServerRegistry(sandbox);
  if (!records.some((r) => r.port === port)) return;
  await writeServerRegistry(sandbox, records.filter((r) => r.port !== port));
}

/**
 * Cek port dari DALAM sandbox: status HTTP di localhost + alamat bind yang
 * sebenarnya. Bind hanya ke 127.0.0.1 adalah penyebab nomor satu URL preview
 * E2B menjawab "Closed Port Error", jadi hasilnya dipakai untuk mendiagnosa.
 */
export async function probeLocalPort(
  sandbox: Sandbox,
  port: number,
): Promise<{ code: string; scope: ListenScope }> {
  const script = `
code=$(curl -s -o /dev/null -m 4 -w "%{http_code}" http://127.0.0.1:${port}/ 2>/dev/null || echo 000)
echo "CODE \${code}"
if command -v ss >/dev/null 2>&1 || command -v netstat >/dev/null 2>&1; then
  echo "SCAN ok"
  (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | awk 'NR>1 {print $4}' | grep -E "[:.]${port}\$" || true
else
  echo "SCAN unavailable"
fi
`.trim();
  const res = await runCommand(sandbox, script, { cwd: '/', timeoutMs: 25_000 });
  const out = res.stdout || '';
  const code = out.match(/CODE\s+(\d{3})/)?.[1] ?? '000';
  const scope: ListenScope = out.includes('SCAN unavailable')
    ? 'unknown'
    : parseListenScope(out.replace(/CODE\s+\d{3}/, '').replace(/SCAN ok/, ''), port);
  return { code, scope };
}

/** Cek URL preview publik (dari sisi server aplikasi ini, bukan dari sandbox). */
export async function probePublicUrl(url: string, timeoutMs = 6_000): Promise<PublicProbe> {
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'agentcloud-preview-probe' },
    });
    const body = await res.text().catch(() => '');
    // Halaman error dev server (mis. "Failed to compile") bisa panjang; potongannya
    // diperbesar supaya pesan "Module not found" + nama paketnya ikut terbaca.
    return evaluatePublicProbe(res.status, body.slice(0, 16_000));
  } catch {
    return evaluatePublicProbe(0, '');
  }
}

/**
 * Tebak package manager dari lockfile di folder proyek.
 * Dipakai HANYA saat menyusun saran perintah perbaikan (jarang), jadi satu
 * perintah shell sudah cukup.
 */
export async function detectPackageManager(sandbox: Sandbox, cwd: string): Promise<PackageManager> {
  try {
    const res = await runCommand(
      sandbox,
      'for f in pnpm-lock.yaml yarn.lock bun.lockb bun.lock package-lock.json; do [ -f "$f" ] && echo "$f"; done',
      { cwd, timeoutMs: 20_000 },
    );
    return packageManagerFromLockfile((res.stdout || '').split('\n'));
  } catch {
    return 'npm';
  }
}

/**
 * Skrip penunggu: selesai lebih cepat kalau prosesnya sudah mati (bukan menunggu
 * buta). Jendela tunggunya sengaja cukup panjang (±35 detik) karena dev server
 * pertama kali di sandbox dingin (unduh dependency + kompilasi) bisa jauh lebih
 * lambat daripada localhost biasa — dulu 20 detik, dan habisnya jendela itu
 * dilaporkan sebagai "server tidak siap" sehingga agent/panel Preview menjalankan
 * ulang server yang sebenarnya sedang menyala.
 */
export function readinessScript(port: number, pid?: number): string {
  const alive = pid ? `if ! kill -0 ${pid} 2>/dev/null; then echo "DEAD"; exit 2; fi` : '';
  return `
for i in $(seq 1 70); do
  ${alive}
  code=$(curl -s -o /dev/null -m 2 -w "%{http_code}" http://127.0.0.1:${port}/ 2>/dev/null || echo 000)
  if [ "$code" != "000" ] && [ -n "$code" ]; then echo "READY $code"; exit 0; fi
  sleep 0.5
done
echo "TIMEOUT"
exit 1
`.trim();
}

/** Baca package.json di folder kerja server untuk menebak framework-nya. */
export async function readFrameworkHint(sandbox: Sandbox, cwd: string): Promise<FrameworkHint> {
  try {
    const raw = await sandbox.files.read(`${cwd.replace(/\/$/, '')}/package.json`);
    return detectFrameworkFromPackageJson(typeof raw === 'string' ? raw : String(raw));
  } catch {
    return null;
  }
}

export type StartServerOutcome = {
  previewUrl: string;
  /** true HANYA kalau URL publik benar-benar melayani aplikasi user. */
  ready: boolean;
  logs: string;
  reason: string | null;
  warning: string | null;
  command: string;
  /** true = perintah dijalankan ulang dengan flag bind 0.0.0.0. */
  rebound: boolean;
  localCode: string;
  listenScope: ListenScope;
  publicStatus: string;
  /** Halaman error kompilasi (mis. modul belum terpasang) yang menghalangi preview. */
  issue?: PreviewIssue | null;
};

type LaunchAttempt = {
  readiness: Readiness;
  localCode: string;
  listenScope: ListenScope;
  publicProbe: PublicProbe;
  logs: string;
};

/**
 * Jalankan dev/preview server di background, lalu PASTIKAN benar-benar bisa
 * dipakai lewat URL publik E2B.
 *
 * Tidak cukup `curl 127.0.0.1` dari dalam sandbox: server yang hanya listen di
 * loopback menjawab 200 di situ, sementara proxy E2B (di luar network namespace
 * sandbox) menolak dengan "Closed Port Error". Karena itu kesiapan dinilai dari
 * URL publik; kalau ternyata cuma loopback, perintah dicoba ulang sekali dengan
 * flag bind 0.0.0.0 yang sesuai framework-nya.
 */
export async function startServer(
  sandbox: Sandbox,
  command: string,
  port: number,
  options: {
    cwd?: string;
    onOutput?: (text: string) => void;
    probePublic?: (url: string) => Promise<PublicProbe>;
  } = {},
): Promise<StartServerOutcome> {
  assertSafeCommand(command);
  const cwd = options.cwd || SANDBOX_PROJECT_DIR;
  const probePublic = options.probePublic ?? ((target: string) => probePublicUrl(target));
  const url = previewAddress(sandbox, port);

  await stopServer(sandbox, port).catch(() => undefined);

  const launch = async (cmd: string): Promise<LaunchAttempt> => {
    const handle = await sandbox.commands.run(cmd, {
      background: true,
      cwd,
      onStdout: options.onOutput ? (chunk) => options.onOutput?.(chunk) : undefined,
      onStderr: options.onOutput ? (chunk) => options.onOutput?.(chunk) : undefined,
    });
    servers(sandbox.sandboxId).set(port, { pid: handle.pid, command: cmd, startedAt: Date.now() });
    // Catat SEGERA (bukan hanya kalau siap): inilah penanda "server sedang
    // dinyalakan" yang dipakai pemulihan otomatis untuk menunggu, bukan
    // membunuh lalu menjalankan ulang proses yang sedang kompilasi.
    await markServerLaunched(sandbox, { port, command: cmd, cwd });

    const probe = await runCommand(sandbox, readinessScript(port, handle.pid), { cwd: '/', timeoutMs: 120_000 });
    const readiness = parseReadiness(`${probe.stdout}\n${probe.stderr}`);

    await new Promise((r) => setTimeout(r, 500));
    const logs = truncate([handle.stdout, handle.stderr].filter(Boolean).join('\n'), 4_000);

    if (readiness.state === 'dead' || readiness.state === 'timeout') {
      return {
        readiness,
        localCode: '000',
        listenScope: 'none',
        publicProbe: { status: '000', online: false, proxyError: false },
        logs,
      };
    }

    const local = await probeLocalPort(sandbox, port);
    const publicProbe = await probePublic(url);
    return { readiness, localCode: local.code, listenScope: local.scope, publicProbe, logs };
  };

  let currentCommand = command;
  let attempt = await launch(currentCommand);
  let rebound = false;

  // Server hidup tapi hanya listen di loopback → coba sekali lagi dengan bind 0.0.0.0.
  // Framework ditebak dari package.json supaya perintah generik seperti
  // `npm run dev` pun bisa ditambal.
  if (
    !attempt.publicProbe.online &&
    attempt.localCode !== '000' &&
    attempt.listenScope !== 'all' &&
    attempt.readiness.state !== 'dead'
  ) {
    const framework = await readFrameworkHint(sandbox, cwd);
    const override = hostOverrideFor(currentCommand, framework);
    if (override) {
      await stopServer(sandbox, port).catch(() => undefined);
      currentCommand = override;
      attempt = await launch(currentCommand);
      rebound = true;
    }
  }

  // Paket manager hanya perlu dideteksi kalau ada masalah paket yang hilang —
  // supaya tidak menambah perintah shell pada jalur normal.
  const probeIssue =
    attempt.publicProbe.issue ??
    detectPreviewIssue({ status: Number(attempt.publicProbe.status), log: attempt.logs });
  const packageManager = probeIssue?.packages.length ? await detectPackageManager(sandbox, cwd) : undefined;

  const decision = decideServerReadiness({
    localCode: attempt.localCode,
    listenScope: attempt.listenScope,
    publicProbe: attempt.publicProbe,
    packageManager,
  });

  /**
   * Bedakan "prosesnya mati" dari "prosesnya masih menyala tapi lambat".
   * Tanpa pembedaan ini agent menerima pesan "server mati" lalu menjalankan
   * `start_server` lagi — yang membunuh proses yang sedang kompilasi dan
   * mengulanginya dari nol (penyebab preview tampak "selalu rusak").
   */
  const stillStarting =
    !decision.ready && !decision.issue && attempt.readiness.state === 'timeout' && attempt.publicProbe.status === '000';
  const reason = stillStarting
    ? 'Perintah server sudah dijalankan dan prosesnya masih hidup, tetapi belum mendengarkan di port ini. ' +
      'Server pertama kali di sandbox dingin (unduh dependency + kompilasi) bisa butuh waktu lebih — ' +
      'JANGAN dijalankan ulang, tunggu lalu cek lagi (panel Preview memeriksa otomatis).'
    : decision.reason;

  if (decision.ready) {
    await markServerReady(sandbox, port);
  } else if (attempt.readiness.state === 'dead') {
    // Prosesnya benar-benar mati (mis. modul tidak ditemukan) → jangan simpan
    // perintahnya: pemulihan otomatis berikutnya hanya akan mengulangi kegagalan
    // yang sama.
    await forgetServer(sandbox, port);
  }
  // TIMEOUT (belum listen, tapi proses masih hidup) → catatan DIBIARKAN, supaya
  // (a) pemulihan otomatis menunggu masa tenggang alih-alih menjalankan ulang,
  // dan (b) server yang akhirnya siap tetap punya catatan untuk dihidupkan lagi
  // setelah sandbox di-pause.

  return {
    previewUrl: url,
    ready: decision.ready,
    logs: attempt.logs,
    reason,
    warning: decision.warning,
    command: currentCommand,
    rebound,
    localCode: attempt.localCode,
    listenScope: attempt.listenScope,
    publicStatus: attempt.publicProbe.status,
    issue: decision.issue ?? null,
  };
}

export type ReviveOutcome = {
  /** false = tidak ada catatan perintah untuk port ini (tidak ada yang bisa dijalankan ulang). */
  attempted: boolean;
  ready: boolean;
  previewUrl: string;
  port: number;
  command: string | null;
  logs: string;
  reason: string | null;
  issue?: PreviewIssue | null;
};

/**
 * Hidupkan ulang dev server dari catatan perintah terakhir di sandbox.
 *
 * Ini yang membuat panel Preview "sembuh sendiri": setelah sandbox di-pause
 * lama (proses dev server hilang saat bangun) atau setelah sandbox cold-boot,
 * membuka/menyegarkan Preview akan menjalankan ulang servernya.
 */
export async function reviveServer(
  sandbox: Sandbox,
  port: number,
  options: { onOutput?: (text: string) => void; probePublic?: (url: string) => Promise<PublicProbe> } = {},
): Promise<ReviveOutcome> {
  const url = previewAddress(sandbox, port);
  const record = (await readServerRegistry(sandbox)).find((r) => r.port === port);
  if (!record) {
    return { attempted: false, ready: false, previewUrl: url, port, command: null, logs: '', reason: null };
  }

  const started = await startServer(sandbox, record.command, port, {
    cwd: record.cwd || SANDBOX_PROJECT_DIR,
    onOutput: options.onOutput,
    probePublic: options.probePublic,
  });

  return {
    attempted: true,
    ready: started.ready,
    previewUrl: started.previewUrl,
    port,
    command: started.command,
    logs: started.logs,
    reason: started.reason,
    issue: started.issue ?? null,
  };
}

export async function stopServer(sandbox: Sandbox, port: number): Promise<boolean> {
  const info = servers(sandbox.sandboxId).get(port);
  let killed = false;
  if (info) {
    try {
      killed = await sandbox.commands.kill(info.pid);
    } catch {
      killed = false;
    }
    servers(sandbox.sandboxId).delete(port);
  }
  // Sapu bersih sisa proses yang masih memegang port.
  await runCommand(
    sandbox,
    `(which fuser >/dev/null 2>&1 && fuser -k ${port}/tcp 2>/dev/null) || (pkill -f "PORT=${port}" 2>/dev/null) || true`,
    { cwd: '/', timeoutMs: 20_000 },
  );
  await forgetServer(sandbox, port);
  return killed;
}

export function previewAddress(sandbox: Sandbox, port: number): string {
  return `https://${sandbox.getHost(port)}`;
}

/* -------------------------------------------------------------------------- */
/* Deploy ke Vercel (link permanen, bukan sandbox)                             */
/* -------------------------------------------------------------------------- */

/**
 * Pastikan CLI Vercel tersedia di sandbox (sekali per sandbox, ditandai penanda
 * yang bertahan saat sandbox di-pause).
 *
 * Instalasinya ringan (npx mengunduh paketnya), jadi penanda ini terutama
 * berguna agar tidak mengunduh ulang setiap kali user menekan Deploy.
 */
export async function ensureVercel(
  sandbox: Sandbox,
  onOutput?: (text: string) => void,
): Promise<{ ok: boolean; message: string }> {
  const script = `
set -u
MARKER=${VERCEL_MARKER}
if [ -f "$MARKER" ] && npx --yes vercel@latest --version >/dev/null 2>&1; then
  echo "__AC_VERCEL_READY__ penanda $(npx --yes vercel@latest --version 2>/dev/null | head -1)"
  exit 0
fi
echo "Menyiapkan Vercel CLI (sekali per sandbox)..."
if npx --yes vercel@latest --version >/dev/null 2>&1; then
  mkdir -p "$(dirname "$MARKER")" 2>/dev/null || true
  touch "$MARKER" 2>/dev/null || true
  echo "__AC_VERCEL_READY__ baru"
  exit 0
fi
echo "__AC_VERCEL_FAIL__ CLI Vercel tidak bisa dijalankan di sandbox ini"
exit 1
`.trim();

  const res = await runCommand(sandbox, script, { cwd: '/', timeoutMs: 240_000 }).catch((err) => ({
    ok: false,
    stdout: '',
    stderr: err instanceof Error ? err.message : String(err),
    exitCode: null,
  }));
  const out = `${res.stdout}\n${res.stderr}`.trim();
  onOutput?.(out);

  // Sama seperti ensureBrowser: kesiapan ditentukan token eksplisit, bukan exit code.
  if (out.includes('__AC_VERCEL_READY__')) {
    return { ok: true, message: out.includes('penanda') ? 'Vercel CLI siap (penanda)' : 'Vercel CLI siap' };
  }
  const reason = out.match(/__AC_VERCEL_FAIL__\s*(.*)/)?.[1]?.trim();
  return {
    ok: false,
    message: reason ? `Vercel CLI gagal disiapkan: ${reason}` : 'Vercel CLI belum siap — coba Deploy lagi.',
  };
}

export type DeployOutcome = {
  state: DeployState;
  url: string | null;
  log: string;
  error: string | null;
  /** Perintah yang dijalankan (tanpa token). */
  command: string;
  /** true = deploy masih berjalan saat batas tunggu request tercapai. */
  timedOut: boolean;
};

/**
 * Deploy folder proyek ke akun Vercel user dan kembalikan link permanennya.
 *
 * Dijalankan sebagai proses LATAR di sandbox dengan keluaran ke file log:
 * deploy bisa lebih lama daripada batas durasi satu request hosting, dan dengan
 * cara ini prosesnya tidak ikut terbunuh — pemanggilan berikutnya cukup
 * MELANJUTKAN membaca log yang sama (lihat `timedOut`).
 */
export async function deployToVercel(
  sandbox: Sandbox,
  options: {
    token: string;
    scope?: string;
    cwd?: string;
    projectName?: string;
    /** Anggaran waktu menunggu di dalam satu request (ms). */
    waitMs?: number;
    onOutput?: (text: string) => void;
  },
): Promise<DeployOutcome> {
  const token = (options.token || '').trim();
  if (!token) {
    return {
      state: 'failed',
      url: null,
      log: '',
      error: 'Token Vercel belum diisi. Buka Settings lalu tempel token dari vercel.com/account/tokens.',
      command: '',
      timedOut: false,
    };
  }

  const cwd = options.cwd || SANDBOX_PROJECT_DIR;
  const projectName = options.projectName || '';
  const command = buildDeployCommand({ projectName, scope: options.scope });
  const shell = deployShellCommand(command);

  // Log lama dibuang supaya status yang dibaca jelas milik deploy ini.
  await runCommand(sandbox, `: > ${DEPLOY_LOG_PATH}`, { cwd: '/', timeoutMs: 15_000 }).catch(() => undefined);

  // Token dikirim lewat envs (bukan argumen) supaya tidak muncul di daftar
  // argumen proses maupun di log yang ditampilkan.
  await sandbox.commands.run(shell, {
    background: true,
    cwd,
    envs: { VERCEL_TOKEN: token },
  });

  const budget = Math.max(5_000, Math.min(options.waitMs ?? 120_000, DEPLOY_TIMEOUT_MS));
  const deadline = Date.now() + budget;
  let status: DeployStatus = { state: 'running', url: null, urls: [], error: null };
  let log = '';

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, DEPLOY_POLL_MS));
    log = await sandbox.files.read(DEPLOY_LOG_PATH).then(
      (value) => redactSecrets(String(value ?? ''), token),
      () => log,
    );
    status = parseDeployStatus(log, { token, projectName });
    options.onOutput?.(redactSecrets(redactTail(log), token));
    if (status.state !== 'running' || Date.now() >= deadline) break;
  }

  return {
    state: status.state,
    url: status.url,
    log: redactSecrets(log, token),
    error: status.error ? explainDeployError(status.error) : null,
    command,
    timedOut: status.state === 'running',
  };
}

/** Ambil beberapa baris terakhir log (untuk dipancarkan ke UI secara live). */
function redactTail(log: string, lines = 6): string {
  const all = (log || '').split('\n').filter((line) => line.trim());
  return all.slice(-lines).join('\n');
}

/* -------------------------------------------------------------------------- */
/* Pemeriksaan UI dengan browser sungguhan (Playwright)                        */
/* -------------------------------------------------------------------------- */

/**
 * Pastikan Playwright + Chromium tersedia DI DALAM sandbox.
 *
 * Instalasi berat (~200 MB) jadi hanya dilakukan sekali per sandbox, ditandai
 * file penanda yang bertahan saat sandbox di-pause lalu bangun kembali. Kalau
 * proyek user sudah punya Playwright sendiri, itu dipakai (tidak memasang lagi).
 */
export async function ensureBrowser(
  sandbox: Sandbox,
  onOutput?: (text: string) => void,
): Promise<{ ok: boolean; message: string }> {
  const script = `
set -u
MARKER=${BROWSER_MARKER}
DIR=${BROWSER_DIR}
# Token eksplisit, bukan hanya exit code: perintah yang terbunuh batas waktu
# bisa menghasilkan result tanpa exitCode sehingga tampak "sukses".
if [ -f "$MARKER" ]; then echo "__AC_BROWSER_READY__ penanda"; exit 0; fi
if [ ! -d "$DIR" ]; then mkdir -p "$DIR" || { echo "__AC_BROWSER_FAIL__ mkdir"; exit 1; }; fi
cd "$DIR" || { echo "__AC_BROWSER_FAIL__ cd"; exit 1; }
if [ ! -f package.json ]; then echo '{"name":"agentcloud-browser","private":true}' > package.json; fi
echo "Menyiapkan Playwright (sekali per sandbox, ±1-3 menit)..."
if [ ! -d node_modules/playwright ]; then
  npm install --no-audit --no-fund playwright@1.62.1 >/dev/null 2>&1 || npm install --no-audit --no-fund playwright >/dev/null 2>&1 || true
fi
if [ ! -d node_modules/playwright ]; then echo "__AC_BROWSER_FAIL__ paket playwright tidak terpasang"; exit 1; fi
echo "Mengunduh Chromium..."
if ! npx --yes playwright install chromium >/dev/null 2>&1; then
  # Sebagian image butuh paket sistem; coba sekali lagi dengan --with-deps.
  if [ "$(id -u)" = "0" ]; then npx --yes playwright install --with-deps chromium >/dev/null 2>&1 || true;
  else sudo npx --yes playwright install --with-deps chromium >/dev/null 2>&1 || true; fi
fi
# Verifikasi nyata: Chromium benar-benar bisa dibuka.
if node -e "const {chromium}=require('playwright');chromium.launch({args:['--no-sandbox']}).then(b=>b.close()).then(()=>console.log('OK')).catch(e=>{console.log('FAIL '+e.message);process.exit(1)})" 2>/dev/null | grep -q OK; then
  touch "$MARKER"; echo "__AC_BROWSER_READY__ baru"; exit 0
fi
echo "__AC_BROWSER_FAIL__ Chromium tidak bisa dibuka di sandbox ini"; exit 1
`.trim();

  // Batas 240 detik: tetap di bawah batas durasi fungsi hosting (Vercel Hobby
  // = 300s). Kalau instalasi belum selesai, panggilan berikutnya MELANJUTKAN
  // (node_modules + cache npm sudah tersimpan), jadi tidak mengulang dari nol.
  const res = await runCommand(sandbox, script, { cwd: '/', timeoutMs: 240_000 }).catch((err) => ({
    ok: false,
    stdout: '',
    stderr: err instanceof Error ? err.message : String(err),
    exitCode: null,
  }));
  const out = `${res.stdout}\n${res.stderr}`.trim();
  onOutput?.(out);

  // Kesiapan ditentukan token eksplisit di keluaran, bukan exit code: perintah
  // yang terbunuh batas waktu bisa memberi result tanpa exitCode (tampak sukses).
  if (out.includes('__AC_BROWSER_READY__')) {
    return { ok: true, message: out.includes('penanda') ? 'browser sudah siap (penanda)' : 'browser siap' };
  }
  const failureReason = out.match(/__AC_BROWSER_FAIL__\s*(.*)/)?.[1]?.trim();

  // Belum selesai (bukan berarti gagal permanen): instalasi bisa dilanjutkan.
  const unfinished = !failureReason || /unduh|Menyiapkan|install/i.test(out);
  return {
    ok: false,
    message:
      (failureReason ? `Browser gagal disiapkan: ${failureReason}\n` : `Browser belum siap di sandbox.\n${truncate(out, 600)}\n`) +
      (unfinished
        ? 'Instalasi kemungkinan belum selesai (butuh 1-3 menit) — panggil `browser_check` SEKALI LAGI untuk melanjutkan; unduhan yang sudah ada tidak diulang.'
        : 'Verifikasi UI dengan cara lain sementara ini (curl endpoint, periksa HTML) dan sebutkan keterbatasan ini ke user.'),
  };
}

export type BrowserCheckOutcome = {
  ok: boolean;
  output: string;
  report: ReturnType<typeof parseBrowserReport>;
  image?: { dataUrl: string; caption: string };
};

/** Batas ukuran screenshot yang dikirim ke model/UI (data URL base64). */
const MAX_IMAGE_DATA_URL = 1_400_000;

/**
 * Buka halaman di browser dalam sandbox, kumpulkan diagnostik (error konsol,
 * JS error, request gagal, overflow horizontal, gambar rusak) + screenshot.
 */
export async function runBrowserCheck(
  sandbox: Sandbox,
  options: {
    port: number;
    path?: string;
    viewport?: string;
    width?: number;
    height?: number;
    fullPage?: boolean;
    onOutput?: (text: string) => void;
  },
): Promise<BrowserCheckOutcome> {
  const ready = await ensureBrowser(sandbox, options.onOutput);
  if (!ready.ok) {
    return { ok: false, output: ready.message, report: null };
  }

  const viewport = viewportFor(options.viewport, { width: options.width, height: options.height });
  const path = options.path && options.path.startsWith('/') ? options.path : `/${options.path ?? ''}`;
  const url = `http://127.0.0.1:${options.port}${path === '/' ? '/' : path}`;

  // Skrip ditulis ulang setiap kali supaya perubahan versi script ikut terpakai.
  const written = await writeProjectFileAbsolute(sandbox, BROWSER_SCRIPT_PATH, browserScript());
  if (!written) {
    return { ok: false, output: `Gagal menulis skrip browser ke ${BROWSER_SCRIPT_PATH}.`, report: null };
  }

  const run = await runCommand(
    sandbox,
    [
      `AC_URL=${shellQuote(url)}`,
      `AC_WIDTH=${viewport.width}`,
      `AC_HEIGHT=${viewport.height}`,
      `AC_FULL=${options.fullPage ? '1' : '0'}`,
      `AC_SHOT=${shellQuote(BROWSER_SHOT_PATH)}`,
      `node ${shellQuote(BROWSER_SCRIPT_PATH)}`,
    ].join(' '),
    { cwd: BROWSER_DIR, timeoutMs: 180_000 },
  );

  const raw = `${run.stdout}\n${run.stderr}`;
  options.onOutput?.(truncate(raw.replace(/\s+$/, ''), 1_500));

  const report = parseBrowserReport(raw);
  if (!report) {
    return {
      ok: false,
      output:
        `Pemeriksaan browser gagal dijalankan (tidak ada laporan). Keluaran mentah:\n${truncate(raw, 900)}\n` +
        'Periksa apakah server dev benar-benar hidup di port itu dan Playwright bisa dibuka di sandbox.',
      report: null,
    };
  }

  const verdict = judgeReport(report);
  const output = summarizeBrowserReport(report, verdict, { viewportName: viewport.name });

  let image: BrowserCheckOutcome['image'];
  if (report.screenshot) {
    try {
      const base64 = await sandbox.files.read(BROWSER_SHOT_PATH);
      const dataUrl = `data:image/jpeg;base64,${String(base64).trim()}`;
      if (dataUrl.length <= MAX_IMAGE_DATA_URL) {
        image = { dataUrl, caption: `Screenshot ${url} @ ${viewport.width}x${viewport.height}` };
      }
    } catch {
      /* screenshot opsional */
    }
  }

  return { ok: verdict.ok, output, report, image };
}

/** Tulis file dengan path absolut di dalam sandbox (mis. di luar folder proyek). */
async function writeProjectFileAbsolute(sandbox: Sandbox, absPath: string, content: string): Promise<boolean> {
  try {
    const dir = absPath.slice(0, absPath.lastIndexOf('/'));
    if (dir) await runCommand(sandbox, `mkdir -p ${shellQuote(dir)}`, { cwd: '/', timeoutMs: 30_000 });
    await sandbox.files.write(absPath, content);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Definisi tool untuk function-calling OpenRouter                            */
/* -------------------------------------------------------------------------- */

export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description:
        'Jalankan perintah bash di dalam sandbox Linux (cwd default: folder proyek). Gunakan untuk npm install, npm run build, test, git, curl, dll. Output stdout/stderr dan exit code dikembalikan.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Perintah bash yang akan dieksekusi.' },
          cwd: { type: 'string', description: 'Direktori kerja (opsional, default folder proyek).' },
          timeout_ms: { type: 'number', description: 'Timeout dalam ms, default 120000, maksimal 600000.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Buat atau timpa (overwrite) sebuah file di folder proyek sandbox. Selalu tulis file lengkap, bukan patch.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relatif terhadap folder proyek, mis. "src/app.js".' },
          content: { type: 'string', description: 'Isi file lengkap.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Baca isi file di sandbox supaya kamu tahu kode yang sudah ada sebelum mengubahnya.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relatif terhadap folder proyek.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_files',
      description: 'Lihat daftar file/folder dalam proyek (rekursif sampai 4 level, node_modules dikecualikan).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Sub-folder (opsional).' } },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'start_server',
      description:
        'Jalankan dev/preview server secara background dan dapatkan URL preview publik. Tool ini MEMVERIFIKASI sendiri apakah URL publik benar-benar melayani aplikasi; kalau belum, hasilnya berisi masalah + log. Server WAJIB listen di 0.0.0.0 (bukan 127.0.0.1), kalau tidak proxy E2B menjawab "Closed Port Error": Vite/Astro/Svelte/Remix → "--host 0.0.0.0", Next.js → "--hostname 0.0.0.0", Express/Node → app.listen(port, "0.0.0.0"). Contoh: "npm run dev -- --host 0.0.0.0 --port 3000". Port default 3000.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Perintah server yang dijalankan di background.' },
          port: { type: 'number', description: 'Port HTTP yang dipakai server (default 3000).' },
          cwd: {
            type: 'string',
            description:
              'Direktori kerja server, relatif terhadap folder proyek. WAJIB diisi bila aplikasi dibuat di sub-folder (mis. "werewolf-game"), supaya npm/pnpm menemukan package.json yang benar.',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'stop_server',
      description: 'Hentikan server yang sedang berjalan di sebuah port (mis. sebelum menjalankan ulang).',
      parameters: {
        type: 'object',
        properties: { port: { type: 'number', description: 'Port server yang akan dihentikan.' } },
        required: ['port'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_check',
      description:
        'Buka halaman aplikasi di browser sungguhan (Playwright) di dalam sandbox, lalu laporkan apa yang BENAR-BENAR terjadi: status HTTP, error console/JS, request gagal, gambar rusak, scroll horizontal, panjang teks, plus screenshot. WAJIB dipakai sebelum mengklaim pekerjaan UI selesai — status HTTP 200 tidak berarti tampilannya benar. Cek minimal di viewport "mobile" (375px) dan "desktop".',
      parameters: {
        type: 'object',
        properties: {
          port: { type: 'number', description: 'Port dev server di dalam sandbox (default 3000).' },
          path: { type: 'string', description: 'Path halaman, mis. "/" atau "/login" (default "/").' },
          viewport: { type: 'string', enum: ['mobile', 'tablet', 'desktop'], description: 'Ukuran layar (default desktop 1440x900).' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_preview_url',
      description: 'Ambil URL preview publik untuk sebuah port, dan cek apakah servernya merespons.',
      parameters: {
        type: 'object',
        properties: { port: { type: 'number', description: 'Port yang ingin dicek (default 3000).' } },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'deploy',
      description:
        'Deploy proyek ke akun Vercel MILIK USER dan dapatkan LINK PERMANEN (mis. https://nama-proyek.vercel.app) yang tetap hidup walaupun sandbox dimatikan. Panggil HANYA kalau user memintanya secara eksplisit (mis. "deploy", "publish ke Vercel", "kasih link permanen") — jangan deploy sendiri tanpa diminta. Token Vercel diambil otomatis dari Settings aplikasi; kamu tidak perlu (dan tidak boleh) menulis token di argumen. Kalau user belum mengisi token, hasil tool akan menjelaskan bahwa token harus diisi di Settings. Deploy bisa memakan beberapa menit (Vercel membangun di sisi mereka); kalau hasilnya menyatakan masih berjalan, panggil tool ini sekali lagi untuk melanjutkan.',
      parameters: {
        type: 'object',
        properties: {
          cwd: {
            type: 'string',
            description:
              'Direktori proyek yang dideploy, relatif terhadap folder proyek. WAJIB diisi bila aplikasi ada di sub-folder (mis. "kasir-app").',
          },
          prod: { type: 'boolean', description: 'Deploy ke produksi (default true).' },
        },
      },
    },
  },
];

/* -------------------------------------------------------------------------- */
/* Eksekutor tool                                                             */
/* -------------------------------------------------------------------------- */

export async function executeTool(ctx: ToolContext, name: string, rawArgs: Record<string, unknown>): Promise<ToolResult> {
  const args = rawArgs ?? {};
  try {
    switch (name) {
      case 'run_command': {
        const command = String(args.command ?? '').trim();
        if (!command) return { ok: false, output: 'Parameter `command` wajib diisi.' };
        const timeout = clamp(Number(args.timeout_ms) || 120_000, 5_000, 600_000);
        const cwd = args.cwd ? resolvePath(String(args.cwd)) : SANDBOX_PROJECT_DIR;
        const res = await runCommand(ctx.sandbox, command, { cwd, timeoutMs: timeout, onOutput: ctx.onOutput });
        return {
          ok: res.ok,
          output: [
            `exit_code: ${res.exitCode}`,
            res.stdout ? `stdout:\n${truncate(res.stdout, MAX_OUTPUT)}` : 'stdout: (kosong)',
            res.stderr ? `stderr:\n${truncate(res.stderr, MAX_OUTPUT)}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        };
      }

      case 'write_file': {
        const path = String(args.path ?? '').trim();
        const content = typeof args.content === 'string' ? args.content : String(args.content ?? '');
        if (!path) return { ok: false, output: 'Parameter `path` wajib diisi.' };
        const res = await writeProjectFile(ctx.sandbox, path, content);
        return { ok: true, output: `File ${res.path} tersimpan (${humanSize(res.bytes)}).` };
      }

      case 'read_file': {
        const path = String(args.path ?? '').trim();
        if (!path) return { ok: false, output: 'Parameter `path` wajib diisi.' };
        const res = await readProjectFile(ctx.sandbox, path);
        return { ok: true, output: `// ${res.path}\n${truncate(res.content, MAX_OUTPUT)}` };
      }

      case 'list_files': {
        const entries = await listProjectFiles(ctx.sandbox, args.path ? String(args.path) : undefined);
        if (!entries.length) return { ok: true, output: 'Proyek masih kosong (belum ada file).' };
        const lines = entries
          .slice()
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((e) => `${e.type === 'dir' ? 'dir ' : 'file'} ${e.path}${e.type === 'file' ? ` (${humanSize(e.size)})` : ''}`);
        return { ok: true, output: lines.join('\n') };
      }

      case 'start_server': {
        const command = String(args.command ?? '').trim();
        if (!command) return { ok: false, output: 'Parameter `command` wajib diisi.' };
        const port = clamp(Number(args.port) || 3000, 1024, 65535);
        // Aplikasi bisa berada di sub-folder (mis. /home/user/project/werewolf-game),
        // jadi cwd harus dihormati agar package.json yang benar ditemukan.
        const cwd = args.cwd ? resolvePath(String(args.cwd)) : SANDBOX_PROJECT_DIR;
        const res = await startServer(ctx.sandbox, command, port, { onOutput: ctx.onOutput, cwd });
        return {
          ok: res.ready,
          output: [
            `preview_url: ${res.previewUrl}`,
            `cwd: ${relPath(cwd, SANDBOX_PROJECT_DIR) || '.'}`,
            `command: ${res.command}${res.rebound ? '  (dijalankan ulang dengan bind 0.0.0.0)' : ''}`,
            `http_lokal: ${res.localCode}  |  bind: ${res.listenScope}  |  url_publik: ${res.publicStatus}`,
            `status: ${
              res.ready
                ? 'SIAP - URL publik sudah melayani aplikasi user'
                : res.issue
                  ? 'BELUM SIAP - URL publik menampilkan HALAMAN ERROR, bukan aplikasi user'
                  : 'BELUM SIAP - jangan katakan preview siap ke user'
            }`,
            res.reason ? `masalah: ${res.reason}` : '',
            res.issue?.fixCommand ? `perbaikan: jalankan \`${res.issue.fixCommand}\` lalu panggil start_server lagi` : '',
            res.warning ? `catatan: ${res.warning}` : '',
            res.logs ? `logs:\n${truncate(res.logs, 3_000)}` : 'logs: (kosong)',
          ]
            .filter(Boolean)
            .join('\n'),
          previewUrl: res.previewUrl,
          port,
        };
      }

      case 'stop_server': {
        const port = clamp(Number(args.port) || 3000, 1024, 65535);
        const killed = await stopServer(ctx.sandbox, port);
        return { ok: true, output: killed ? `Server di port ${port} dihentikan.` : `Tidak ada server terdaftar di port ${port}.` };
      }

      case 'browser_check': {
        const port = clamp(Number(args.port) || 3000, 1024, 65535);
        const path = typeof args.path === 'string' ? args.path : '/';
        const viewport = typeof args.viewport === 'string' ? args.viewport : 'desktop';
        const res = await runBrowserCheck(ctx.sandbox, { port, path, viewport, onOutput: ctx.onOutput });
        return { ok: res.ok, output: res.output, port, image: res.image };
      }

      case 'get_preview_url': {
        const port = clamp(Number(args.port) || 3000, 1024, 65535);
        const url = previewAddress(ctx.sandbox, port);
        const local = await probeLocalPort(ctx.sandbox, port);
        const publicProbe = await probePublicUrl(url);
        const packageManager = publicProbe.issue?.packages.length
          ? await detectPackageManager(ctx.sandbox, SANDBOX_PROJECT_DIR)
          : undefined;
        const decision = decideServerReadiness({ localCode: local.code, listenScope: local.scope, publicProbe, packageManager });
        return {
          ok: decision.ready,
          output: [
            `preview_url: ${url}`,
            `http_lokal: ${local.code}  |  bind: ${local.scope}  |  url_publik: ${publicProbe.status}`,
            `status: ${decision.ready ? 'SIAP dipakai user' : 'BELUM SIAP'}`,
            decision.reason ? `masalah: ${decision.reason}` : '',
            decision.issue?.fixCommand ? `perbaikan: jalankan \`${decision.issue.fixCommand}\`` : '',
            decision.warning ? `catatan: ${decision.warning}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          previewUrl: url,
          port,
        };
      }

      case 'deploy': {
        const deployCfg = ctx.deploy;
        if (!deployCfg?.token) {
          return {
            ok: false,
            output:
              'Token Vercel belum diisi, jadi deploy tidak bisa dijalankan. Sampaikan ke user: buka Settings (ikon gerigi) lalu tempel token dari vercel.com/account/tokens ' +
              'di kolom "Token deploy Vercel" (atau isi variabel environment VERCEL_TOKEN di hosting). Setelah itu minta saya deploy lagi.',
          };
        }
        const cwd = args.cwd ? resolvePath(String(args.cwd)) : SANDBOX_PROJECT_DIR;
        const prod = args.prod !== false;
        const projectName = deployCfg.projectName || '';

        const cli = await ensureVercel(ctx.sandbox, ctx.onOutput);
        if (!cli.ok) return { ok: false, output: cli.message };

        const outcome = await deployToVercel(ctx.sandbox, {
          token: deployCfg.token,
          scope: deployCfg.scope,
          cwd,
          projectName,
          waitMs: 150_000,
          onOutput: ctx.onOutput,
        });

        const lines = [
          `deploy_status: ${outcome.state}${outcome.timedOut ? ' (masih berjalan)' : ''}`,
          `cwd: ${relPath(cwd, SANDBOX_PROJECT_DIR) || '.'}`,
          outcome.url ? `link_permanen: ${outcome.url}` : '',
          outcome.state === 'done'
            ? 'status: SELESAI - link ini permanen dan tetap hidup walau sandbox dimatikan'
            : outcome.state === 'failed'
              ? `masalah: ${outcome.error ?? 'deploy gagal'}`
              : 'status: BELUM SELESAI - panggil tool deploy sekali lagi untuk melanjutkan (deploy tetap berjalan di sandbox)',
          outcome.log ? `logs:\n${truncate(outcome.log, 2_500)}` : '',
        ].filter(Boolean);

        return { ok: outcome.state === 'done', output: lines.join('\n'), previewUrl: outcome.url ?? undefined };
      }

      default:
        return { ok: false, output: `Tool tidak dikenal: ${name}` };
    }
  } catch (err) {
    return { ok: false, output: `Error saat menjalankan ${name}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
