/**
 * Uji integrasi tool `browser_check` di dalam agent loop — sandbox E2B TIRUAN.
 *
 * Yang dibuktikan:
 *  1. `browser_check` muncul di daftar tool yang dikirim ke model.
 *  2. Screenshot dari tool diteruskan sebagai event `image` (untuk UI) DAN
 *     dikirim ke model sebagai pesan bergambar — TAPI hanya kalau modelnya
 *     mendukung gambar; kalau tidak, agent diberi tahu bahwa ia tidak melihat.
 *  3. Blok tool tetap tersimpan (agar riwayat chat bisa dirender ulang).
 *  4. Install Playwright hanya dilakukan SEKALI (memakai penanda di sandbox).
 */
import type { Sandbox } from '@e2b/code-interpreter';
import { runAgent } from '@/lib/agent/loop';
import { supportsVision } from '@/lib/agent/vision';
import { TOOL_DEFINITIONS, ensureBrowser, executeTool } from '@/lib/sandbox/tools';

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

/** Sandbox tiruan yang melacak perintah & file. */
class FakeSandbox {
  fs = new Map<string, string>();
  runs: string[] = [];
  files = {
    read: async (p: string) => {
      const v = this.fs.get(p);
      if (v == null) throw new Error(`ENOENT ${p}`);
      return v;
    },
    write: async (p: string, content: string) => {
      this.fs.set(p, content);
      return { path: p };
    },
    makeDir: async () => ({}),
  };
  constructor(private behaves: { browserInstalled?: boolean } = {}) {}
  get sandboxId() {
    return 'fake-sandbox-browser';
  }
  getHost(port: number) {
    return `${port}-fake.e2b.dev`;
  }
  commands = {
    run: async (command: string) => {
      this.runs.push(command);
      // Penanda browser sudah ada → install dilewati.
      if (this.behaves.browserInstalled && command.includes('.agentcloud-browser-ready')) {
        return { pid: 1, stdout: '__AC_BROWSER_READY__ penanda\n', stderr: '', exitCode: 0 };
      }
      if (command.includes('playwright install') || command.includes('npm install')) {
        return { pid: 1, stdout: 'Menyiapkan Playwright...\n__AC_BROWSER_READY__ baru\n', stderr: '', exitCode: 0 };
      }
      if (command.includes('chromium.launch') && command.includes('console.log("OK")')) {
        return { pid: 1, stdout: 'OK\n', stderr: '', exitCode: 0 };
      }
      if (command.includes('browser-check.mjs')) {
        // Laporan palsu: halaman sehat.
        const report = {
          url: 'http://127.0.0.1:3000/',
          viewport: { width: 375, height: 812 },
          status: 200,
          title: 'App',
          h1: 'Halo',
          textLength: 900,
          loadMs: 500,
          screenshot: true,
          consoleErrors: [],
          consoleWarnings: [],
          pageErrors: [],
          failedRequests: [],
          httpErrors: [],
          horizontalOverflow: false,
          overflowPx: 0,
          overflowingElements: 0,
          brokenImages: 0,
        };
        return { pid: 1, stdout: `\n__AC_BROWSER_JSON__${JSON.stringify(report)}\n`, stderr: '', exitCode: 0 };
      }
      return { pid: 1, stdout: '', stderr: '', exitCode: 0 };
    },
    kill: async () => true,
  };
  asSandbox() {
    return this as unknown as Sandbox;
  }
}

const FAKE_JPEG_BASE64 = Buffer.from('ffd8ffe000104a4649460001', 'hex').toString('base64');

console.log('\n[1] tool terdaftar untuk model');
{
  const names = TOOL_DEFINITIONS.map((t) => t.function.name);
  check('browser_check ada di daftar tool', names.includes('browser_check'), names.join(','));
  const def = TOOL_DEFINITIONS.find((t) => t.function.name === 'browser_check')!;
  const description = def.function.description ?? '';
  check('deskripsi menyuruh memakai sebelum klaim selesai', /WAJIB dipakai sebelum mengklaim/i.test(description));
  check('deskripsi menyebut viewport mobile & desktop', /mobile/.test(description) && /desktop/.test(description));
  check('parameter viewport berupa enum', JSON.stringify(def.function.parameters).includes('"enum"'));
  // 9 sejak tool `deploy` (lihat tests/vercel-deploy.mts) ditambahkan.
  check('jumlah tool menjadi 9', names.length === 9, String(names.length));
}

console.log('\n[2] install browser sekali saja (penanda)');
{
  // Sandbox tiruan: satu perintah berisi SELURUH skrip instalasi, jadi mock
  // hanya bisa memutuskan berdasarkan isi skripnya. Yang diuji di sini adalah
  // keputusan level script: penanda membuat instalasi dilewati.
  const fresh = new FakeSandbox();
  const first = await ensureBrowser(fresh.asSandbox());
  check('install pertama berhasil', first.ok, first.message);
  check('skrip instalasi memuat npm install + chromium', fresh.runs.some((c) => /npm install/.test(c) && /playwright install/.test(c)));
  check('laporan menunjukkan browser baru disiapkan', /baru disiapkan|browser siap/i.test(first.message), first.message);

  const already = new FakeSandbox({ browserInstalled: true });
  const second = await ensureBrowser(already.asSandbox());
  check('sandbox yang sudah siap memakai penanda (tidak unduh ulang)', /penanda/i.test(second.message), second.message);

  const broken = new FakeSandbox();
  broken.commands.run = async (command: string) => {
    broken.runs.push(command);
    return { pid: 1, stdout: '__AC_BROWSER_FAIL__ Chromium tidak bisa dibuka di sandbox ini', stderr: '', exitCode: 1 };
  };
  const failed = await ensureBrowser(broken.asSandbox());
  check('kegagalan install dilaporkan (bukan crash)', failed.ok === false && /gagal disiapkan|belum siap/i.test(failed.message), failed.message);
  check('pesan kegagalan menyarankan verifikasi alternatif', /Verifikasi UI dengan cara lain/i.test(failed.message), failed.message);
  check('pesan kegagalan memuat alasan dari sandbox', /Chromium tidak bisa dibuka/.test(failed.message));

  // Instalasi yang belum selesai (mis. kena batas durasi fungsi hosting) harus
  // diarahkan untuk MELANJUTKAN, bukan dianggap gagal permanen.
  const partialSandbox = new FakeSandbox();
  partialSandbox.commands.run = async () => ({
    pid: 1,
    stdout: 'Menyiapkan Playwright (sekali per sandbox, ±1-3 menit)...\nMengunduh Chromium...',
    stderr: '',
    // Tanpa exitCode DAN tanpa token: harness mensimulasikan perintah yang
    // terbunuh batas waktu (SDK bisa melaporkan ini seolah sukses).
    exitCode: undefined,
  });
  const partial = await ensureBrowser(partialSandbox.asSandbox());
  check('instalasi belum selesai -> disarankan panggil lagi', /SEKALI LAGI/.test(partial.message), partial.message);
  check('instalasi belum selesai -> tidak dianggap gagal permanen', /tidak diulang/.test(partial.message), partial.message);
}

console.log('\n[3] eksekutor tool: laporan + screenshot');
{
  const fake = new FakeSandbox({ browserInstalled: true });
  fake.fs.set('/home/user/.agentcloud-shot.jpg', FAKE_JPEG_BASE64);
  const result = await executeTool(
    { sandbox: fake.asSandbox(), sandboxId: 'fake-sandbox-browser' },
    'browser_check',
    { port: 3000, viewport: 'mobile' },
  );
  check('tool sukses', result.ok, result.output.slice(0, 200));
  check('laporan memuat status & viewport', /http_status: 200/.test(result.output) && /375x812/.test(result.output));
  check('laporan menandai BAIK', /status: BAIK/.test(result.output));
  check('screenshot dilampirkan sebagai data URL JPEG', Boolean(result.image?.dataUrl.startsWith('data:image/jpeg;base64,')));
  check('caption menyebut url & ukuran', /127\.0\.0\.1:3000/.test(result.image?.caption ?? '') && /375x812/.test(result.image?.caption ?? ''));
  check('skrip browser ditulis ke path tetap', fake.fs.has('/home/user/.agentcloud-browser/browser-check.mjs'));

  const noShot = new FakeSandbox({ browserInstalled: true });
  const result2 = await executeTool({ sandbox: noShot.asSandbox(), sandboxId: 'fake-sandbox-browser' }, 'browser_check', { port: 3000 });
  check('tanpa file screenshot tetap ok (tidak gagal)', result2.ok && !result2.image);

  const badReport = new FakeSandbox({ browserInstalled: true });
  badReport.commands.run = async (command: string) => {
    if (command.includes('browser-check.mjs')) {
      return {
        pid: 1,
        stdout: `\n__AC_BROWSER_JSON__${JSON.stringify({ status: 200, url: 'x', textLength: 900, horizontalOverflow: true, overflowPx: 40, overflowingElements: 2, screenshot: false, consoleErrors: [], pageErrors: [] })}\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (command.includes('agentcloud-browser-ready')) return { pid: 1, stdout: '__AC_BROWSER_READY__ penanda\n', stderr: '', exitCode: 0 };
    return { pid: 1, stdout: '', stderr: '', exitCode: 0 };
  };
  const result3 = await executeTool({ sandbox: badReport.asSandbox(), sandboxId: 'x' }, 'browser_check', {});
  check('overflow horizontal membuat tool TIDAK ok', result3.ok === false);
  check('masalah disebut di keluaran tool', /scroll horizontal/i.test(result3.output), result3.output.slice(0, 300));
}

console.log('\n[4] agent loop: gambar ke model hanya kalau model bisa melihat');
{
  /** Server OpenRouter tiruan: balas tool call browser_check sekali, lalu teks. */
  function makeFetchStub(captured: Array<{ messages: unknown[] }>) {
    let call = 0;
    return async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages: unknown[] };
      captured.push({ messages: body.messages });
      call += 1;
      const events: string[] = [];
      if (call === 1) {
        events.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'browser_check', arguments: '{"port":3000,"viewport":"mobile"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
      } else {
        events.push(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Sudah saya cek.' } }] })}\n\n`);
        events.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      }
      events.push('data: [DONE]\n\n');
      return new Response(events.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
  }

  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.OPENROUTER_BASE_URL;

  async function runWithModel(model: string) {
    const fake = new FakeSandbox({ browserInstalled: true });
    fake.fs.set('/home/user/.agentcloud-shot.jpg', FAKE_JPEG_BASE64);
    const captured: Array<{ messages: unknown[] }> = [];
    globalThis.fetch = makeFetchStub(captured) as unknown as typeof fetch;
    process.env.OPENROUTER_BASE_URL = 'http://mock-openrouter.local/api/v1';
    process.env.VISION_MODELS = model.includes('deepseek') ? `!${model}` : model;

    const events: Array<Record<string, unknown>> = [];
    for await (const event of runAgent({
      apiKey: 'sk-test',
      model,
      history: [],
      userText: 'buat landing page lalu cek tampilannya',
      toolCtx: { sandbox: fake.asSandbox(), sandboxId: 'fake-sandbox-browser' },
    })) {
      events.push(event as Record<string, unknown>);
    }
    return { events, captured };
  }

  const visionRun = await runWithModel('anthropic/claude-sonnet-4.5');
  const visionImages = visionRun.events.filter((e) => e.type === 'image');
  check('event image dikirim ke UI', visionImages.length === 1, String(visionImages.length));
  check('event image berisi data URL', String(visionImages[0]?.dataUrl ?? '').startsWith('data:image/jpeg'));
  const secondRequest = visionRun.captured[1]?.messages as Array<{ role: string; content: unknown }>;
  const imageMessage = secondRequest?.find((m) => Array.isArray(m.content) && JSON.stringify(m.content).includes('image_url'));
  check('gambar dikirim ke model sebagai pesan image_url', Boolean(imageMessage));
  check('instruksi menilai tampilan ikut dikirim', JSON.stringify(imageMessage ?? {}).includes('desainer'));
  check('tool message tetap ada (riwayat valid)', secondRequest?.some((m) => m.role === 'tool'));

  const textOnlyRun = await runWithModel('deepseek/deepseek-chat-v3.1');
  const textOnlyMessages = textOnlyRun.captured[1]?.messages as Array<{ role: string; content: unknown }>;
  check('model text-only TIDAK dikirimi gambar', !textOnlyMessages?.some((m) => Array.isArray(m.content) && JSON.stringify(m.content).includes('image_url')));
  check('model text-only diberi tahu bahwa ia tidak melihat', JSON.stringify(textOnlyMessages ?? '').includes('TIDAK bisa dikirim ke model'));

  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.OPENROUTER_BASE_URL;
  else process.env.OPENROUTER_BASE_URL = originalUrl;
  delete process.env.VISION_MODELS;
}

console.log('\n[5] deteksi vision tidak memanggil jaringan untuk model yang jelas');
{
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  delete process.env.VISION_MODELS;
  const yes = await supportsVision('anthropic/claude-sonnet-4.5');
  const no = await supportsVision('deepseek/deepseek-chat-v3.1');
  check('claude -> true tanpa jaringan', yes === true && networkCalls === 0);
  check('deepseek chat -> false tanpa jaringan', no === false && networkCalls === 0);
  globalThis.fetch = originalFetch;
}

console.log(`\nhasil: ${pass} ok, ${fail} gagal`);
if (fail) process.exit(1);
