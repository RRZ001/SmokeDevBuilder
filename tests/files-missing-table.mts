/**
 * Uji perilaku fallback saat tabel `ac_files` GAGAL (mis. belum dibuat di Supabase).
 *
 * Memakai store tiruan supaya tidak bergantung jaringan maupun versi Node
 * (supabase-js butuh WebSocket native di Node 22+, sedangkan sandbox uji ini
 * memakai Node 20 - lihat catatan di AGENTS.md).
 *
 * Yang diharapkan:
 *  1. status penyimpanan UTAMA tidak ikut dilaporkan gagal,
 *  2. peringatan khusus penyimpanan file tercatat (dipakai UI),
 *  3. pesan ramah berisi instruksi menjalankan file SQL,
 *  4. snapshot tidak melempar error ke pemanggil.
 */
import { SqliteStore } from '@/lib/db/sqlite';
import { withFallback, getFilesPersistenceWarning } from '@/lib/db';
import type { Store, FileMeta } from '@/lib/db/types';
import { describeFileStoreError, snapshotProjectFiles } from '@/lib/project-files';

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, extra = '') => results.push([name, ok, extra]);

/** Store tiruan: semua normal KECUALI metode file (meniru tabel belum ada). */
function makePrimary(): { store: Store; calls: string[] } {
  const calls: string[] = [];
  const missing = () => {
    throw new Error('[supabase:listFileMeta] Could not find the table \'public.ac_files\' in the schema cache');
  };
  const store = {
    async ping() {},
    async getSettings() {
      return null;
    },
    async saveSettings() {
      throw new Error('tidak dipakai');
    },
    async listProjects() {
      return [];
    },
    async getProject() {
      return null;
    },
    async createProject() {
      throw new Error('tidak dipakai');
    },
    async updateProject() {
      return null;
    },
    async deleteProject() {},
    async listMessages() {
      return [];
    },
    async addMessage() {
      throw new Error('tidak dipakai');
    },
    async clearMessages() {},
    async listFileMeta(): Promise<FileMeta[]> {
      calls.push('listFileMeta');
      missing();
      return [];
    },
    async listFiles() {
      calls.push('listFiles');
      missing();
      return [];
    },
    async upsertFiles() {
      calls.push('upsertFiles');
      missing();
      return 0;
    },
    async deleteFiles() {
      calls.push('deleteFiles');
      return 0;
    },
    async countFiles() {
      calls.push('countFiles');
      missing();
      return 0;
    },
  } as unknown as Store;
  return { store, calls };
}

const fallback = new SqliteStore(':memory:');
const primary = makePrimary();
const store = withFallback(primary.store, fallback);

// 1. metode non-file tetap lewat store utama
const projects = await store.listProjects('owner-1');
check('metode non-file tetap dilayani store utama', Array.isArray(projects) && primary.calls.length === 0);

// 2. metode file gagal -> otomatis dialihkan ke SQLite + tercatat peringatan
const meta = await store.listFileMeta('owner-1', 'project-1');
check('listFileMeta gagal dialihkan ke SQLite (tidak melempar)', Array.isArray(meta), `calls=${primary.calls.join(',')}`);
check('pemanggilan file memang dicatat', primary.calls.includes('listFileMeta'));

const warning = getFilesPersistenceWarning();
check('peringatan penyimpanan file tercatat untuk UI', Boolean(warning), String(warning ?? '').slice(0, 70));
check('peringatan menyebut ac_files', /ac_files/i.test(String(warning)));

// 3. pesan ramah berisi instruksi SQL
const friendly = describeFileStoreError(
  new Error("[supabase:listFileMeta] Could not find the table 'public.ac_files'"),
);
check('pesan ramah menyebut file SQL yang harus dijalankan', /002_ac_files\.sql/.test(friendly));
check('pesan ramah menjelaskan akibatnya', /belum bisa disimpan/i.test(friendly));

// 4. snapshot pada sandbox yang rusak -> error dikembalikan, bukan dilempar
const brokenSandbox = {
  sandboxId: 'x',
  commands: {
    run: async () => {
      throw new Error('sandbox tidak ada');
    },
  },
} as never;
const snapshot = await snapshotProjectFiles(store, 'owner-1', 'project-1', brokenSandbox);
check('snapshot gagal dengan pesan, bukan crash', Boolean(snapshot.error), String(snapshot.error ?? '').slice(0, 50));

// 5. SQLite tetap bisa menyimpan file (mode fallback tetap fungsional)
const saved = await fallback.upsertFiles('owner-1', 'project-1', [
  { path: 'a.js', content: 'x', size: 1, mtime: 1 },
]);
check('fallback SQLite tetap bisa menyimpan file', saved === 1 && (await fallback.countFiles('owner-1', 'project-1')) === 1);

let pass = 0;
for (const [name, ok, extra] of results) {
  if (ok) pass += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
}
console.log(`\n==== ${pass}/${results.length} lulus ====`);
process.exit(pass === results.length ? 0 : 1);
