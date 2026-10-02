import type { Sandbox } from '@e2b/code-interpreter';
import { E2B_API_KEY_ENV, E2B_SANDBOX_TIMEOUT_MS, SANDBOX_PROJECT_DIR } from '@/lib/config';

export type { Sandbox };

export class SandboxConfigError extends Error {}
export class SandboxLoadError extends Error {}

/** File penanda di dalam sandbox: runtime sudah siap (bertahan saat pause/resume). */
export const RUNTIME_MARKER = '/home/user/.agentcloud-runtime-ready';

type E2bModule = typeof import('@e2b/code-interpreter');

let sdkPromise: Promise<E2bModule> | null = null;

/**
 * SDK E2B dimuat secara LAZY (dynamic import) dan hasilnya di-cache.
 *
 * Alasan: kalau modul ini diimpor di top-level, kegagalan pemuatan modul
 * (mis. paket tidak ikut ter-bundle di runtime serverless seperti Vercel)
 * membuat SELURUH route yang mengimpornya menjawab 500 - bahkan untuk request
 * yang seharusnya ditolak dengan pesan validasi biasa. Dengan pemuatan lazy,
 * kegagalan itu bisa dilaporkan sebagai pesan yang jelas dan fitur sandbox saja
 * yang nonaktif, sementara chat tetap jalan dalam mode diskusi.
 */
export async function loadE2bSdk(): Promise<E2bModule> {
  if (!sdkPromise) {
    sdkPromise = import('@e2b/code-interpreter')
      .then((mod) => mod as E2bModule)
      .catch((err) => {
        sdkPromise = null; // supaya bisa dicoba lagi (mis. setelah redeploy)
        throw new SandboxLoadError(
          `SDK E2B gagal dimuat di runtime ini: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }
  return sdkPromise;
}

/** Status pemuatan SDK E2B - dipakai endpoint /api/health untuk diagnosa. */
export async function e2bSdkStatus(): Promise<{ ok: boolean; message: string }> {
  if (!hasE2bKey()) return { ok: false, message: 'E2B_API_KEY belum diisi' };
  try {
    await loadE2bSdk();
    return { ok: true, message: 'SDK E2B siap' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export type SandboxHandle = {
  sandbox: Sandbox;
  sandboxId: string;
  created: boolean;
  /** true = id sandbox lama ada tapi sudah tidak bisa dihubungi, diganti sandbox baru. */
  recovered?: boolean;
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
      'E2B_API_KEY belum diisi. Tambahkan E2B_API_KEY pada environment aplikasi (variabel environment hosting), lalu jalankan ulang aplikasinya.',
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
  const { Sandbox: E2bSandbox } = await loadE2bSdk();
  const template = getTemplate();

  /**
   * lifecycle penting untuk penghematan biaya & keawetan pekerjaan:
   *  - onTimeout: 'pause'  -> saat idle, sandbox DI-PAUSE (bukan dimatikan).
   *    E2B tidak menagih selama sandbox paused, dan isinya (filesystem + memori,
   *    termasuk dev server yang sedang jalan) tersimpan tanpa batas waktu.
   *    Default E2B adalah 'kill' yang membuat seluruh proyek user hilang.
   *  - autoResume: true    -> begitu ada aktivitas (pesan chat, perintah, atau
   *    request HTTP ke URL preview) sandbox bangun sendiri.
   */
  const lifecycle = { onTimeout: 'pause' as const, autoResume: true };

  const sandbox = template
    ? await E2bSandbox.create(template, { apiKey, timeoutMs: E2B_SANDBOX_TIMEOUT_MS, lifecycle })
    : await E2bSandbox.create({ apiKey, timeoutMs: E2B_SANDBOX_TIMEOUT_MS, lifecycle });

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
  const { Sandbox: E2bSandbox } = await loadE2bSdk();
  const create = options?.create ?? true;

  if (sandboxId) {
    const cached = cache().get(sandboxId);
    if (cached) {
      await keepAlive(cached);
      return { sandbox: cached, sandboxId, created: false };
    }
    try {
      const connected = await E2bSandbox.connect(sandboxId, { apiKey });
      cache().set(sandboxId, connected);
      await keepAlive(connected);
      return { sandbox: connected, sandboxId, created: false };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (!create) {
        throw new Error(
          `Sandbox sudah tidak ada lagi (${sandboxId}). Detail: ${detail}\n` +
            'Klik tombol "Sandbox baru" di panel atas untuk membuat sandbox baru, lalu minta agent melanjutkan pekerjaannya.',
        );
      }
      console.warn(`[sandbox] reconnect gagal, membuat sandbox baru: ${detail}`);
      const fresh = await createSandbox();
      // Beri tahu pemanggil bahwa ini sandbox BARU: file proyek sebelumnya
      // tidak bisa dipulihkan, dan itu penting disampaikan ke user.
      return { ...fresh, recovered: true };
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
    const { Sandbox: E2bSandbox } = await loadE2bSdk();
    await E2bSandbox.kill(sandboxId, { apiKey: getE2bKey() });
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
 * Hasil pemeriksaan ditandai dengan FILE PENANDA di dalam sandbox, bukan hanya
 * cache memori proses. Alasannya: sandbox yang di-pause lalu bangun kembali
 * (auto-resume) mempertahankan filesystem, dan proses server aplikasi ini juga
 * bisa berganti (serverless). Tanpa penanda, pemeriksaan/instalasi Node akan
 * diulang-ulang padahal sudah selesai.
 */
export async function ensureRuntime(sandbox: Sandbox, onLog?: (text: string) => void): Promise<string> {
  const id = sandbox.sandboxId;
  if (runtimeReady().has(id)) return 'runtime sudah siap';

  const marker = `${RUNTIME_MARKER}`;
  const script = `
set -u
if [ -f ${marker} ] && command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  echo "OK (penanda) node $(node -v) npm $(npm -v)"
  exit 0
fi
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  mkdir -p $(dirname ${marker}) 2>/dev/null || true
  echo "node $(node -v) npm $(npm -v)" > ${marker} 2>/dev/null || true
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
  mkdir -p $(dirname ${marker}) 2>/dev/null || true
  echo "node $(node -v) npm $(npm -v)" > ${marker} 2>/dev/null || true
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
