// Uji migrasi kolom baru pada database SQLite LAMA (skema sebelum deploy).
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const file = join(tmpdir(), `ac-mig-${Date.now()}.sqlite`);
const old = new Database(file);
old.exec(`
  CREATE TABLE ac_settings (owner_id TEXT PRIMARY KEY, openrouter_api_key TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
  CREATE TABLE ac_projects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', sandbox_id TEXT, preview_port INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  INSERT INTO ac_settings VALUES ('o1','sk-old','model-x','2026-01-01');
  INSERT INTO ac_projects VALUES ('p1','o1','Kasir','',NULL,NULL,'2026-01-01','2026-01-01');
`);
old.close();

const { SqliteStore } = await import('@/lib/db/sqlite');
const store = new SqliteStore(file);
const s = await store.getSettings('o1');
const p = await store.getProject('o1','p1');
const checks = [
  ['settings lama tetap terbaca', s?.openrouter_api_key === 'sk-old'],
  ['kolom vercel_token ada (default kosong)', s?.vercel_token === ''],
  ['kolom vercel_scope ada', s?.vercel_scope === ''],
  ['proyek lama tetap terbaca', p?.name === 'Kasir'],
  ['deploy_url default null', p?.deploy_url === null],
  ['deploy_at default null', p?.deploy_at === null],
];
const saved = await store.saveSettings('o1', { vercel_token: 'tok-123', vercel_scope: 'tim' });
checks.push(['simpan token berhasil', saved.vercel_token === 'tok-123' && saved.vercel_scope === 'tim']);
checks.push(['api key lama tidak hilang', saved.openrouter_api_key === 'sk-old']);
const upd = await store.updateProject('o1','p1', { deploy_url: 'https://kasir.vercel.app', deploy_at: '2026-10-13T00:00:00Z' });
checks.push(['simpan link deploy berhasil', upd?.deploy_url === 'https://kasir.vercel.app']);
const again = new SqliteStore(file);
checks.push(['migrasi idempotent (dibuka dua kali)', (await again.getSettings('o1'))?.vercel_token === 'tok-123']);
let ok = 0;
for (const [name, pass] of checks) { console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`); if (pass) ok++; }
console.log(`\n${ok}/${checks.length} lulus`);
rmSync(file, { force: true }); rmSync(`${file}-wal`, { force: true }); rmSync(`${file}-shm`, { force: true });
process.exit(ok === checks.length ? 0 : 1);
