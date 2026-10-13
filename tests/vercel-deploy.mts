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
  DEPLOY_EXIT_PREFIX,
  DEPLOY_LOG_PATH,
  DEPLOY_PID_PATH,
  buildDeployCommand,
  buildLinkCommand,
  deployShellCommand,
  explainDeployError,
  extractDeployUrls,
  looksLikeFailureGuidance,
  parseDeployStatus,
  permanentUrlFromLog,
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

  const cmd = buildDeployCommand({ scope: 'tim-saya' });
  check('deploy prod non-interaktif', /vercel@latest deploy --yes --prod/.test(cmd), cmd);
  check('scope ikut bila diisi', /--scope tim-saya/.test(cmd), cmd);
  check('TANPA flag --token (token lewat env)', !/--token/.test(cmd), cmd);
  // --name sudah DEPRECATED di CLI Vercel (dokumentasi resmi) dan pernah membuat
  // CLI mencetak bantuan alih-alih deploy. Nama proyek diatur lewat `link`.
  check('deploy TIDAK memakai --name (deprecated)', !/--name/.test(cmd), cmd);
  check('preview deploy tanpa --prod', !/ --prod/.test(buildDeployCommand({ prod: false })));
  const link = buildLinkCommand({ projectName: 'Sistem Kasir', scope: 'tim-saya' });
  check('link menautkan nama proyek', /vercel@latest link --yes --project sistem-kasir/.test(link), link);
  check('link ikut memakai scope', /--scope tim-saya/.test(link), link);
  check('link non-interaktif', /--yes/.test(link));

  const shell = deployShellCommand('npx vercel deploy');
  check('perintah latar menulis ke file log', shell.includes('> ' + DEPLOY_LOG_PATH));
  check('perintah latar menutup dengan penanda kode keluar', shell.includes(`echo \"${DEPLOY_EXIT_PREFIX}$?\"`), shell);
  check('alias tebakan hanya untuk tampilan', productionAlias('Sistem Kasir') === 'https://sistem-kasir.vercel.app');
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
    '🔗  Deployment: https://sistem-kasir-fo7hdf7wz-smoke-dev-builder.vercel.app [12s]',
    '✅  Production: https://sistem-kasir-drab.vercel.app [12s]',
    `${DEPLOY_EXIT_PREFIX}0`,
  ].join('\n');
  const doneStatus = parseDeployStatus(done);
  check('kode keluar 0 + baris Production = selesai', doneStatus.state === 'done', JSON.stringify(doneStatus));
  // INSIDEN NYATA: nama `sistem-kasir.vercel.app` sudah dipakai orang lain, jadi
  // Vercel memberi alias bersufiks acak. Link yang ditampilkan HARUS yang dicetak
  // CLI — menebak alias berarti mengirim user ke situs milik orang lain.
  check('link = alias yang DICETAK CLI, bukan hasil menebak', doneStatus.url === 'https://sistem-kasir-drab.vercel.app', String(doneStatus.url));
  check('URL deployment ber-hash tetap tercatat untuk diagnosa', doneStatus.urls.some((u) => u.includes('fo7hdf7wz')), JSON.stringify(doneStatus.urls));
  check('baris "Deployment:" tidak dipakai sebagai link utama', doneStatus.url !== 'https://sistem-kasir-fo7hdf7wz-smoke-dev-builder.vercel.app');

  const failed = `Vercel CLI 37.0.0\nError: The specified token is not valid\n${DEPLOY_EXIT_PREFIX}1\n`;
  const failedStatus = parseDeployStatus(failed);
  check('error token = gagal', failedStatus.state === 'failed', JSON.stringify(failedStatus));
  check('pesan error disimpan', /token is not valid/i.test(failedStatus.error ?? ''), String(failedStatus.error));
  check('error token dijelaskan ramah', /Buat token baru di vercel\.com\/account\/tokens/.test(explainDeployError(failedStatus.error)));

  check('log kosong = masih berjalan', parseDeployStatus('').state === 'running');
  check('tanpa penanda keluar & tanpa hasil = masih berjalan', parseDeployStatus('Vercel CLI 37.0.0\n🔍  Inspect: https://vercel.com/t/p/abc [2s]\n').state === 'running');

  // INSIDEN NYATA ke-2: saat deployment GAGAL dibangun, CLI mencetak blok saran
  // ("Create a new deployment from the same source", "View build logs", …).
  // Sebelum ini blok tersebut tidak dikenali sehingga statusnya menggantung
  // "masih berjalan" selamanya dan user melihat terminal penuh baris berulang.
  const guidance = [
    'Vercel CLI 37.0.0',
    'Error: Command "npm run build" exited with 1',
    '',
    'View build logs:',
    '  vercel inspect sistem-kasir-fo7hdf7wz-smoke-dev-builder.vercel.app --logs',
    '- Create a new deployment from the same source:',
    '  vercel redeploy sistem-kasir-fo7hdf7wz-smoke-dev-builder.vercel.app',
    '- Check the production response:',
    '  vercel curl https://sistem-kasir-drab.vercel.app',
  ].join('\n');
  check('blok saran CLI dikenali sebagai kegagalan', looksLikeFailureGuidance(guidance));
  const guidanceStatus = parseDeployStatus(guidance);
  check('gagal (bukan "masih berjalan")', guidanceStatus.state === 'failed', JSON.stringify(guidanceStatus));
  check('penyebab build diambil dari log', /npm run build/.test(guidanceStatus.error ?? ''), String(guidanceStatus.error));
  check('kegagalan build dijelaskan ramah', /gagal MEMBANGUN aplikasi/.test(explainDeployError(guidanceStatus.error)));

  const guidanceExited = parseDeployStatus(`${guidance}\n${DEPLOY_EXIT_PREFIX}1\n`);
  check('penanda keluar memperkuat status gagal', guidanceExited.state === 'failed');

  const successNoAlias = parseDeployStatus(`Vercel CLI 37.0.0\n✅  Production: https://app-x9.vercel.app [8s]\n${DEPLOY_EXIT_PREFIX}0`);
  check('sukses tanpa alias -> pakai URL produksi', successNoAlias.url === 'https://app-x9.vercel.app', String(successNoAlias.url));

  const successNoUrl = parseDeployStatus(`Vercel CLI 37.0.0\nUploading…\n${DEPLOY_EXIT_PREFIX}0`);
  check('kode keluar 0 tanpa URL tetap dianggap selesai', successNoUrl.state === 'done', JSON.stringify(successNoUrl));
  check('URL null bila CLI tidak mencetaknya', successNoUrl.url === null);

  check('permanentUrlFromLog membaca baris Production', permanentUrlFromLog('✅  Production: https://a-b.vercel.app [1s]') === 'https://a-b.vercel.app');
  check('permanentUrlFromLog null tanpa baris hasil', permanentUrlFromLog('Inspect: https://vercel.com/x/y/z') === null);
  check('kuota habis dijelaskan', /Kuota deploy Vercel harian/.test(explainDeployError('Error: No more than 100 deployments per day')));

  const alias = parseDeployStatus('✅  Production: https://sistem-kasir.vercel.app [9s]', { projectName: 'Sistem Kasir' });
  check('alias yang sudah ada dipakai apa adanya', alias.url === 'https://sistem-kasir.vercel.app', String(alias.url));

  check('ekstraksi URL unik & bersih', JSON.stringify(extractDeployUrls('a https://x-1.vercel.app. b https://x-1.vercel.app')) === JSON.stringify(['https://x-1.vercel.app']), JSON.stringify(extractDeployUrls('a https://x-1.vercel.app. b https://x-1.vercel.app')));
  check('tanpa URL & tanpa log -> null', pickPrimaryUrl([]) === null);
  check('URL pertama dipakai bila CLI tidak menyebut alias', pickPrimaryUrl(['https://apa-saja.vercel.app']) === 'https://apa-saja.vercel.app');
  check(
    'penebakan alias DIHAPUS: nama proyek tidak dipakai untuk mengarang URL',
    pickPrimaryUrl(['https://sistem-kasir-drab.vercel.app'], 'Vercel CLI\n') === 'https://sistem-kasir-drab.vercel.app',
  );
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

  constructor(private script: { logAfterPolls: number; log: string; stages?: string[]; existingLog?: string; pid?: number | null }) {}

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
        this.deployStarted = true;
        return { pid: 777, stdout: '', stderr: '', exitCode: 0 };
      }
      this.foreground.push(command);
      // Pemeriksaan Vercel CLI (ensureVercel) dilaporkan siap lewat token eksplisit.
      if (command.includes('vercel@latest --version')) {
        return { pid: 1, stdout: '__AC_VERCEL_READY__ penanda\n', stderr: '', exitCode: 0 };
      }
      // Pemeriksaan proses deploy (kill -0 <pid>) — menentukan melanjutkan vs mulai ulang.
      if (/kill -0 \d+/.test(command)) {
        return { pid: 1, stdout: this.processAlive ? 'ALIVE\n' : 'GONE\n', stderr: '', exitCode: 0 };
      }
      // Penautan proyek (link) — dicatat tapi tidak mengganggu hitungan deploy.
      if (command.includes('vercel@latest link')) {
        return { pid: 1, stdout: 'Linked to sistem-kasir\n', stderr: '', exitCode: 0 };
      }
      return { pid: 1, stdout: '', stderr: '', exitCode: 0 };
    },
    kill: async () => true,
  };

  /** true = proses deploy tiruan dianggap masih hidup. */
  processAlive = true;

  /** true setelah perintah deploy benar-benar dijalankan di sandbox tiruan. */
  deployStarted = false;

  /** Menirukan CLI yang menulis log secara bertahap (stages = isi log per polling). */
  readLog = async () => {
    // Sebelum deploy dijalankan tidak ada log baru: kembalikan isi yang ada
    // (untuk kasus melanjutkan) atau kosong, tanpa memakan tahap fixture.
    if (!this.deployStarted && !this.script.existingLog) return '';
    this.polls += 1;
    if (this.script.stages?.length) {
      const value = this.script.stages[Math.min(this.polls - 1, this.script.stages.length - 1)] ?? '';
      this.fs.set(DEPLOY_LOG_PATH, value);
      return value;
    }
    if (this.polls < this.script.logAfterPolls) return this.fs.get(DEPLOY_LOG_PATH) ?? '';
    this.fs.set(DEPLOY_LOG_PATH, this.script.log);
    return this.script.log;
  };

  asSandbox(): Sandbox {
    if (this.script.existingLog) this.fs.set(DEPLOY_LOG_PATH, this.script.existingLog);
    if (this.script.pid != null) this.fs.set(DEPLOY_PID_PATH, String(this.script.pid));
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
    log: `✅  Production: https://sistem-kasir-abc123xyz.vercel.app [11s]\n${DEPLOY_EXIT_PREFIX}0\n`,
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
  // Yang dipakai adalah URL yang BENAR-BENAR dicetak CLI (di sini alias yang
  // diberikan Vercel), bukan alias hasil menebak nama proyek.
  check('link permanen = URL produksi dari CLI', outcome.url === 'https://sistem-kasir-abc123xyz.vercel.app', String(outcome.url));
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
    log: `Vercel CLI 37.0.0\nError: Invalid token\n${DEPLOY_EXIT_PREFIX}1\n`,
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

  const fake = new FakeSandbox({
    logAfterPolls: 1,
    log: `✅  Production: https://kasir-app.vercel.app [10s]\n${DEPLOY_EXIT_PREFIX}0\n`,
  });
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

console.log('\n[7] streaming log: hanya bagian BARU yang dikirim ke UI');
{
  // Insiden nyata: setiap polling mengirim ulang ekor log yang sama, sehingga
  // terminal user penuh baris berulang (screenshot laporan user Okt 2026).
  const stages = [
    'Vercel CLI 37.0.0\n',
    'Vercel CLI 37.0.0\n🔍  Inspect: https://vercel.com/t/a/abc [2s]\n',
    'Vercel CLI 37.0.0\n🔍  Inspect: https://vercel.com/t/a/abc [2s]\nUploading files…\n',
    `Vercel CLI 37.0.0\n🔍  Inspect: https://vercel.com/t/a/abc [2s]\nUploading files…\n✅  Production: https://a-b.vercel.app [9s]\n${DEPLOY_EXIT_PREFIX}0\n`,
  ];
  const fake = new FakeSandbox({ logAfterPolls: 1, log: stages[stages.length - 1], stages });
  const chunks: string[] = [];
  const outcome = await deployToVercel(fake.asSandbox(), {
    token: TOKEN,
    waitMs: 60_000,
    onOutput: (text) => chunks.push(text),
  });

  check('deploy selesai dari log bertahap', outcome.state === 'done', JSON.stringify({ state: outcome.state, error: outcome.error }));
  const streamed = chunks.join('');
  check('isi log digabung utuh (tidak ada bagian hilang)', streamed.replace(/\s+/g, '') === stages[3].replace(/\s+/g, ''), streamed);
  check('baris TIDAK terkirim berulang', (streamed.match(/Vercel CLI 37\.0\.0/g) ?? []).length === 1, String((streamed.match(/Vercel CLI 37\.0\.0/g) ?? []).length));
  check('jumlah potongan = jumlah polling yang ada isi baru', chunks.length === 4, String(chunks.length));
  check('potongan baru saja (bukan seluruh log)', chunks.every((c) => c.length < stages[3].length), JSON.stringify(chunks.map((c) => c.length)));
}

console.log('\n[8] "tekan Deploy lagi" = MELANJUTKAN, bukan deploy baru');
{
  // Deploy sedang berjalan (log ada isinya, belum ada penanda keluar, prosesnya
  // masih hidup): panggilan berikutnya harus MELANJUTKAN pemantauan, bukan
  // menjalankan `vercel deploy` lagi (yang membuat deployment kedua dan membuang
  // deployment yang sedang berjalan).
  const running = 'Vercel CLI 37.0.0\nInspect: https://vercel.com/t/a/abc [4s]\nBuilding...\n';
  const success = 'Production: https://kasir-drab.vercel.app [9s]\n';
  const fake = new FakeSandbox({
    logAfterPolls: 2,
    log: running + success + DEPLOY_EXIT_PREFIX + '0\n',
    existingLog: running,
    pid: 4242,
  });
  const chunks: string[] = [];
  const outcome = await deployToVercel(fake.asSandbox(), {
    token: TOKEN,
    projectName: 'Sistem Kasir',
    waitMs: 60_000,
    onOutput: (text) => chunks.push(text),
  });

  check('melanjutkan deploy yang berjalan: selesai', outcome.state === 'done', JSON.stringify({ state: outcome.state, error: outcome.error }));
  check('link dari deploy yang dilanjutkan', outcome.url === 'https://kasir-drab.vercel.app', String(outcome.url));
  check('TIDAK menjalankan deploy baru', fake.background.length === 0, JSON.stringify(fake.background.map((b) => b.command)));
  check('TIDAK menjalankan link ulang', !fake.foreground.some((c) => c.includes('vercel@latest link')));
  check('log yang sedang berjalan TIDAK dibuang', !fake.foreground.some((c) => c.includes(': > ' + DEPLOY_LOG_PATH)));
  check('user diberi tahu ini melanjutkan', chunks.join('').includes('melanjutkan deploy yang sedang berjalan'));
  check('isi log sebelumnya ikut ditampilkan', chunks.join('').includes('Inspect: https://vercel.com'));
  check('isi log tidak dikirim dua kali', (chunks.join('').match(/Vercel CLI 37\.0\.0/g) ?? []).length === 1, chunks.join(''));
}
{
  // Prosesnya sudah hilang (mis. sandbox di-pause di tengah deploy): WAJIB mulai
  // deploy baru, kalau tidak statusnya menggantung "masih berjalan" selamanya.
  const stale = 'Vercel CLI 37.0.0\nUploading...\n';
  const fake = new FakeSandbox({
    logAfterPolls: 1,
    log: stale + 'Production: https://baru.vercel.app [7s]\n' + DEPLOY_EXIT_PREFIX + '0\n',
    existingLog: stale,
    pid: 999,
  });
  fake.processAlive = false;
  const outcome = await deployToVercel(fake.asSandbox(), { token: TOKEN, waitMs: 40_000 });

  check('proses hilang => deploy dimulai ulang', fake.background.length === 1, JSON.stringify(fake.background.map((b) => b.command)));
  check('log lama dibuang sebelum mulai', fake.foreground.some((c) => c.includes(': > ' + DEPLOY_LOG_PATH)));
  check('deploy baru menghasilkan link', outcome.state === 'done' && outcome.url === 'https://baru.vercel.app', JSON.stringify(outcome));

  const noPid = new FakeSandbox({
    logAfterPolls: 1,
    log: 'Uploading...\n' + DEPLOY_EXIT_PREFIX + '0\n',
    existingLog: 'Uploading...\n',
    pid: null,
  });
  await deployToVercel(noPid.asSandbox(), { token: TOKEN, waitMs: 20_000 });
  check('tanpa catatan PID => deploy baru (aman)', noPid.background.length === 1, JSON.stringify(noPid.background.map((b) => b.command)));
}

console.log(`\nhasil: ${pass} ok, ${fail} gagal`);
if (fail) process.exit(1);
