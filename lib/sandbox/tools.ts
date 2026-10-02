import type { Sandbox } from '@e2b/code-interpreter';
import { SANDBOX_PROJECT_DIR } from '@/lib/config';
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
import { humanSize, joinSandboxPath, normalize, relPath, truncate } from '@/lib/util';

export type ToolContext = {
  sandbox: Sandbox;
  sandboxId: string;
  /** Callback untuk meneruskan output terminal ke UI secara live. */
  onOutput?: (text: string) => void;
};

export type ToolResult = {
  ok: boolean;
  output: string;
  previewUrl?: string;
  port?: number;
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

async function rememberServer(sandbox: Sandbox, record: ServerRecord): Promise<void> {
  const records = await readServerRegistry(sandbox);
  await writeServerRegistry(sandbox, [...records.filter((r) => r.port !== record.port), record]);
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
    return evaluatePublicProbe(res.status, body.slice(0, 4_000));
  } catch {
    return evaluatePublicProbe(0, '');
  }
}

/** Skrip penunggu: selesai lebih cepat kalau prosesnya sudah mati (bukan 30 detik buta). */
export function readinessScript(port: number, pid?: number): string {
  const alive = pid ? `if ! kill -0 ${pid} 2>/dev/null; then echo "DEAD"; exit 2; fi` : '';
  return `
for i in $(seq 1 40); do
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

  const decision = decideServerReadiness({
    localCode: attempt.localCode,
    listenScope: attempt.listenScope,
    publicProbe: attempt.publicProbe,
  });

  if (decision.ready) {
    await rememberServer(sandbox, { port, command: currentCommand, cwd, startedAt: Date.now() });
  } else if (attempt.readiness.state === 'dead' || attempt.readiness.state === 'timeout') {
    // Jangan simpan perintah yang gagal: pemulihan otomatis berikutnya hanya
    // akan mengulang kegagalan yang sama.
    await forgetServer(sandbox, port);
  }

  return {
    previewUrl: url,
    ready: decision.ready,
    logs: attempt.logs,
    reason: decision.reason,
    warning: decision.warning,
    command: currentCommand,
    rebound,
    localCode: attempt.localCode,
    listenScope: attempt.listenScope,
    publicStatus: attempt.publicProbe.status,
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
      name: 'get_preview_url',
      description: 'Ambil URL preview publik untuk sebuah port, dan cek apakah servernya merespons.',
      parameters: {
        type: 'object',
        properties: { port: { type: 'number', description: 'Port yang ingin dicek (default 3000).' } },
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
                : 'BELUM SIAP - jangan katakan preview siap ke user'
            }`,
            res.reason ? `masalah: ${res.reason}` : '',
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

      case 'get_preview_url': {
        const port = clamp(Number(args.port) || 3000, 1024, 65535);
        const url = previewAddress(ctx.sandbox, port);
        const local = await probeLocalPort(ctx.sandbox, port);
        const publicProbe = await probePublicUrl(url);
        const decision = decideServerReadiness({ localCode: local.code, listenScope: local.scope, publicProbe });
        return {
          ok: decision.ready,
          output: [
            `preview_url: ${url}`,
            `http_lokal: ${local.code}  |  bind: ${local.scope}  |  url_publik: ${publicProbe.status}`,
            `status: ${decision.ready ? 'SIAP dipakai user' : 'BELUM SIAP'}`,
            decision.reason ? `masalah: ${decision.reason}` : '',
            decision.warning ? `catatan: ${decision.warning}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          previewUrl: url,
          port,
        };
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
