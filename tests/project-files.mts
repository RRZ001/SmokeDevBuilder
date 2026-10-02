/**
 * Uji persistensi file proyek (snapshot & restore) memakai sandbox TIRUAN.
 * Tidak butuh E2B/kredit: emulasi `commands.run` (find + base64) dan `files.write`.
 * Store memakai SQLite in-memory.
 */
import { SqliteStore } from '@/lib/db/sqlite';
import { restoreProjectFiles, snapshotProjectFiles, summarizeSnapshot } from '@/lib/project-files';

/* ---------------------------------------------------------------- sandbox palsu */

class FakeSandbox {
  /** filesystem tiruan */
  fs = new Map<string, { content: Buffer; mtime: number }>();
  /** API `sandbox.files` yang dipakai restoreProjectFiles */
  files: { write: (absPath: string, content: string) => Promise<{ path: string }> };
  writes: string[] = [];

  /**
   * Harness mock: SELALU simpan sebagai Buffer. Sebelumnya fixture ditulis
   * sebagai string sehingga `content.toString('base64')` di mock mengembalikan
   * teks mentah (String.toString mengabaikan argumen) dan uji jadi gagal palsu.
   */
  put(path: string, content: string | Buffer, mtime: number): void {
    this.fs.set(path, {
      content: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
      mtime,
    });
  }

  constructor(initial: Record<string, { content: string | Buffer; mtime: number }> = {}) {
    for (const [path, value] of Object.entries(initial)) {
      this.put(path, value.content, value.mtime);
    }
    this.files = {
      write: async (absPath: string, content: string) => {
        const rel = absPath.replace('/home/user/project/', '');
        this.writes.push(rel);
        this.fs.set(rel, { content: Buffer.from(content, 'utf8'), mtime: Date.now() / 1000 });
        return { path: absPath };
      },
    };
  }

  get sandboxId() {
    return 'fake-sandbox';
  }

  commands = {
    run: async (command: string) => {
      // --- pemindaian (find) ---
      if (command.includes('find .') && command.includes('__SCAN_END__')) {
        const skip = [...command.matchAll(/-name ([A-Za-z0-9_.-]+)/g)].map((m) => m[1]);
        const maxSize = Number(command.match(/-size -(\d+)c/)?.[1] ?? Number.MAX_SAFE_INTEGER);
        const lines: string[] = [];
        for (const [path, file] of this.fs) {
          const segments = path.split('/');
          if (segments.some((s) => skip.includes(s))) continue;
          if (file.content.byteLength >= maxSize) continue;
          lines.push(`${file.mtime.toFixed(6)}\t${file.content.byteLength}\t./${path}`);
        }
        return { exitCode: 0, stdout: `${lines.join('\n')}\n__SCAN_END__`, stderr: '' };
      }

      // --- pengambilan isi (base64) ---
      if (command.includes('AC_LIST')) {
        const list = command.split("<<'AC_LIST'\n")[1].split('\nAC_LIST')[0];
        let out = '';
        for (const path of list.split('\n').filter(Boolean)) {
          const file = this.fs.get(path);
          if (!file) continue;
          out += `<<<ACFILE:${path}>>>${file.content.toString('base64')}<<<ACEND>>>\n`;
        }
        return { exitCode: 0, stdout: out, stderr: '' };
      }

      // --- mkdir ---
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };

  filesApi = {
    write: async (absPath: string, content: string) => {
      const path = absPath.replace('/home/user/project/', '');
      this.writes.push(path);
      this.files.set(path, { content: Buffer.from(content, 'utf8'), mtime: Date.now() / 1000 });
      return { path: absPath };
    },
  };
}

/* ---------------------------------------------------------------------- uji */

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, extra = '') => results.push([name, ok, extra]);

const store = new SqliteStore(':memory:');
const OWNER = 'owner-uji-123456';
const PID = 'project-uji-1';

const small = (n: number) => Array.from({ length: n }, (_, i) => `console.log(${i});`).join('\n');

const sandbox = new FakeSandbox({
  'package.json': { content: JSON.stringify({ name: 'werewolf-game', scripts: { dev: 'next dev' } }), mtime: 1000 },
  'server.js': { content: small(200), mtime: 1000 },
  'app/page.tsx': { content: small(300), mtime: 1000 },
  'components/GameView.tsx': { content: small(250), mtime: 1000 },
  'node_modules/next/index.js': { content: small(5000), mtime: 1000 },
  '.next/build.js': { content: small(100), mtime: 1000 },
  'public/logo.png': { content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]), mtime: 1000 },
  'big.bin.txt': { content: 'x'.repeat(300 * 1024), mtime: 1000 },
});

// 1. snapshot pertama
const first = await snapshotProjectFiles(store, OWNER, PID, sandbox as never);
check('snapshot pertama menyimpan file proyek', first.saved === 4, `saved=${first.saved} scanned=${first.scanned} skipped=${first.skipped}`);
check('node_modules & .next tidak disimpan', !(await store.listFileMeta(OWNER, PID)).some((f) => f.path.includes('node_modules') || f.path.startsWith('.next')));
check('file biner tidak disimpan', !(await store.listFileMeta(OWNER, PID)).some((f) => f.path.endsWith('.png')));
check('file >256KB dilewati', !(await store.listFileMeta(OWNER, PID)).some((f) => f.path === 'big.bin.txt'));
check('isi file tersimpan benar', (await store.listFiles(OWNER, PID)).find((f) => f.path === 'server.js')?.content === small(200));

// 2. snapshot kedua tanpa perubahan -> tidak ada yang dikirim ulang
const second = await snapshotProjectFiles(store, OWNER, PID, sandbox as never);
check('snapshot kedua tanpa perubahan: 0 file dikirim (hemat)', second.saved === 0, `saved=${second.saved}`);

// 3. mengubah satu file -> hanya file itu yang dikirim
sandbox.put('app/page.tsx', `${small(300)}\n// revisi`, 2000);
const third = await snapshotProjectFiles(store, OWNER, PID, sandbox as never);
check('hanya file berubah yang dikirim ulang', third.saved === 1, `saved=${third.saved}`);
const pageFile = (await store.listFiles(OWNER, PID)).find((f) => f.path === 'app/page.tsx');
check('revisi tersimpan', pageFile?.content?.includes('revisi') === true, `len=${pageFile?.content?.length}`);

// 4. menghapus file di sandbox -> catatan di database dihapus
sandbox.fs.delete('components/GameView.tsx');
const fourth = await snapshotProjectFiles(store, OWNER, PID, sandbox as never);
check('file yang dihapus ikut dibersihkan dari database', fourth.removed === 1, `removed=${fourth.removed}`);
check('jumlah file di database menyusut', (await store.countFiles(OWNER, PID)) === 3, `count=${await store.countFiles(OWNER, PID)}`);

// 5. restore ke sandbox BARU (kosong) -> proyek bisa dijalankan lagi
const fresh = new FakeSandbox();
const restore = await restoreProjectFiles(store, OWNER, PID, fresh as never);
check('restore menulis semua file ke sandbox baru', restore.restored === 3, `restored=${restore.restored}/${restore.total}`);
check('isi file sama persis setelah restore', fresh.fs.get('server.js')?.content.toString('utf8') === small(200));
check('revisi ikut dipulihkan', fresh.fs.get('app/page.tsx')?.content.toString('utf8').includes('revisi') === true);
check('file yang sudah dihapus tidak dipulihkan', !fresh.fs.has('components/GameView.tsx'));

// 6. ringkasan untuk UI
const summary = summarizeSnapshot(third);
check('ringkasan snapshot bisa dibaca user', /disimpan/.test(summary), summary);

/* -------------------------------------------------------------------- hasil */
let pass = 0;
for (const [name, ok, extra] of results) {
  if (ok) pass += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
}
console.log(`\n==== ${pass}/${results.length} lulus ====`);
process.exit(pass === results.length ? 0 : 1);
