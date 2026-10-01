import type { Sandbox } from '@e2b/code-interpreter';
import { SANDBOX_PROJECT_DIR } from '@/lib/config';
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

export async function startServer(
  sandbox: Sandbox,
  command: string,
  port: number,
  options: { cwd?: string; onOutput?: (text: string) => void } = {},
): Promise<{ previewUrl: string; ready: boolean; logs: string }> {
  assertSafeCommand(command);
  const existing = servers(sandbox.sandboxId).get(port);
  if (existing) {
    await stopServer(sandbox, port).catch(() => undefined);
  }

  const handle = await sandbox.commands.run(command, {
    background: true,
    cwd: options.cwd || SANDBOX_PROJECT_DIR,
    onStdout: options.onOutput ? (chunk) => options.onOutput?.(chunk) : undefined,
    onStderr: options.onOutput ? (chunk) => options.onOutput?.(chunk) : undefined,
  });

  servers(sandbox.sandboxId).set(port, { pid: handle.pid, command, startedAt: Date.now() });

  // Tunggu sampai port benar-benar melayani HTTP (compile dev server bisa butuh waktu).
  const wait = `
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -m 3 -w "%{http_code}" http://127.0.0.1:${port}/ 2>/dev/null || echo 000)
  if [ "$code" != "000" ] && [ -n "$code" ]; then echo "READY $code"; exit 0; fi
  sleep 0.5
done
echo "TIMEOUT"
exit 1
`.trim();
  const probe = await runCommand(sandbox, wait, { cwd: '/', timeoutMs: 90_000 });
  const ready = probe.ok;

  await new Promise((r) => setTimeout(r, 700));
  const logs = truncate([handle.stdout, handle.stderr].filter(Boolean).join('\n'), 4_000);

  return { previewUrl: `https://${sandbox.getHost(port)}`, ready, logs };
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
        'Jalankan dev/preview server secara background dan dapatkan URL preview publik. Contoh command: "npm run dev -- --host 0.0.0.0 --port 3000". Port default 3000.',
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
            `status: ${res.ready ? 'server merespons HTTP' : 'server belum merespons dalam 30 detik'}`,
            res.logs ? `logs:\n${truncate(res.logs, 3_000)}` : 'logs: (kosong)',
          ].join('\n'),
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
        const probe = await runCommand(
          ctx.sandbox,
          `code=$(curl -s -o /dev/null -m 4 -w "%{http_code}" http://127.0.0.1:${port}/ 2>/dev/null || echo 000); echo "http_status: $code"`,
          { cwd: '/', timeoutMs: 20_000 },
        );
        const url = previewAddress(ctx.sandbox, port);
        return { ok: true, output: `preview_url: ${url}\n${probe.stdout.trim()}`, previewUrl: url, port };
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
