/**
 * Uji kesiapan & pemulihan preview memakai sandbox TIRUAN — tanpa kredit E2B.
 *
 * Yang diuji:
 *  1. Logika murni: parse readiness, cakupan bind, deteksi halaman error proxy
 *     E2B, penyusunan flag bind 0.0.0.0, registry server (termasuk JSON rusak).
 *  2. Skenario nyata dari bug "Closed Port Error": server hanya listen di
 *     127.0.0.1 → start_server HARUS menjalankan ulang dengan bind 0.0.0.0 dan
 *     hanya menyatakan siap setelah URL publik benar-benar melayani.
 *  3. Server yang prosesnya langsung mati → lapor tidak siap (jangan simpan
 *     perintahnya untuk pemulihan otomatis).
 *  4. Pemulihan otomatis: perintah tersimpan di folder sandbox dipakai untuk
 *     menjalankan ulang server setelah sandbox bangun dari pause.
 */
import type { Sandbox } from '@e2b/code-interpreter';
import {
  decideServerReadiness,
  detectFrameworkFromPackageJson,
  evaluatePublicProbe,
  hostOverrideFor,
  parseListenScope,
  parseReadiness,
  parseServerRegistry,
  planPreviewRecovery,
  serializeServerRegistry,
} from '@/lib/sandbox/preview-status';
import { SERVER_REGISTRY_PATH, reviveServer, startServer } from '@/lib/sandbox/tools';

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const E2B_CLOSED_PORT_PAGE =
  '<html><body>Closed Port Error: The sandbox is running but there\'s no service running on port 3000. ' +
  'Connection refused on port 3000</body></html>';

/* ------------------------------------------------------------------ 1. murni */

console.log('\n[1] logika murni');
check('parseReadiness READY', parseReadiness('READY 200').state === 'ready');
check('parseReadiness READY membawa kode', parseReadiness('READY 304').code === '304');
check('parseReadiness DEAD', parseReadiness('bash: line 2: kill: DEAD').state === 'dead');
check('parseReadiness TIMEOUT', parseReadiness('TIMEOUT').state === 'timeout');
check('parseReadiness kosong = unknown', parseReadiness('').state === 'unknown');

check('bind 0.0.0.0 = all', parseListenScope('0.0.0.0:3000', 3000) === 'all');
check('bind [::] = all', parseListenScope('[::]:3000', 3000) === 'all');
check('bind * = all', parseListenScope('*:3000', 3000) === 'all');
check('bind 127.0.0.1 = loopback', parseListenScope('127.0.0.1:3000', 3000) === 'loopback');
check('bind [::1] = loopback', parseListenScope('[::1]:3000', 3000) === 'loopback');
check('port lain diabaikan', parseListenScope('0.0.0.0:4000', 3000) === 'none');
check('tidak ada apa-apa = none', parseListenScope('', 3000) === 'none');

check('halaman Closed Port Error terdeteksi', evaluatePublicProbe(502, E2B_CLOSED_PORT_PAGE).proxyError === true);
check('halaman error proxy => tidak online', evaluatePublicProbe(502, E2B_CLOSED_PORT_PAGE).online === false);
check('200 dari aplikasi => online', evaluatePublicProbe(200, '<h1>Hello</h1>').online === true);
check('500 dari aplikasi tetap online (server hidup)', evaluatePublicProbe(500, 'boom').online === true);
check('404 tetap online (server hidup)', evaluatePublicProbe(404, 'not found').online === true);
check('gateway 504 => tidak online', evaluatePublicProbe(504, '').online === false);
check('request gagal (000) => tidak online', evaluatePublicProbe(0, '').online === false);

check('vite dapat --host', hostOverrideFor('vite --port 3000') === 'vite --port 3000 --host 0.0.0.0');
check('node biasa tidak bisa ditambal', hostOverrideFor('node server.js') === null);
check('yang sudah bind 0.0.0.0 tidak ditambal', hostOverrideFor('vite --host 0.0.0.0') === null);
check(
  'framework dari package.json dipakai untuk perintah generik',
  hostOverrideFor('npm run dev', 'vite') === 'npm run dev -- --host 0.0.0.0',
);
check(
  'deteksi framework: Next.js dari dependencies',
  detectFrameworkFromPackageJson(JSON.stringify({ dependencies: { next: '15.5.0' } })) === 'next',
);
check(
  'deteksi framework: Vite dari devDependencies',
  detectFrameworkFromPackageJson(JSON.stringify({ devDependencies: { vite: '^5' } })) === 'vite',
);
check('deteksi framework: package.json rusak aman', detectFrameworkFromPackageJson('{rusak') === null);

check(
  'readiness: loopback + halaman error proxy => tidak siap + sebut 0.0.0.0',
  !decideServerReadiness({
    localCode: '200',
    listenScope: 'loopback',
    publicProbe: evaluatePublicProbe(502, E2B_CLOSED_PORT_PAGE),
  }).ready,
);
check(
  'readiness: 0.0.0.0 + url publik ok => siap',
  decideServerReadiness({
    localCode: '200',
    listenScope: 'all',
    publicProbe: evaluatePublicProbe(200, 'ok'),
  }).ready,
);
check(
  'readiness: jaringan gagal tapi lokal ok & bind 0.0.0.0 => siap dengan peringatan',
  (() => {
    const d = decideServerReadiness({
      localCode: '200',
      listenScope: 'all',
      publicProbe: evaluatePublicProbe(0, ''),
    });
    return d.ready && Boolean(d.warning);
  })(),
);

check(
  'registry: JSON rusak tidak bikin error',
  parseServerRegistry('{bukan json').length === 0,
);
check(
  'registry: entri tidak sah dibuang',
  parseServerRegistry('[{"port":"x","command":"npm run dev"},{"port":3000,"command":"vite"}]').length === 1,
);
check(
  'registry: tulis-baca bolak-balik konsisten',
  parseServerRegistry(serializeServerRegistry([{ port: 3000, command: 'vite', cwd: '/home/user/project', startedAt: 1 }]))
    .length === 1,
);

check(
  'recovery: ada catatan perintah + port mati => revive',
  planPreviewRecovery({ publicOnline: false, localCode: '000', listenScope: 'none', hasServerRecord: true }).action === 'revive',
);
check(
  'recovery: tanpa catatan perintah => tidak revive (jelaskan ke user)',
  planPreviewRecovery({ publicOnline: false, localCode: '000', listenScope: 'none', hasServerRecord: false }).action === 'none',
);
check(
  'recovery: sudah online => tidak ada aksi',
  planPreviewRecovery({ publicOnline: true, localCode: '200', listenScope: 'all', hasServerRecord: true }).action === 'none',
);

/* ------------------------------------------------------- 2. sandbox tiruan */

type Scenario = {
  /** cakupan bind yang dilaporkan sandbox saat server sudah jalan */
  scope: 'all' | 'loopback';
  /** proses langsung mati (mis. npm run dev gagal karena node_modules hilang) */
  diesImmediately?: boolean;
  logs?: string;
};

class FakeSandbox {
  fs = new Map<string, string>();
  starts: string[] = [];

  files = {
    read: async (path: string) => {
      const value = this.fs.get(path);
      if (value == null) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    write: async (path: string, content: string) => {
      this.fs.set(path, content);
      return { path };
    },
  };

  constructor(private scenario: Scenario) {}

  get sandboxId() {
    return 'fake-sandbox-preview';
  }

  getHost(port: number) {
    return `3000-fake.e2b.dev`.replace('3000', String(port));
  }

  /** Server baru dianggap hidup setelah perintah dijalankan; bind mengikuti skenario. */
  commands = {
    run: async (command: string, options: { background?: boolean } = {}) => {
      if (options.background) {
        this.starts.push(command);
        return { pid: 4242, stdout: this.scenario.logs ?? '', stderr: '', exitCode: 0 };
      }
      // Skrip penunggu kesiapan
      if (command.includes('kill -0')) {
        if (this.scenario.diesImmediately) return { pid: 1, stdout: 'DEAD\n', stderr: '', exitCode: 2 };
        return { pid: 1, stdout: 'READY 200\n', stderr: '', exitCode: 0 };
      }
      // Cek lokal: status HTTP + alamat bind
      if (command.includes('CODE')) {
        const up = !this.scenario.diesImmediately;
        const addr = this.scenario.scope === 'all' ? '0.0.0.0:3000' : '127.0.0.1:3000';
        return {
          pid: 1,
          stdout: `CODE ${up ? '200' : '000'}\nSCAN ok\n${up ? addr : ''}\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      // Perintah sapu bersih (fuser/pkill)
      return { pid: 1, stdout: '', stderr: '', exitCode: 0 };
    },
    kill: async () => true,
  };

  asSandbox(): Sandbox {
    return this as unknown as Sandbox;
  }
}

console.log('\n[2] skenario "Closed Port Error" (server hanya listen di 127.0.0.1)');
{
  const fake = new FakeSandbox({ scope: 'loopback' });
  // Proyek Vite nyata: perintahnya generik (`npm run dev`), framework dikenali dari package.json.
  fake.fs.set('/home/user/project/package.json', JSON.stringify({ dependencies: { vite: '^5.0.0' } }));
  let publicCalls = 0;
  const probePublic = async () => {
    publicCalls += 1;
    // Loopback ditolak proxy E2B; setelah bind 0.0.0.0 baru melayani.
    return publicCalls > 1
      ? evaluatePublicProbe(200, '<h1>app</h1>')
      : evaluatePublicProbe(502, E2B_CLOSED_PORT_PAGE);
  };
  const res = await startServer(fake.asSandbox(), 'npm run dev -- --port 3000', 3000, { probePublic });

  check('server dijalankan ulang otomatis', res.rebound === true, res.command);
  check('pakai --host 0.0.0.0 (dari package.json Vite)', /--host 0\.0\.0\.0/.test(res.command), res.command);
  check('siap hanya setelah URL publik melayani', res.ready === true);
  check('urutan start: 2 percobaan', fake.starts.length === 2, JSON.stringify(fake.starts));
  check('perintah tersimpan di registry sandbox', fake.fs.has(SERVER_REGISTRY_PATH));
  check(
    'perintah tersimpan = perintah yang sudah diperbaiki',
    (fake.fs.get(SERVER_REGISTRY_PATH) ?? '').includes('--host 0.0.0.0'),
    fake.fs.get(SERVER_REGISTRY_PATH),
  );
}

console.log('\n[2b] proyek Next.js & perintah tanpa pemisah "--"');
{
  const fake = new FakeSandbox({ scope: 'loopback' });
  fake.fs.set('/home/user/project/package.json', JSON.stringify({ dependencies: { next: '15.5.0' } }));
  let calls = 0;
  const res = await startServer(fake.asSandbox(), 'npm run dev', 3000, {
    probePublic: async () => {
      calls += 1;
      return calls > 1 ? evaluatePublicProbe(200, 'ok') : evaluatePublicProbe(502, E2B_CLOSED_PORT_PAGE);
    },
  });
  check('Next.js dapat --hostname 0.0.0.0', /--hostname 0\.0\.0\.0/.test(res.command), res.command);
  check('pemisah -- disisipkan untuk npm run', /npm run dev -- --hostname/.test(res.command), res.command);
  check('siap setelah dijalankan ulang', res.ready === true);
}

console.log('\n[3] server gagal start (proses langsung mati)');
{
  const fake = new FakeSandbox({ scope: 'all', diesImmediately: true, logs: 'Error: Cannot find module express' });
  const res = await startServer(fake.asSandbox(), 'node server.js', 3000, {
    probePublic: async () => evaluatePublicProbe(0, ''),
  });

  check('tidak dinyatakan siap', res.ready === false);
  check('log penyebab diteruskan ke agent', res.logs.includes('Cannot find module'), res.logs);
  check('alasan menjelaskan server tidak mendengarkan', Boolean(res.reason), String(res.reason));
  check('perintah gagal TIDAK disimpan (hindari pemulihan sia-sia)', !fake.fs.has(SERVER_REGISTRY_PATH));
}

console.log('\n[4] pemulihan otomatis setelah sandbox bangun dari pause');
{
  // Sandbox yang sudah punya catatan perintah dari sesi sebelumnya (server mati).
  const fake = new FakeSandbox({ scope: 'all' });
  fake.fs.set(
    SERVER_REGISTRY_PATH,
    serializeServerRegistry([{ port: 3000, command: 'npm run dev -- --host 0.0.0.0', cwd: '/home/user/project', startedAt: 1 }]),
  );
  const outcome = await reviveServer(fake.asSandbox(), 3000, {
    probePublic: async () => evaluatePublicProbe(200, 'ok'),
  });

  check('revive dijalankan', outcome.attempted === true);
  check('perintah tersimpan dipakai ulang', outcome.command === 'npm run dev -- --host 0.0.0.0', String(outcome.command));
  check('preview kembali siap', outcome.ready === true);
}
{
  // Sandbox yang sudah ada catatannya tapi servernya tetap tidak bisa hidup.
  const fake = new FakeSandbox({ scope: 'loopback' });
  fake.fs.set(
    SERVER_REGISTRY_PATH,
    serializeServerRegistry([{ port: 3000, command: 'node server.js', cwd: '/home/user/project', startedAt: 1 }]),
  );
  const outcome = await reviveServer(fake.asSandbox(), 3000, {
    probePublic: async () => evaluatePublicProbe(502, E2B_CLOSED_PORT_PAGE),
  });
  check('revive dicoba', outcome.attempted === true);
  check('tetap tidak siap -> alasan diteruskan ke UI', outcome.ready === false && Boolean(outcome.reason), String(outcome.reason));
}
{
  const fake = new FakeSandbox({ scope: 'all' });
  const outcome = await reviveServer(fake.asSandbox(), 3000, { probePublic: async () => evaluatePublicProbe(0, '') });
  check('tanpa catatan perintah: tidak ada yang dijalankan', outcome.attempted === false);
}

console.log(`\nhasil: ${pass} ok, ${fail} gagal`);
if (fail > 0) process.exit(1);
