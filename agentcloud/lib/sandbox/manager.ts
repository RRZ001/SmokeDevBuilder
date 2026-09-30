import { Sandbox } from '@e2b/code-interpreter';
import { E2B_API_KEY_ENV, E2B_SANDBOX_TIMEOUT_MS, SANDBOX_PROJECT_DIR } from '@/lib/config';

export class SandboxConfigError extends Error {}

export type SandboxHandle = {
  sandbox: Sandbox;
  sandboxId: string;
  created: boolean;
};

const globalForSandbox = globalThis as unknown as {
  __acSandboxCache?: Map<string, Sandbox>;
  __acRuntimeReady?: Set<string>;
};

function cache(): Map<string, Sandbox> {
  if (!globalForSandbox.__acSandboxCache) globalForSandbox.__acSandboxCache = new Map();
  return globalForSandbox.__acSandboxCache;
}

function runtimeReady(): Set<string> {
  if (!globalForSandbox.__acRuntimeReady) globalForSandbox.__acRuntimeReady = new Set();
  return globalForSandbox.__acRuntimeReady;
}

export function getE2bKey(): string {
  const key = E2B_API_KEY_ENV;
  if (!key) {
    throw new SandboxConfigError(
      'E2B_API_KEY belum diisi. Tambahkan di environment (E2B_API_KEY=...) atau isi lewat Settings di aplikasi.',
    );
  }
  return key;
}

export function hasE2bKey(): boolean {
  return Boolean(E2B_API_KEY_ENV);
}

export function getTemplate(): string | undefined {
  const tpl = (process.env.E2B_TEMPLATE || '').trim();
  return tpl || undefined;
}

export async function createSandbox(): Promise<SandboxHandle> {
  const apiKey = getE2bKey();
  const template = getTemplate();
  const sandbox = template
    ? await Sandbox.create(template, { apiKey, timeoutMs: E2B_SANDBOX_TIMEOUT_MS })
    : await Sandbox.create({ apiKey, timeoutMs: E2B_SANDBOX_TIMEOUT_MS });
  cache().set(sandbox.sandboxId, sandbox);
  await ensureProjectDir(sandbox);
  return { sandbox, sandboxId: sandbox.sandboxId, created: true };
}

/**
 * Ambil sandbox yang sudah ada, atau buat baru kalau id-nya sudah kedaluwarsa/dihapus.
 * (Sandbox E2B punya masa hidup terbatas, jadi kasus ini normal.)
 */
export async function getSandbox(sandboxId?: string | null, options?: { create?: boolean }): Promise<SandboxHandle> {
  const apiKey = getE2bKey();
  const create = options?.create ?? true;

  if (sandboxId) {
    const cached = cache().get(sandboxId);
    if (cached) {
      await keepAlive(cached);
      return { sandbox: cached, sandboxId, created: false };
    }
    try {
      const connected = await Sandbox.connect(sandboxId, { apiKey });
      cache().set(sandboxId, connected);
      await keepAlive(connected);
      return { sandbox: connected, sandboxId, created: false };
    } catch (err) {
      if (!create) {
        throw new Error(
          `Sandbox ${sandboxId} tidak bisa dihubungkan (mungkin sudah expired). Detail: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      console.warn(`[sandbox] reconnect gagal, membuat sandbox baru: ${err instanceof Error ? err.message : err}`);
    }
  }

  return createSandbox();
}

/** Perpanjang masa hidup sandbox selama dipakai (diabaikan kalau limit plan lebih kecil). */
async function keepAlive(sandbox: Sandbox): Promise<void> {
  try {
    await sandbox.setTimeout(E2B_SANDBOX_TIMEOUT_MS);
  } catch {
    /* plan E2B bisa membatasi timeout maksimum - tidak fatal */
  }
}

export async function killSandbox(sandboxId: string): Promise<void> {
  try {
    await Sandbox.kill(sandboxId, { apiKey: getE2bKey() });
  } catch (err) {
    console.warn(`[sandbox] kill ${sandboxId} gagal: ${err instanceof Error ? err.message : err}`);
  }
  cache().delete(sandboxId);
  runtimeReady().delete(sandboxId);
}

export async function ensureProjectDir(sandbox: Sandbox): Promise<void> {
  try {
    await sandbox.files.makeDir(SANDBOX_PROJECT_DIR);
  } catch {
    /* sudah ada */
  }
}

/**
 * Pastikan Node.js + npm tersedia di sandbox.
 *
 * Template default E2B belum tentu punya Node, jadi kalau belum ada kita pasang
 * otomatis (sekali per sandbox, hasilnya di-cache di memori proses).
 * Untuk startup yang instan, build template kustom lewat `e2b.Dockerfile`
 * di root repo ini lalu set E2B_TEMPLATE (lihat README).
 */
export async function ensureRuntime(sandbox: Sandbox, onLog?: (text: string) => void): Promise<string> {
  const id = sandbox.sandboxId;
  if (runtimeReady().has(id)) return 'runtime sudah siap';

  const script = `
set -u
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  echo "OK node $(node -v) npm $(npm -v)"
  exit 0
fi
SUDO=""
if [ "$(id -u)" != "0" ]; then SUDO="sudo"; fi
ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) NODE_ARCH="x64" ;;
esac
NODE_VER="v20.18.1"
echo "Node belum ada, memasang Node \${NODE_VER} (\${NODE_ARCH})..."
cd /tmp
if curl -fsSL -o node.tar.xz "https://nodejs.org/dist/\${NODE_VER}/node-\${NODE_VER}-linux-\${NODE_ARCH}.tar.xz"; then
  DIR="/usr/local/lib/nodejs/node-\${NODE_VER}-linux-\${NODE_ARCH}"
  $SUDO mkdir -p /usr/local/lib/nodejs
  $SUDO rm -rf "$DIR"
  $SUDO tar -xJf node.tar.xz -C /usr/local/lib/nodejs
  for b in node npm npx; do $SUDO ln -sf "$DIR/bin/$b" "/usr/local/bin/$b"; done
  rm -f node.tar.xz
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Fallback ke apt-get..."
  $SUDO apt-get update -y >/dev/null 2>&1 || true
  $SUDO apt-get install -y nodejs npm >/dev/null 2>&1 || true
fi
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  echo "OK node $(node -v) npm $(npm -v)"
  exit 0
fi
echo "GAGAL memasang Node.js"
exit 1
`.trim();

  const result = await sandbox.commands.run(script, { timeoutMs: 300_000 });
  onLog?.(result.stdout + result.stderr);
  if (result.exitCode !== 0) {
    throw new Error(`Gagal menyiapkan Node.js di sandbox: ${(result.stdout + result.stderr).slice(-500)}`);
  }
  runtimeReady().add(id);
  return (result.stdout || '').trim();
}

export function previewUrl(sandbox: Sandbox, port: number): string {
  return `https://${sandbox.getHost(port)}`;
}

export function projectDir(): string {
  return SANDBOX_PROJECT_DIR;
}
