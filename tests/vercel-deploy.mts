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
  buildAppDirScanScript,
  buildDeployCommand,
  buildDisableProtectionRequest,
  buildLinkCommand,
  buildProjectInfoRequest,
  chooseAppDir,
  deployLinkNote,
  deployStartedAtScript,
  deployStillRunningMessage,
  formatDuration,
  deployShellCommand,
  deploymentProtectionSettingsUrl,
  explainDeployError,
  extractDeployUrls,
  judgeDeployLink,
  looksLikeFailureGuidance,
  parseAppDirScan,
  parseDeployStartedAt,
  parseDeployStatus,
  parseProjectInfo,
  permanentUrlFromLog,
  pickPrimaryUrl,
  productionAlias,
  redactSecrets,
  toVercelProjectName,
  vercelAuthenticationNote,
} from '@/lib/deploy/vercel';
import {
  TOOL_DEFINITIONS,
  checkDeployLink,
  deployToVercel,
  detectAppDir,
  disableVercelProtection,
  executeTool,
  fetchVercelProject,
} from '@/lib/sandbox/tools';

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

/**
 * Stub jaringan.
 *
 * `deployToVercel` sekarang MEMERIKSA linknya dari sisi server (baca proyeknya
 * lewat API Vercel + membuka URL deploy untuk tahu apakah terkunci Deployment
 * Protection). Uji ini tidak boleh menembak internet — apalagi domain
 * `*.vercel.app` yang bisa saja milik orang lain. Default stub: API Vercel = 401
 * (token palsu), URL lain = 200 (link sehat), sehingga uji lama tetap sahih.
 */
type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;
const apiError = (status = 401, message = 'Not authorized') =>
  new Response(JSON.stringify({ error: { message } }), { status, headers: { 'content-type': 'application/json' } });

let fetchHandler: FetchHandler = (url) => (url.includes('api.vercel.com') ? apiError() : new Response('ok', { status: 200 }));
const fetchCalls: Array<{ url: string; method: string; authorization: string | null; body: string | null }> = [];
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const headers = new Headers(init?.headers ?? {});
  fetchCalls.push({
    url,
    method: (init?.method ?? 'GET').toUpperCase(),
    authorization: headers.get('authorization'),
    body: typeof init?.body === 'string' ? init.body : null,
  });
  return Promise.resolve(fetchHandler(url, init));
}) as typeof fetch;

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
      // Waktu mulai deploy (mtime file PID) — untuk deteksi deploy macet.
      if (command.includes('stat -c %Y')) {
        return { pid: 1, stdout: this.statSeconds ? `${this.statSeconds}\n` : '0\n', stderr: '', exitCode: 0 };
      }
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

  /** Waktu (detik) mtime file PID — dipakai menguji deteksi deploy macet. */
  statSeconds: number | null = null;

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

  // Log MASIH KOSONG tetapi prosesnya hidup & baru: jangan mengulang deploy baru
  // (itu membuang deployment yang sedang berjalan setiap kali dipanggil).
  // `existingLog: '\n'` = file log ada tetapi isinya kosong (deploy belum mencetak apa pun).
  // `logAfterPolls: 3` supaya pembacaan log PERTAMA (sebelum memutuskan
  // melanjutkan/memulai) masih berisi log kosong, seperti deploy yang baru
  // dijalankan dan belum mencetak apa pun.
  const silentFresh = new FakeSandbox({
    logAfterPolls: 3,
    log: 'Production: https://baru-2.vercel.app [4s]\n' + DEPLOY_EXIT_PREFIX + '0\n',
    existingLog: '\n',
    pid: 555,
  });
  silentFresh.statSeconds = Math.floor(Date.now() / 1000) - 60;
  const silentChunks: string[] = [];
  const silentOutcome = await deployToVercel(silentFresh.asSandbox(), {
    token: TOKEN,
    waitMs: 20_000,
    onOutput: (t) => silentChunks.push(t),
  });
  check('log kosong + proses hidup & baru => MELANJUTKAN', silentFresh.background.length === 0, JSON.stringify(silentFresh.background.map((b) => b.command)));
  check('log yang kosong TIDAK dihapus/dibersihkan', !silentFresh.foreground.some((c) => c.includes(': > ' + DEPLOY_LOG_PATH)));
  check('user diberi tahu melanjutkan', silentChunks.join('').includes('melanjutkan deploy yang sedang berjalan'));
  check('deploy yang dilanjutkan tetap menghasilkan link', silentOutcome.state === 'done' && silentOutcome.url === 'https://baru-2.vercel.app', String(silentOutcome.url));

  // Diam tanpa keluaran DAN sudah lewat ambang macet: mulai baru, kalau tidak
  // statusnya menggantung selamanya.
  const silentStale = new FakeSandbox({
    logAfterPolls: 3,
    log: 'Production: https://baru-3.vercel.app [4s]\n' + DEPLOY_EXIT_PREFIX + '0\n',
    existingLog: '\n',
    pid: 556,
  });
  silentStale.statSeconds = Math.floor(Date.now() / 1000) - 30 * 60;
  const staleChunks: string[] = [];
  await deployToVercel(silentStale.asSandbox(), { token: TOKEN, waitMs: 20_000, onOutput: (t) => staleChunks.push(t) });
  check('diam + macet => deploy baru dijalankan', silentStale.background.length === 1, JSON.stringify(silentStale.background.map((b) => b.command)));
  check('alasan memulai baru dijelaskan', staleChunks.join('').includes('tidak memberi keluaran sama sekali'), staleChunks.join('').slice(0, 160));
}

console.log('\n[9] link deploy terkunci Deployment Protection (Vercel Authentication)');
{
  // INSIDEN NYATA (Okt 2026): URL deploy menjawab 302 ke vercel.com/sso-api dan
  // pengunjung tanpa sesi Vercel hanya melihat halaman login/404 — user
  // melaporkannya sebagai "link permanennya error" padahal build sukses.
  const sso = judgeDeployLink({
    status: 302,
    location: 'https://vercel.com/sso-api?url=https%3A%2F%2Fsistem-kasir-gxernq6gt-smoke-dev-builder.vercel.app%2F&nonce=abc',
    setCookie: '_vercel_sso_nonce=abc; Path=/; Secure; HttpOnly',
  });
  check('302 ke sso-api = TERKUNCI', sso.restricted && !sso.public, JSON.stringify(sso));
  check('klasifikasi = vercel-authentication', sso.kind === 'vercel-authentication', sso.kind);

  check('200 = publik', judgeDeployLink({ status: 200 }).public);
  check('401 juga dianggap terkunci', judgeDeployLink({ status: 401 }).restricted);
  const notFound = judgeDeployLink({ status: 404, body: '404 NOT_FOUND This page doesn\u2019t exist' });
  check('404 halaman biasa = not-found', notFound.kind === 'not-found' && !notFound.restricted, JSON.stringify(notFound));
  check('request gagal = unreachable', judgeDeployLink({ status: 0, error: 'fetch failed' }).kind === 'unreachable');

  // Sepasang 404 Vercel yang artinya BEDA (diambil apa adanya dari insiden nyata
  // "sudah keluar link permanennya cuman eror").
  const emptyDeployment = judgeDeployLink({
    status: 404,
    body: 'The page could not be found\n\nNOT_FOUND\nsin1::xgpvc-1791900354407-38ce97f969dc',
  });
  check('404 "The page could not be found" = deployment KOSONG', emptyDeployment.kind === 'empty-deployment', emptyDeployment.kind);
  check(
    'pesannya menyebut sub-folder / file hilang (penyebab tersering)',
    /sub-folder/.test(deployLinkNote(emptyDeployment, { projectName: 'Sistem Kasir' }) ?? ''),
    String(deployLinkNote(emptyDeployment, { projectName: 'Sistem Kasir' })),
  );
  const missing = judgeDeployLink({
    status: 404,
    body: 'The deployment could not be found on Vercel.\n\nDEPLOYMENT_NOT_FOUND\nsin1::75z2x-1791900377949-80691a6a57d8',
  });
  check('404 DEPLOYMENT_NOT_FOUND = hostname tanpa deployment', missing.kind === 'deployment-missing', missing.kind);
  check(
    'keduanya diberi pesan berbeda',
    deployLinkNote(emptyDeployment, {}) !== deployLinkNote(missing, {}),
    String(deployLinkNote(missing, {})),
  );

  const info = buildProjectInfoRequest({ projectName: 'Sistem Kasir', scope: 'smoke-dev-builder' });
  check('API info proyek: nama di-slug-kan', info.url.includes('/v9/projects/sistem-kasir'), info.url);
  check('API info proyek: scope jadi teamId', info.url.includes('teamId=smoke-dev-builder'), info.url);
  check('API info proyek: GET', info.method === 'GET');

  const off = buildDisableProtectionRequest({ projectName: 'Sistem Kasir', scope: 'smoke-dev-builder' });
  check('perintah mematikan proteksi = PATCH', off.method === 'PATCH', off.method);
  check('body mematikan Vercel Authentication (ssoProtection: null)', off.body === '{"ssoProtection":null}', off.body);
  check('perintah mematikan proteksi ikut memakai scope', off.url.includes('teamId=smoke-dev-builder'), off.url);
  check(
    'halaman pengaturan Vercel bisa dibuka user',
    deploymentProtectionSettingsUrl({ projectName: 'Sistem Kasir', scope: 'smoke-dev-builder' }) ===
      'https://vercel.com/smoke-dev-builder/sistem-kasir/settings/deployment-protection',
    deploymentProtectionSettingsUrl({ projectName: 'Sistem Kasir', scope: 'smoke-dev-builder' }),
  );

  const parsed = parseProjectInfo(
    {
      id: 'prj_1',
      name: 'sistem-kasir',
      targets: { production: { alias: ['kasir.example.com', 'sistem-kasir-smoke-dev-builder.vercel.app'] } },
      ssoProtection: { deploymentType: 'all' },
    },
    { scope: 'smoke-dev-builder' },
  );
  check('alias produksi dibaca dari API (bukan ditebak)', parsed?.productionAliases.includes('sistem-kasir-smoke-dev-builder.vercel.app'), JSON.stringify(parsed?.productionAliases));
  check('domain *.vercel.app didahulukan', parsed?.productionAliases[0] === 'sistem-kasir-smoke-dev-builder.vercel.app', JSON.stringify(parsed?.productionAliases));
  check('status proteksi terbaca', parsed?.protected === true && parsed?.protectionType === 'all', JSON.stringify(parsed));
  check(
    'tanpa ssoProtection = tidak terkunci',
    parseProjectInfo({ name: 'x', ssoProtection: null })?.protected === false,
    JSON.stringify(parseProjectInfo({ name: 'x', ssoProtection: null })),
  );
  check('respons tak dikenal tidak ditebak', parseProjectInfo({ error: { message: 'nope' } }) === null);

  const note = vercelAuthenticationNote({ projectName: 'Sistem Kasir', scope: 'smoke-dev-builder' });
  check('catatan menyebut Deployment Protection', /Deployment Protection/.test(note), note);
  check('catatan menyebut cara mematikannya', /Matikan proteksi/.test(note), note);
  check('catatan menyebut "This page doesn\'t exist" (gejala yang dilihat user)', /This page doesn't exist/.test(note));
  check('catatan 404 mengarahkan deploy ulang', /deploy lagi/.test(deployLinkNote({ status: 404, kind: 'not-found', public: false, restricted: false, reason: null }) ?? ''));
}

console.log('\n[10] deploy: link stabil + peringatan saat terkunci');
{
  const deployLog = `✅  Production: https://sistem-kasir-gxernq6gt-smoke-dev-builder.vercel.app [12s]\n${DEPLOY_EXIT_PREFIX}0\n`;
  const projectBody = (protected_: boolean) =>
    new Response(
      JSON.stringify({
        id: 'prj_1',
        name: 'sistem-kasir',
        targets: { production: { alias: ['sistem-kasir-smoke-dev-builder.vercel.app'] } },
        ssoProtection: protected_ ? { deploymentType: 'all' } : null,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  // (a) Proyek terkunci: API bilang ssoProtection aktif, linknya 302 ke login.
  fetchHandler = (url) => {
    if (url.includes('api.vercel.com')) return projectBody(true);
    return new Response('', { status: 302, headers: { location: 'https://vercel.com/sso-api?url=x&nonce=y' } });
  };
  const locked = await deployToVercel(new FakeSandbox({ logAfterPolls: 1, log: deployLog }).asSandbox(), {
    token: TOKEN,
    projectName: 'Sistem Kasir',
    waitMs: 30_000,
  });
  check('deploy terkunci tetap dianggap selesai (bukan gagal)', locked.state === 'done', JSON.stringify(locked.state));
  check('link yang dipakai = alias produksi stabil dari API', locked.url === 'https://sistem-kasir-smoke-dev-builder.vercel.app', String(locked.url));
  check('terkunci dilaporkan ke user/agent', locked.protected === true);
  check('catatan memuat langkah perbaikan', /Deployment Protection/.test(locked.protectionNote ?? ''), String(locked.protectionNote));
  check('alias dicatat di hasil', locked.alias === 'sistem-kasir-smoke-dev-builder.vercel.app', String(locked.alias));

  // (b) API tidak bisa dibaca (token palsu) tapi linknya jelas 302 ke login.
  fetchCalls.length = 0;
  fetchHandler = (url) => (url.includes('api.vercel.com') ? apiError(403) : new Response('', { status: 302, headers: { location: 'https://vercel.com/sso-api?url=x' } }));
  const probeOnly = await deployToVercel(new FakeSandbox({ logAfterPolls: 1, log: deployLog }).asSandbox(), {
    token: TOKEN,
    projectName: 'Sistem Kasir',
    waitMs: 30_000,
  });
  check('tanpa API: tetap terdeteksi dari pemeriksaan link', probeOnly.protected === true);
  check('tanpa alias: link dari CLI dipertahankan', probeOnly.url === 'https://sistem-kasir-gxernq6gt-smoke-dev-builder.vercel.app', String(probeOnly.url));
  check('kegagalan API tidak dianggap kegagalan deploy', probeOnly.state === 'done');

  // (c) Alias dari API sudah basi (404) → pakai URL yang dilaporkan CLI.
  fetchHandler = (url) => {
    if (url.includes('api.vercel.com')) return projectBody(false);
    if (url.includes('sistem-kasir-smoke-dev-builder.vercel.app')) return new Response('404 NOT_FOUND', { status: 404 });
    return new Response('ok', { status: 200 });
  };
  const stale = await deployToVercel(new FakeSandbox({ logAfterPolls: 1, log: deployLog }).asSandbox(), {
    token: TOKEN,
    projectName: 'Sistem Kasir',
    waitMs: 30_000,
  });
  check('alias mati (404) tidak dipakai', stale.url === 'https://sistem-kasir-gxernq6gt-smoke-dev-builder.vercel.app', String(stale.url));
  check('link sehat tidak dilaporkan terkunci', stale.protected === false && stale.protectionNote === null);

  // (d) Tidak ada koneksi sama sekali: jangan mengarang kesimpulan.
  fetchHandler = () => {
    throw new Error('network down');
  };
  const offline = await checkDeployLink('https://x.vercel.app');
  check('gagal menghubungi link = unreachable (bukan "terkunci")', offline.kind === 'unreachable' && !offline.restricted, JSON.stringify(offline));
  const offlineOutcome = await deployToVercel(new FakeSandbox({ logAfterPolls: 1, log: deployLog }).asSandbox(), {
    token: TOKEN,
    projectName: 'Sistem Kasir',
    waitMs: 30_000,
  });
  check('link tetap dilaporkan walau pemeriksaan gagal', offlineOutcome.state === 'done' && Boolean(offlineOutcome.url), String(offlineOutcome.url));
}

console.log('\n[11] matikan proteksi lewat API Vercel (tombol di panel Preview)');
{
  fetchHandler = (url, init) => {
    if (url.includes('api.vercel.com')) {
      if ((init?.method ?? 'GET').toUpperCase() === 'PATCH') {
        return new Response(JSON.stringify({ id: 'prj_1', name: 'sistem-kasir', ssoProtection: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: 'prj_1', name: 'sistem-kasir', ssoProtection: { deploymentType: 'all' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('ok', { status: 200 });
  };
  fetchCalls.length = 0;
  const res = await disableVercelProtection({ token: TOKEN, scope: 'smoke-dev-builder', projectName: 'Sistem Kasir' });
  check('berhasil mematikan proteksi', res.ok === true, JSON.stringify(res));
  const patch = fetchCalls.find((c) => c.method === 'PATCH');
  check('memakai PATCH ke API proyek', Boolean(patch), JSON.stringify(fetchCalls.map((c) => `${c.method} ${c.url}`)));
  check('token dikirim lewat header Authorization', patch?.authorization === `Bearer ${TOKEN}`, String(patch?.authorization));
  check('token TIDAK ada di URL', !fetchCalls.some((c) => c.url.includes(TOKEN)), JSON.stringify(fetchCalls.map((c) => c.url)));
  check('body = ssoProtection:null', patch?.body === '{"ssoProtection":null}', String(patch?.body));

  // Scope salah → coba ulang tanpa teamId (token pribadi tidak menerima teamId).
  fetchCalls.length = 0;
  fetchHandler = (url, init) => {
    if (!url.includes('api.vercel.com')) return new Response('ok', { status: 200 });
    if (url.includes('teamId=')) return apiError(404, 'Project not found');
    return new Response(JSON.stringify({ id: 'prj_1', name: 'sistem-kasir', ssoProtection: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const retry = await disableVercelProtection({ token: TOKEN, scope: 'tim-salah', projectName: 'Sistem Kasir' });
  check('scope salah => dicoba ulang tanpa teamId', retry.ok === true, JSON.stringify(retry));
  check('percobaan kedua benar-benar dilakukan', fetchCalls.filter((c) => c.method === 'PATCH').length === 2, JSON.stringify(fetchCalls.map((c) => c.url)));

  // Token ditolak → pesan yang bisa ditindak, bukan kegagalan senyap.
  fetchHandler = (url) => (url.includes('api.vercel.com') ? apiError(403, 'Forbidden') : new Response('ok', { status: 200 }));
  const denied = await disableVercelProtection({ token: TOKEN, projectName: 'Sistem Kasir' });
  check('token ditolak dilaporkan gagal', denied.ok === false);
  check('saran manual diberikan', /Deployment Protection/.test(denied.message), denied.message);

  // fetchVercelProject: respons error → null (jangan menebak status proyek).
  const none = await fetchVercelProject({ token: TOKEN, projectName: 'Sistem Kasir' });
  check('info proyek null saat API menolak', none === null, JSON.stringify(none));
}

console.log('\n[12] deteksi FOLDER APLIKASI sebelum deploy');
{
  // Insiden nyata: aplikasi dibuat di SUB-FOLDER, tombol Deploy mengirim folder
  // akar proyek → Vercel membangun situs kosong (404 "The page could not be
  // found" di semua alamat) padahal CLI bilang sukses.
  const script = buildAppDirScanScript('/home/user/project');
  check('skrip memindai folder akar + sub-folder', script.includes('/home/user/project') && script.includes('__AC_CAND__'), script.slice(0, 80));
  check(
    'skrip melewati node_modules/.next/.git',
    script.includes('node_modules/') && script.includes('.next/') && script.includes('.git/'),
    script.slice(0, 200),
  );
  check('skrip menandai tanda aplikasi (package.json/index.html)', /package\.json/.test(script) && /index\.html/.test(script));
  check('folder dengan tanda kutip tetap aman', buildAppDirScanScript("/home/user/my'app").includes("'\\''"));

  const scan = parseAppDirScan(
    [
      '__AC_CAND__ /home/user/project/sistem-kasir 42',
      '__AC_CAND__ /home/user/project/landing 5',
    ].join('\n'),
  );
  check('sub-folder terbaca + jumlah file', scan.candidates.length === 2 && scan.candidates[0].files === 42, JSON.stringify(scan));

  const withRoot = parseAppDirScan('__AC_ROOT_APP__ 12\n');
  check('folder akar berisi aplikasi terbaca', withRoot.rootHasApp === true, JSON.stringify(withRoot));
  check('folder akar tidak ada = failed (jangan menyimpulkan)', parseAppDirScan('__AC_NO_ROOT__').failed === true);

  const one = chooseAppDir({
    scan: parseAppDirScan('__AC_CAND__ /home/user/project/sistem-kasir 42'),
    root: '/home/user/project',
  });
  check('satu sub-folder => itu yang dipakai', one?.dir === '/home/user/project/sistem-kasir', JSON.stringify(one));
  check('alasannya dijelaskan', /sub-folder/.test(one?.note ?? ''), String(one?.note));

  const rootApp = chooseAppDir({ scan: withRoot, root: '/home/user/project' });
  check('akarnya berisi aplikasi & tanpa sub-folder => folder akar', rootApp?.dir === '/home/user/project' && rootApp.source === 'root', JSON.stringify(rootApp));

  // Paling dipercaya: folder tempat dev server terakhir dijalankan.
  const byRegistry = chooseAppDir({
    scan: parseAppDirScan('__AC_CAND__ /home/user/project/sistem-kasir 42\n__AC_CAND__ /home/user/project/landing 5'),
    root: '/home/user/project',
    registryCwds: ['/home/user/project/landing'],
  });
  check('catatan dev server menang atas tebakan ukuran', byRegistry?.dir === '/home/user/project/landing' && byRegistry.source === 'registry', JSON.stringify(byRegistry));

  const many = chooseAppDir({
    scan: parseAppDirScan('__AC_CAND__ /home/user/project/a 3\n__AC_CAND__ /home/user/project/b 40'),
    root: '/home/user/project',
  });
  check('banyak sub-folder => yang file-nya terbanyak', many?.dir === '/home/user/project/b', JSON.stringify(many));
  check('daftar sub-folder disebutkan', /\/home\/user\/project\/a/.test(many?.note ?? ''), String(many?.note));

  const none = chooseAppDir({ scan: parseAppDirScan(''), root: '/home/user/project' });
  check('tanpa tanda aplikasi => null (pemanggil memberi peringatan)', none === null, JSON.stringify(none));
  check('pemindaian gagal => null (tidak menebak)', chooseAppDir({ scan: parseAppDirScan('__AC_NO_ROOT__'), root: '/home/user/project' }) === null);

  // Terpasang di jalur deploy: sub-folder dipakai untuk MENGIRIM file ke Vercel.
  const fake = new FakeSandbox({ logAfterPolls: 1, log: 'Production: https://x-1.vercel.app [3s]\n' + DEPLOY_EXIT_PREFIX + '0\n' });
  (fake.commands.run as unknown as (c: string, o?: Record<string, unknown>) => Promise<unknown>) = async (
    command: string,
    options: { background?: boolean; cwd?: string; envs?: Record<string, string> } = {},
  ) => {
    if (options.background) return { pid: 777, stdout: '', stderr: '', exitCode: 0 };
    fake.foreground.push(command);
    if (command.includes('__AC_ROOT_APP__') || command.includes('__AC_CAND__')) {
      return { pid: 1, stdout: '__AC_CAND__ /home/user/project/sistem-kasir 42\n', stderr: '', exitCode: 0 };
    }
    return { pid: 1, stdout: '', stderr: '', exitCode: 0 };
  };
  fake.fs.set('/home/user/.agentcloud-servers.json', JSON.stringify({ servers: [] }));
  const detected = await detectAppDir(fake.asSandbox());
  check('detectAppDir memilih sub-folder aplikasi', detected?.dir === '/home/user/project/sistem-kasir', JSON.stringify(detected));
}

console.log('\n[13] deploy belum selesai: agent BERHENTI (tidak mengulang polling)');
{
  // Insiden nyata: pesan tool berbunyi "panggil tool deploy sekali lagi untuk
  // melanjutkan", jadi agent mengulanginya tiap langkah sampai batas langkah —
  // chat user penuh puluhan baris "Deploy masih berjalan. Saya akan cek sekali lagi".
  check('formatDuration: menit + detik', formatDuration(185_000) === '3 menit 5 detik', formatDuration(185_000));
  check('formatDuration: detik saja', formatDuration(42_000) === '42 detik', formatDuration(42_000));
  check('formatDuration: lebih dari sejam', /jam/.test(formatDuration(2 * 3_600_000)), formatDuration(2 * 3_600_000));

  const script = deployStartedAtScript();
  check('waktu mulai deploy dibaca dari mtime file PID', script.includes(DEPLOY_PID_PATH) && script.includes('stat -c %Y'), script);
  check('detik diubah ke ms', parseDeployStartedAt('1791900000') === 1791900000000, String(parseDeployStartedAt('1791900000')));
  check('nilai ms dipakai apa adanya', parseDeployStartedAt('1791900000123') === 1791900000123);
  check('0 = tidak terbaca (jangan menebak)', parseDeployStartedAt('0') === null);
  check('sampah = tidak terbaca', parseDeployStartedAt('bukan-angka') === null);

  const runningMsg = deployStillRunningMessage({ ageMs: 150_000, stalled: false });
  check('pesan "belum selesai" melarang memanggil tool lagi', /JANGAN panggil tool `deploy` lagi/.test(runningMsg), runningMsg);
  check('pesan "belum selesai" TIDAK menyuruh mengulang polling', !/panggil tool deploy sekali lagi/i.test(runningMsg), runningMsg);
  check('pesan "belum selesai" menyebut tombol Deploy ke user', /Deploy ke Vercel/.test(runningMsg), runningMsg);
  const stalledMsg = deployStillRunningMessage({ ageMs: 20 * 60_000, stalled: true });
  check('pesan macet menyebut durasinya', /20 menit/.test(stalledMsg), stalledMsg);
  check('pesan macet menyatakan kemungkinan tertahan', /tertahan/.test(stalledMsg), stalledMsg);

  // Lewat tool: pemanggilan pertama (belum macet) tetap harus menutup giliran.
  process.env.DEPLOY_TOOL_WAIT_MS = '6000';
  process.env.DEPLOY_TOOL_POLL_MS = '200';
  const fake = new FakeSandbox({ logAfterPolls: 999, log: 'Uploading files…\n' });
  fake.statSeconds = Math.floor(Date.now() / 1000) - 90; // deploy baru 90 detik
  const ctx = {
    sandbox: fake.asSandbox(),
    sandboxId: 'stop-turn-test',
    deploy: { token: TOKEN, scope: '', projectName: 'sistem-kasir' },
  };
  const first = await executeTool(ctx, 'deploy', {});
  check('belum selesai => stopTurn diminta', first.stopTurn === true, JSON.stringify({ stopTurn: first.stopTurn, out: first.output.slice(0, 160) }));
  check('keluaran memuat deploy_belum_selesai', /deploy_belum_selesai/.test(first.output), first.output.slice(0, 300));
  check('keluaran tidak lagi menyuruh memanggil ulang', !/panggil tool deploy sekali lagi untuk melanjutkan/.test(first.output), first.output.slice(0, 300));
  check('durasi deploy dilaporkan apa adanya', /berjalan_sejak: 1 menit/.test(first.output), first.output.slice(0, 300));

  // Pemanggilan kedua di giliran yang sama: dianggap macet, tetap berhenti.
  const second = await executeTool({ ...ctx, sandbox: fake.asSandbox() }, 'deploy', {});
  check('pemanggilan kedua => deploy_macet', /deploy_macet/.test(second.output), second.output.slice(0, 300));
  check('pemanggilan kedua tetap stopTurn', second.stopTurn === true);

  // Deploy yang berhasil me-reset hitungan: pemanggilan berikutnya bukan "macet".
  const okFake = new FakeSandbox({
    logAfterPolls: 1,
    log: `✅  Production: https://kasir-app.vercel.app [9s]\n${DEPLOY_EXIT_PREFIX}0\n`,
  });
  okFake.statSeconds = Math.floor(Date.now() / 1000) - 30;
  const okCtx = { sandbox: okFake.asSandbox(), sandboxId: 'stop-turn-test', deploy: { token: TOKEN, scope: '', projectName: 'kasir-app' } };
  const okResult = await executeTool(okCtx, 'deploy', {});
  check('deploy sukses tidak meminta berhenti', okResult.ok === true && !okResult.stopTurn, JSON.stringify({ ok: okResult.ok }));
  const afterReset = await executeTool(ctx, 'deploy', {});
  check('setelah sukses, hitungan pemanggilan direset', /deploy_belum_selesai/.test(afterReset.output), afterReset.output.slice(0, 200));

  // Deploy yang sudah terlalu lama: langsung dinyatakan macet walau baru dipanggil.
  const oldFake = new FakeSandbox({ logAfterPolls: 999, log: 'Uploading…\n' });
  oldFake.statSeconds = Math.floor(Date.now() / 1000) - 30 * 60;
  const old = await executeTool(
    { sandbox: oldFake.asSandbox(), sandboxId: 'stale-deploy', deploy: { token: TOKEN, scope: '', projectName: 'kasir' } },
    'deploy',
    {},
  );
  check('deploy 30 menit => langsung dianggap macet', /deploy_macet/.test(old.output), old.output.slice(0, 200));

  delete process.env.DEPLOY_TOOL_WAIT_MS;
  delete process.env.DEPLOY_TOOL_POLL_MS;
}

console.log(`\nhasil: ${pass} ok, ${fail} gagal`);
if (fail) process.exit(1);
