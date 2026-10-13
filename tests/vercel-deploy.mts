/**
 * Uji logika DEPLOY ke Vercel — MURNI + sandbox tiruan, tanpa kredit E2B, tanpa
 * panggilan jaringan.
 *
 * Yang paling penting diuji di sini:
 *  1. Token user TIDAK PERNAH bocor ke keluaran (log/UI/model) — disaring
 *     `redactSecrets()` dan dikirim lewat `envs` perintah, bukan argumen.
 *  2. Status deploy dibaca benar: "Inspect: https://vercel.com/..." muncul saat
 *     proses MASIH berjalan, jadi keberadaan URL saja bukan tanda selesai.
 *  3. Link yang ditampilkan adalah alias produksi yang stabil
 *     (https://<nama>.vercel.app), bukan URL ber-hash yang berubah tiap deploy.
 *  4. Deploy dijalankan sebagai proses LATAR (tahan batas durasi fungsi hosting)
 *     dan keluarannya dibaca dari file log.
 */
import type { Sandbox } from '@e2b/code-interpreter';
import {
  DEPLOY_LOG_PATH,
  buildDeployCommand,
  deployShellCommand,
  explainDeployError,
  extractDeployUrls,
  parseDeployStatus,
  pickPrimaryUrl,
  productionAlias,
  redactSecrets,
  toVercelProjectName,
} from '@/lib/deploy/vercel';
import { TOOL_DEFINITIONS, deployToVercel, executeTool } from '@/lib/sandbox/tools';

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

const TOKEN = 'vercel_tok_ABC123def456GHI789jkl';

/* ------------------------------------------------------------------ 1. murni */

console.log('\n[1] nama proyek & perintah');
{
  check('spasi jadi tanda hubung', toVercelProjectName('Sistem Kasir') === 'sistem-kasir', toVercelProjectName('Sistem Kasir'));
  check('huruf besar jadi kecil', toVercelProjectName('TokoOnline') === 'tokoonline');
  check('karakter aneh dibuang', toVercelProjectName('app_ku (v2)!') === 'app-ku-v2', toVercelProjectName('app_ku (v2)!'));
  check('tanda hubung ganda dirapikan', toVercelProjectName('a---b') === 'a-b');
  check('kosong -> nama default', toVercelProjectName('   ') === 'agentcloud-app');
  check('nama panjang dipotong', toVercelProjectName('x'.repeat(80)).length <= 52);

  const cmd = buildDeployCommand({ projectName: 'Sistem Kasir', scope: 'tim-saya' });
  check('deploy prod non-interaktif', /vercel@latest deploy --yes --prod/.test(cmd), cmd);
  check('nama proyek ikut', /--name sistem-kasir/.test(cmd), cmd);
  check('scope ikut bila diisi', /--scope tim-saya/.test(cmd), cmd);
  check('TANPA flag --token (token lewat env)', !/--token/.test(cmd), cmd);
  check('preview deploy tanpa --prod', !/ --prod/.test(buildDeployCommand({ prod: false })));

  check('perintah latar menulis ke file log', deployShellCommand('npx vercel deploy').includes('> ' + DEPLOY_LOG_PATH));
  check('alias produksi stabil', productionAlias('Sistem Kasir') === 'https://sistem-kasir.vercel.app');
}

console.log('\n[2] token tidak pernah bocor');
{
  const log = [
    'Vercel CLI 37.0.0',
    `> Using token ${TOKEN}`,
    `VERCEL_TOKEN=${TOKEN}`,
    `npx vercel deploy --yes --prod --token=${TOKEN}`,
    'https://sistem-kasir-abc123.vercel.app',
  ].join('\n');
  const safe = redactSecrets(log, TOKEN);
  check('nilai token hilang dari keluaran', !safe.includes(TOKEN), safe.slice(0, 120));
  check('Token yang muncul di "VERCEL_TOKEN=" dimasking', !/VERCEL_TOKEN=vercel_tok/.test(safe), safe);
  check('Argumen --token dimasking walau nilainya tak diketahui', redactSecrets('deploy --token=abcdEFGH12345').includes('--token=••••••'));
  check('URL deploy tetap terbaca setelah penyaringan', safe.includes('https://sistem-kasir-abc123.vercel.app'));
  check('teks tanpa token tidak diubah', redactSecrets('deploy selesai', TOKEN) === 'deploy selesai');
}

console.log('\n[3] status dari log CLI');
{
  const running = 'Vercel CLI 37.0.0\n🔍  Inspect: https://vercel.com/team/app/abc123 [2s]\n';
  const runningStatus = parseDeployStatus(running);
  check('URL inspect saja BUKAN tanda selesai', runningStatus.state === 'running', JSON.stringify(runningStatus));
  check('URL vercel.com tidak dianggap link deploy', runningStatus.urls.length === 0, JSON.stringify(runningStatus.urls));

  const done = [
    'Vercel CLI 37.0.0',
    '🔍  Inspect: https://vercel.com/team/sistem-kasir/abc123 [12s]',
    '✅  Production: https://sistem-kasir-abc123xyz.vercel.app [12s]',
  ].join('\n');
  const doneStatus = parseDeployStatus(done, { projectName: 'Sistem Kasir' });
  check('baris Production = selesai', doneStatus.state === 'done', JSON.stringify(doneStatus));
  check('link yang dipilih = alias stabil (tanpa hash)', doneStatus.url === 'https://sistem-kasir.vercel.app', String(doneStatus.url));
  check('URL ber-hash tetap tercatat untuk diagnosa', doneStatus.urls.some((u) => u.includes('abc123xyz')), JSON.stringify(doneStatus.urls));

  const failed = 'Vercel CLI 37.0.0\nError: The specified token is not valid\n';
  const failedStatus = parseDeployStatus(failed);
  check('error token = gagal', failedStatus.state === 'failed', JSON.stringify(failedStatus));
  check('pesan error disimpan', /token is not valid/i.test(failedStatus.error ?? ''), String(failedStatus.error));
  check('error token dijelaskan ramah', /Buat token baru di vercel\.com\/account\/tokens/.test(explainDeployError(failedStatus.error)));

  check('log kosong = masih berjalan', parseDeployStatus('').state === 'running');
  check('kuota habis dijelaskan', /Kuota deploy Vercel harian/.test(explainDeployError('Error: No more than 100 deployments per day')));

  const alias = parseDeployStatus('✅  Production: https://sistem-kasir.vercel.app [9s]', { projectName: 'Sistem Kasir' });
  check('alias yang sudah ada dipakai apa adanya', alias.url === 'https://sistem-kasir.vercel.app', String(alias.url));

  check('ekstraksi URL unik & bersih', JSON.stringify(extractDeployUrls('a https://x-1.vercel.app. b https://x-1.vercel.app')) === JSON.stringify(['https://x-1.vercel.app']), JSON.stringify(extractDeployUrls('a https://x-1.vercel.app. b https://x-1.vercel.app')));
  check('tanpa URL dan tanpa nama -> null', pickPrimaryUrl([]) === null);
  check('tanpa nama proyek -> URL pertama', pickPrimaryUrl(['https://apa-saja.vercel.app']) === 'https://apa-saja.vercel.app');
}

/* ---------------------------------------------------- 4. sandbox tiruan */

class FakeSandbox {
  fs = new Map<string, string>();
  background: Array<{ command: string; cwd: string; envs: Record<string, string> | undefined }> = [];
  foreground: string[] = [];

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

  constructor(private script: { logAfterPolls: number; log: string }) {}

  private polls = 0;

  get sandboxId() {
    return 'fake-sandbox-deploy';
  }

  getHost(port: number) {
    return `${port}-fake.e2b.dev`;
  }

  commands = {
    run: async (
      command: string,
      options: { background?: boolean; cwd?: string; envs?: Record<string, string> } = {},
    ) => {
      if (options.background) {
        this.background.push({ command, cwd: options.cwd ?? '', envs: options.envs });
        return { pid: 777, stdout: '', stderr: '', exitCode: 0 };
      }
      this.foreground.push(command);
      // Pemeriksaan Vercel CLI (ensureVercel) dilaporkan siap lewat token eksplisit.
      if (command.includes('vercel@latest --version')) {
        return { pid: 1, stdout: '__AC_VERCEL_READY__ penanda\n', stderr: '', exitCode: 0 };
      }
      return { pid: 1, stdout: '', stderr: '', exitCode: 0 };
    },
    kill: async () => true,
  };

  /** Menirukan CLI yang menulis log secara bertahap. */
  readLog = async () => {
    this.polls += 1;
    if (this.polls < this.script.logAfterPolls) return this.fs.get(DEPLOY_LOG_PATH) ?? '';
    this.fs.set(DEPLOY_LOG_PATH, this.script.log);
    return this.script.log;
  };

  asSandbox(): Sandbox {
    const sandbox = this as unknown as Sandbox;
    (sandbox as unknown as { files: { read: (p: string) => Promise<string> } }).files.read = async (path: string) => {
      if (path === DEPLOY_LOG_PATH) return this.readLog();
      const value = this.fs.get(path);
      if (value == null) throw new Error(`ENOENT: ${path}`);
      return value;
    };
    return sandbox;
  }
}

console.log('\n[4] deploy dijalankan latar + token lewat env');
{
  const fake = new FakeSandbox({
    logAfterPolls: 2,
    log: '✅  Production: https://sistem-kasir-abc123xyz.vercel.app [11s]\n',
  });
  const logs: string[] = [];
  const outcome = await deployToVercel(fake.asSandbox(), {
    token: TOKEN,
    projectName: 'Sistem Kasir',
    cwd: '/home/user/project',
    waitMs: 60_000,
    onOutput: (text) => logs.push(text),
  });

  check('hasil: selesai', outcome.state === 'done', JSON.stringify({ state: outcome.state, error: outcome.error }));
  check('link permanen (alias) dikembalikan', outcome.url === 'https://sistem-kasir.vercel.app', String(outcome.url));
  check('dijalankan sebagai proses latar', fake.background.length === 1, JSON.stringify(fake.background));
  check('token dikirim lewat env, BUKAN argumen', fake.background[0]?.envs?.VERCEL_TOKEN === TOKEN);
  check('perintah TIDAK memuat token', !fake.background[0]?.command.includes(TOKEN), fake.background[0]?.command);
  check('perintah menulis ke file log', (fake.background[0]?.command ?? '').includes(DEPLOY_LOG_PATH));
  check('cwd proyek dihormati', fake.background[0]?.cwd === '/home/user/project');
  check('log lama dibersihkan dulu', fake.foreground.some((c) => c.includes(`: > ${DEPLOY_LOG_PATH}`)));
  check('log yang dipancarkan ke UI bebas token', logs.every((l) => !l.includes(TOKEN)), logs.join(' | ').slice(0, 120));
  check('log tidak mengandung token di hasil', !outcome.log.includes(TOKEN));
}

console.log('\n[5] deploy gagal & masih berjalan');
{
  const failed = new FakeSandbox({
    logAfterPolls: 1,
    log: 'Vercel CLI 37.0.0\nError: Invalid token\n',
  });
  const outcome = await deployToVercel(failed.asSandbox(), { token: TOKEN, waitMs: 30_000 });
  check('gagal dilaporkan', outcome.state === 'failed', JSON.stringify(outcome));
  check('alasan ramah untuk user', /Buat token baru di vercel\.com\/account\/tokens/.test(outcome.error ?? ''), String(outcome.error));

  const slow = new FakeSandbox({ logAfterPolls: 999, log: 'Mengunggah file…\n' });
  const started = Date.now();
  const outcome2 = await deployToVercel(slow.asSandbox(), { token: TOKEN, waitMs: 8_000 });
  check('belum selesai => timedOut (bisa dilanjutkan)', outcome2.timedOut === true && outcome2.state === 'running', JSON.stringify(outcome2.state));
  check('menunggu sesuai anggaran, tidak lebih', Date.now() - started < 20_000, String(Date.now() - started));
}

console.log('\n[6] tool deploy untuk agent');
{
  const names = TOOL_DEFINITIONS.map((t) => t.function.name);
  check('tool deploy terdaftar', names.includes('deploy'), names.join(','));
  check('jumlah tool menjadi 9', names.length === 9, String(names.length));
  const def = TOOL_DEFINITIONS.find((t) => t.function.name === 'deploy')!;
  check('deskripsi: hanya kalau user minta', /HANYA kalau user memintanya secara eksplisit/i.test(def.function.description ?? ''));
  check('deskripsi: token dari Settings, bukan argumen', /Token Vercel diambil otomatis dari Settings/i.test(def.function.description ?? ''));
  check('deskripsi: link tetap hidup walau sandbox mati', /tetap hidup walaupun sandbox dimatikan/i.test(def.function.description ?? ''));
  check('parameter cwd tersedia untuk sub-folder', JSON.stringify(def.function.parameters).includes('"cwd"'));

  const fake = new FakeSandbox({ logAfterPolls: 1, log: '✅  Production: https://kasir-app.vercel.app [10s]\n' });
  const result = await executeTool(
    { sandbox: fake.asSandbox(), sandboxId: 'x', deploy: { token: TOKEN, scope: '', projectName: 'kasir-app' } },
    'deploy',
    {},
  );
  check('tool sukses', result.ok, result.output.slice(0, 200));
  check('link permanen ada di keluaran', /link_permanen: https:\/\/kasir-app\.vercel\.app/.test(result.output), result.output.slice(0, 200));
  check('link dikembalikan sebagai previewUrl (dipakai UI & DB)', result.previewUrl === 'https://kasir-app.vercel.app', String(result.previewUrl));
  check('keluaran bebas token', !result.output.includes(TOKEN));

  const noToken = await executeTool({ sandbox: fake.asSandbox(), sandboxId: 'x' }, 'deploy', {});
  check('tanpa token: gagal dengan petunjuk Settings', noToken.ok === false && /Settings/.test(noToken.output), noToken.output.slice(0, 160));
}

console.log(`\nhasil: ${pass} ok, ${fail} gagal`);
if (fail) process.exit(1);
