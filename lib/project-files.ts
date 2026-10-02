import type { Sandbox } from '@e2b/code-interpreter';
import { SANDBOX_PROJECT_DIR } from '@/lib/config';
import type { Store } from '@/lib/db';
import { runCommand } from '@/lib/sandbox/tools';
import { humanSize } from '@/lib/util';

/**
 * Persistensi file proyek.
 *
 * Sandbox E2B bisa hilang (di-kill, dihapus server, atau dibuat ulang). Tanpa
 * lapisan ini, seluruh kode proyek ikut hilang dan agent harus membangun ulang
 * dari nol - mahal (token) dan melelahkan. Di sini file proyek disimpan ke
 * database (Supabase/SQLite) dan bisa dipulihkan ke sandbox mana pun.
 *
 * Yang disimpan: file teks proyek. Yang TIDAK disimpan (sengaja):
 *  - node_modules / .next / dist / build / .git (besar & bisa dibuat ulang)
 *  - file > MAX_FILE_BYTES (mis. gambar besar, database lokal)
 * Dependency TIDAK ikut dipulihkan, jadi setelah restore perlu `npm install`.
 */

const SKIP_DIRS = [
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.cache',
  '.turbo',
  '.venv',
  '__pycache__',
  'coverage',
  '.pnpm-store',
];

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_FILES = 400;
/** Batas total isi yang diambil dalam satu kali baca (menghindari output raksasa). */
const MAX_BATCH_BYTES = 2 * 1024 * 1024;

export type SnapshotResult = {
  scanned: number;
  saved: number;
  removed: number;
  skipped: number;
  totalBytes: number;
  /** true bila pemanggil sebaiknya menampilkan peringatan (mis. tabel belum ada). */
  error?: string;
};

export type RestoreResult = {
  restored: number;
  totalBytes: number;
  total: number;
  error?: string;
};

const EMPTY_SNAPSHOT: SnapshotResult = { scanned: 0, saved: 0, removed: 0, skipped: 0, totalBytes: 0 };

/**
 * Pindai sandbox, simpan file yang baru/berubah, hapus catatan yang sudah tidak ada.
 * Perbandingan memakai mtime + size sehingga hanya file berubah yang diambil isinya.
 */
export async function snapshotProjectFiles(
  store: Store,
  ownerId: string,
  projectId: string,
  sandbox: Sandbox,
): Promise<SnapshotResult> {
  try {
    const scanned = await scanSandbox(sandbox);
    if (!scanned.ok) {
      return { ...EMPTY_SNAPSHOT, error: scanned.error };
    }

    let knownMeta = new Map<string, { size: number; mtime: number }>();
    let persistenceError: string | undefined;
    try {
      const metas = await store.listFileMeta(ownerId, projectId);
      knownMeta = new Map(metas.map((m) => [m.path, { size: m.size, mtime: m.mtime }]));
    } catch (err) {
      persistenceError = describeFileStoreError(err);
    }

    const changed = scanned.files.filter((file) => {
      const known = knownMeta.get(file.path);
      if (!known) return true;
      if (known.size !== file.size) return true;
      return Math.abs(known.mtime - file.mtime) > 0.5;
    });

    let saved = 0;
    let totalBytes = 0;
    if (changed.length) {
      const contents = await fetchContents(sandbox, changed);
      const payload = contents.files.map((file) => ({
        path: file.path,
        content: file.content,
        size: file.size,
        mtime: file.mtime,
      }));
      if (payload.length) {
        try {
          saved = await store.upsertFiles(ownerId, projectId, payload);
          totalBytes = payload.reduce((sum, f) => sum + f.size, 0);
        } catch (err) {
          persistenceError = describeFileStoreError(err);
        }
      }
    }

    // Hapus catatan file yang sudah tidak ada di sandbox (hanya bila pemindaian utuh).
    let removed = 0;
    if (!persistenceError && scanned.complete) {
      const present = new Set(scanned.files.map((f) => f.path));
      const gone = [...knownMeta.keys()].filter((path) => !present.has(path));
      if (gone.length) {
        try {
          removed = await store.deleteFiles(ownerId, projectId, gone);
        } catch (err) {
          persistenceError = describeFileStoreError(err);
        }
      }
    }

    return {
      scanned: scanned.files.length,
      saved,
      removed,
      skipped: scanned.skipped,
      totalBytes,
      error: persistenceError,
    };
  } catch (err) {
    return { ...EMPTY_SNAPSHOT, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Tulis seluruh file proyek dari database ke sandbox (dipakai sandbox baru). */
export async function restoreProjectFiles(
  store: Store,
  ownerId: string,
  projectId: string,
  sandbox: Sandbox,
): Promise<RestoreResult> {
  try {
    const files = await store.listFiles(ownerId, projectId);
    if (!files.length) return { restored: 0, totalBytes: 0, total: 0 };

    await runCommand(sandbox, `mkdir -p ${SANDBOX_PROJECT_DIR}`, { cwd: '/', timeoutMs: 30_000 });

    const dirs = new Set<string>();
    for (const file of files) {
      const index = file.path.lastIndexOf('/');
      if (index > 0) dirs.add(`${SANDBOX_PROJECT_DIR}/${file.path.slice(0, index)}`);
    }
    if (dirs.size) {
      await runCommand(sandbox, `mkdir -p ${[...dirs].map((d) => `'${d.replace(/'/g, `'\\''`)}'`).join(' ')}`, {
        cwd: '/',
        timeoutMs: 60_000,
      });
    }

    let restored = 0;
    let totalBytes = 0;
    const queue = [...files];
    // Tulis paralel terbatas: cukup cepat tanpa membanjiri API E2B.
    const workers = Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const file = queue.shift();
        if (!file) return;
        try {
          await sandbox.files.write(`${SANDBOX_PROJECT_DIR}/${file.path}`, file.content);
          restored += 1;
          totalBytes += file.size;
        } catch (err) {
          console.warn(`[files] gagal memulihkan ${file.path}: ${err instanceof Error ? err.message : err}`);
        }
      }
    });
    await Promise.all(workers);

    return { restored, totalBytes, total: files.length };
  } catch (err) {
    return { restored: 0, totalBytes: 0, total: 0, error: describeFileStoreError(err) };
  }
}

/* -------------------------------------------------------------------------- */

type ScanFile = { path: string; size: number; mtime: number };

async function scanSandbox(sandbox: Sandbox): Promise<{ ok: boolean; complete: boolean; files: ScanFile[]; skipped: number; error?: string }> {
  const prune = SKIP_DIRS.map((dir) => `-name ${dir}`).join(' -o ');
  // %T@ = mtime epoch; dibatasi ukuran agar file besar tidak ikut.
  const command = `
cd ${SANDBOX_PROJECT_DIR} 2>/dev/null || { echo "__NO_PROJECT__"; exit 0; }
find . \\( ${prune} \\) -prune -o -type f -size -${MAX_FILE_BYTES}c -printf '%T@\\t%s\\t%p\\n' 2>/dev/null | head -${MAX_FILES * 2}
echo "__SCAN_END__"
`.trim();

  const result = await runCommand(sandbox, command, { cwd: '/', timeoutMs: 60_000 });
  const out = result.stdout ?? '';
  if (out.includes('__NO_PROJECT__')) {
    return { ok: true, complete: true, files: [], skipped: 0, error: undefined };
  }
  // Pemindaian terpotong (head) => jangan hapus apa pun di database.
  const complete = !out.includes('__SCAN_END__') ? false : !isTruncated(out);
  const files: ScanFile[] = [];

  for (const line of out.split('\n')) {
    if (!line.includes('\t')) continue;
    const [mtimeRaw, sizeRaw, ...rest] = line.split('\t');
    const path = rest.join('\t').replace(/^\.\//, '');
    if (!path || path === '__SCAN_END__') continue;
    if (path.includes('\n')) continue;
    files.push({
      path,
      size: Number.parseInt(sizeRaw ?? '0', 10) || 0,
      mtime: Number.parseFloat(mtimeRaw ?? '0') || 0,
    });
  }

  if (files.length > MAX_FILES) {
    return { ok: true, complete: false, files: files.slice(0, MAX_FILES), skipped: files.length - MAX_FILES };
  }
  return { ok: true, complete, files, skipped: 0 };
}

function isTruncated(out: string): boolean {
  return !out.trimEnd().endsWith('__SCAN_END__');
}

/**
 * Ambil isi file terpilih dalam beberapa panggilan (satu perintah per batch).
 * Base64 dipakai supaya isi file (termasuk baris baru & karakter khusus) tidak
 * merusak format keluaran, dengan penanda antar-file.
 */
async function fetchContents(
  sandbox: Sandbox,
  files: ScanFile[],
): Promise<{ files: Array<{ path: string; content: string; size: number; mtime: number }> }> {
  const out: Array<{ path: string; content: string; size: number; mtime: number }> = [];

  for (const batch of buildBatches(files)) {
    const list = batch.map((f) => f.path).join('\n');
    const command = `
cd ${SANDBOX_PROJECT_DIR}
while IFS= read -r p; do
  [ -f "$p" ] || continue
  printf '<<<ACFILE:%s>>>' "$p"
  base64 -w0 -- "$p" 2>/dev/null || true
  printf '<<<ACEND>>>\\n'
done <<'AC_LIST'
${list}
AC_LIST
`.trim();

    const result = await runCommand(sandbox, command, { cwd: '/', timeoutMs: 90_000 });
    const parsed = parseBatch(result.stdout ?? '');
    const byPath = new Map(parsed.map((entry) => [entry.path, entry.content]));

    for (const file of batch) {
      const base64 = byPath.get(file.path);
      if (base64 === undefined) continue; // file hilang/berubah di tengah jalan
      const buffer = Buffer.from(base64, 'base64');
      // File biner tidak disimpan: isinya akan rusak bila diperlakukan sebagai teks.
      if (buffer.includes(0)) continue;
      out.push({ path: file.path, content: buffer.toString('utf8'), size: buffer.byteLength, mtime: file.mtime });
    }
  }

  return { files: out };
}

function buildBatches(files: ScanFile[]): ScanFile[][] {
  const batches: ScanFile[][] = [];
  let current: ScanFile[] = [];
  let bytes = 0;
  for (const file of files) {
    if (current.length && (bytes + file.size > MAX_BATCH_BYTES || current.length >= 15)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += file.size;
  }
  if (current.length) batches.push(current);
  return batches;
}

function parseBatch(stdout: string): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  const pattern = /<<<ACFILE:(.+?)>>>(.*?)<<<ACEND>>>/gs;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stdout)) !== null) {
    out.push({ path: match[1], content: match[2].replace(/\s+/g, '') });
  }
  return out;
}

/** Pesan yang ramah untuk error penyimpanan file (mis. tabel belum dibuat). */
export function describeFileStoreError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const missingTable =
    /ac_files/i.test(message) && /(does not exist|tidak ada|not find|undefined table|relation)/i.test(message);
  if (missingTable) {
    return (
      'Tabel `ac_files` belum ada di database, jadi file proyek belum bisa disimpan. ' +
      'Jalankan SQL di `supabase/migrations/002_ac_files.sql` pada SQL Editor Supabase, lalu muat ulang halaman.'
    );
  }
  return `Penyimpanan file proyek gagal: ${message}`;
}

export function summarizeSnapshot(result: SnapshotResult): string {
  if (result.error) return result.error;
  if (!result.saved && !result.removed && !result.scanned) return '';
  const parts: string[] = [];
  if (result.saved) parts.push(`${result.saved} file disimpan (${humanSize(result.totalBytes)})`);
  if (result.removed) parts.push(`${result.removed} file dihapus dari catatan`);
  if (result.skipped) parts.push(`${result.skipped} file dilewati karena terlalu besar`);
  return parts.length ? `Penyimpanan proyek: ${parts.join(', ')}.` : '';
}
