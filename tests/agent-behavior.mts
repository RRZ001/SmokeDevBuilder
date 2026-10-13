/**
 * Uji PERILAKU agent loop seperti VibeCoder — sandbox & OpenRouter TIRUAN,
 * tanpa kredit E2B/OpenRouter.
 *
 * Tiga perilaku yang diuji (semuanya keluhan nyata user):
 *  1. Agent yang BERTANYA (blok `:::choices`) harus BERHENTI dan menunggu jawaban
 *     user — bukan bertanya lalu tetap memanggil tool dan jalan sendiri.
 *  2. Rencana (`:::plan`) muncul sebagai event/blok tersendiri, dan markup-nya
 *     tidak pernah bocor ke teks yang ditampilkan.
 *  3. Kalau agent sudah menjalankan preview server tetapi belum memeriksa
 *     tampilannya, loop mengingatkannya SEKALI untuk memakai `browser_check`
 *     (dan tidak mengulanginya terus).
 */
import type { Sandbox } from '@e2b/code-interpreter';
import { runAgent, type AgentEvent } from '@/lib/agent/loop';
import type { Block, PlanBlock, ChoicesBlock } from '@/lib/db/types';

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

const HEALTHY_REPORT = {
  url: 'http://127.0.0.1:3000/',
  viewport: { width: 375, height: 812 },
  status: 200,
  title: 'App',
  h1: 'Halo',
  textLength: 900,
  loadMs: 400,
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

/** Sandbox tiruan: cukup untuk start_server + browser_check. */
class FakeSandbox {
  fs = new Map<string, string>();
  /** Perintah background yang benar-benar dijalankan (bukti tool dieksekusi). */
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

  get sandboxId() {
    return 'fake-sandbox-behavior';
  }

  getHost(port: number) {
    return `${port}-fake.e2b.dev`;
  }

  commands = {
    run: async (command: string, options: { background?: boolean } = {}) => {
      if (options.background) {
        this.starts.push(command);
        return { pid: 4242, stdout: 'dev server starting...\n', stderr: '', exitCode: 0 };
      }
      if (command.includes('kill -0')) return { pid: 1, stdout: 'READY 200\n', stderr: '', exitCode: 0 };
      if (command.includes('CODE')) {
        return { pid: 1, stdout: 'CODE 200\nSCAN ok\n0.0.0.0:3000\n', stderr: '', exitCode: 0 };
      }
      if (command.includes('agentcloud-browser-ready')) {
        return { pid: 1, stdout: '__AC_BROWSER_READY__ penanda\n', stderr: '', exitCode: 0 };
      }
      if (command.includes('browser-check.mjs')) {
        return { pid: 1, stdout: `\n__AC_BROWSER_JSON__${JSON.stringify(HEALTHY_REPORT)}\n`, stderr: '', exitCode: 0 };
      }
      return { pid: 1, stdout: '', stderr: '', exitCode: 0 };
    },
    kill: async () => true,
  };

  asSandbox(): Sandbox {
    return this as unknown as Sandbox;
  }
}

/* ------------------------------------------------------------------ utilitas */

type Turn = {
  /** delta SSE yang dikirim pada giliran ini */
  events: string[];
};

/** SSE gaya OpenRouter untuk satu respons model. */
function sse(events: string[]): Response {
  return new Response(events.join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function textTurn(text: string): Turn {
  return {
    events: [
      `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    ],
  };
}

function toolTurn(calls: Array<{ id: string; name: string; args: unknown }>): Turn {
  const deltaCalls = calls.map((call, index) => ({
    index,
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
  }));
  return {
    events: [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: deltaCalls }, finish_reason: 'tool_calls' }] })}\n\n`,
    ],
  };
}

/** Jalankan agent dengan urutan giliran model yang sudah ditentukan. */
async function runTurns(turns: Turn[], userText: string, options: { shot?: boolean } = {}) {
  const sandbox = new FakeSandbox();
  if (options.shot) {
    // Sandbox nyata menyimpan screenshot sebagai base64 di file tetap.
    sandbox.fs.set('/home/user/.agentcloud-shot.jpg', Buffer.from('ffd8ffe000104a4649460001', 'hex').toString('base64'));
  }
  const captured: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  let call = 0;

  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.OPENROUTER_BASE_URL;
  process.env.OPENROUTER_BASE_URL = 'http://mock-openrouter.local/api/v1';
  process.env.VISION_MODELS = '!deepseek/deepseek-chat-v3.1';

  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    // Probe URL preview E2B (bukan panggilan model): balas seperti aplikasi sehat.
    if (!url.includes('chat/completions')) {
      return new Response('<html><body><h1>app</h1></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    captured.push(JSON.parse(String(init?.body ?? '{}')) as { messages: Array<{ role: string; content: unknown }> });
    const turn = turns[Math.min(call, turns.length - 1)];
    call += 1;
    return sse(turn.events);
  }) as unknown as typeof fetch;

  const events: AgentEvent[] = [];
  try {
    for await (const event of runAgent({
      apiKey: 'sk-test',
      model: 'deepseek/deepseek-chat-v3.1',
      history: [],
      userText,
      toolCtx: { sandbox: sandbox.asSandbox(), sandboxId: 'fake-sandbox-behavior' },
    })) {
      events.push(event);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.OPENROUTER_BASE_URL;
    else process.env.OPENROUTER_BASE_URL = originalUrl;
    delete process.env.VISION_MODELS;
  }

  const done = events.find((e) => e.type === 'done') as { type: 'done'; blocks: Block[]; content: string } | undefined;
  return { events, sandbox, captured, blocks: done?.blocks ?? [], requests: captured.length };
}

/* ------------------------------------------------------- 1. bertanya lalu diam */

console.log('\n[1] agent bertanya => berhenti, tool tidak dieksekusi');
{
  const ask = `Aku butuh sedikit info dulu.

:::choices
Q: Desain seperti apa?
- Bold & colorful ala startup SaaS
- Minimalis bersih ala Linear
:::

Setelah kamu pilih, aku langsung kerjakan.`;

  const { events, sandbox, blocks, requests } = await runTurns(
    [
      {
        events: [
          `data: ${JSON.stringify({ choices: [{ delta: { content: ask } }] })}\n\n`,
          // Model "membandel": tetap memanggil tool di giliran yang sama.
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'm1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'index.html', content: '<h1>x</h1>' }) } },
                    { index: 1, id: 'm2', type: 'function', function: { name: 'start_server', arguments: JSON.stringify({ command: 'npm run dev', port: 3000 }) } },
                  ],
                },
              },
            ],
          })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
        ],
      },
      textTurn('Seharusnya giliran ini tidak pernah terjadi.'),
    ],
    'buatkan landing page',
  );

  check('tool TIDAK dieksekusi (tidak ada server dijalankan)', sandbox.starts.length === 0, JSON.stringify(sandbox.starts));
  check('file TIDAK ditulis oleh tool', !sandbox.fs.has('/home/user/project/index.html'));
  check('hanya satu respons model yang diminta', requests === 1, String(requests));
  check('tidak ada perintah tool yang dipancarkan', !events.some((e) => e.type === 'tool_start'), JSON.stringify(events.map((e) => e.type)));
  check('status menjelaskan sedang menunggu jawaban', events.some((e) => e.type === 'status' && /menunggu jawaban/i.test(e.message)));
  const choices = blocks.find((b): b is ChoicesBlock => b.type === 'choices');
  check('blok pilihan tersimpan di pesan', Boolean(choices) && choices!.questions.length === 1, JSON.stringify(blocks.map((b) => b.type)));
  check('pertanyaan terbaca dari markup agent', choices?.questions[0]?.question === 'Desain seperti apa?', JSON.stringify(choices?.questions[0]));
  check('markup tidak tertinggal di teks pesan', !(blocks[0] as { text?: string }).text?.includes(':::choices'));
}

/* ------------------------------------------------- 2. rencana yang terlihat */

console.log('\n[2] blok rencana dipancarkan & tersimpan');
{
  const withPlan = `Aku mulai sekarang.

:::plan
- Periksa struktur proyek
- Tulis halaman + style
- [x] Jalankan dev server
:::

Sekarang aku lanjut menulis halamannya.`;

  const { events, blocks } = await runTurns([textTurn(withPlan)], 'buat landing page');

  const planEvents = events.filter((e) => e.type === 'plan') as Array<{ type: 'plan'; items: Array<{ text: string; done: boolean }> }>;
  check('event plan dipancarkan', planEvents.length === 1, String(planEvents.length));
  check('event plan memuat 3 langkah', planEvents[0]?.items.length === 3, JSON.stringify(planEvents[0]?.items));
  check('langkah yang dicentang terbaca done', planEvents[0]?.items[2]?.done === true);

  const planBlock = blocks.find((b): b is PlanBlock => b.type === 'plan');
  check('blok plan tersimpan (tahan reload)', planBlock?.items.length === 3, JSON.stringify(blocks.map((b) => b.type)));

  const streamed = events.filter((e) => e.type === 'text').map((e) => (e as { value: string }).value).join('');
  check('markup plan tidak pernah tampil di teks streaming', !streamed.includes(':::'), streamed);
  check('isi rencana tidak bocor sebagai teks', !streamed.includes('Tulis halaman + style'), streamed);
  check('teks di luar blok tetap terkirim', streamed.includes('Aku mulai sekarang.'));
}

/* --------------------------------- 3. nudge memeriksa tampilan (sekali saja) */

console.log('\n[3] nudge browser_check setelah server jalan');
{
  const { events, captured, requests, sandbox } = await runTurns(
    [
      toolTurn([{ id: 's1', name: 'start_server', args: { command: 'npm run dev -- --host 0.0.0.0 --port 3000', port: 3000 } }]),
      textTurn('Preview sudah jalan, selesai.'),
      textTurn('Seharusnya tidak terjadi.'),
    ],
    'jalankan server lalu pastikan tampilannya bagus',
  );

  check('server benar-benar dijalankan oleh tool', sandbox.starts.length === 1, JSON.stringify(sandbox.starts));
  check('agent diingatkan memeriksa tampilan', events.some((e) => e.type === 'status' && /memeriksa tampilannya/i.test(e.message)));
  check('hanya satu kali pengingat (tidak mengulang)', requests === 2, String(requests));
  const nudgeSent = JSON.stringify(captured[1]?.messages ?? []).includes('BELUM memeriksa tampilannya');
  check('pesan pengingat dikirim ke model', nudgeSent);
  check('pengingat menyebut tool browser_check', JSON.stringify(captured[1]?.messages ?? []).includes('browser_check'));
  check('pengingat menyebut mobile & desktop', JSON.stringify(captured[1]?.messages ?? []).includes('mobile'));
  check('giliran tetap ditutup dengan pesan model', events.some((e) => e.type === 'done'));
}

console.log('\n[4] tidak ada nudge kalau tampilan sudah diperiksa');
{
  const { events, captured } = await runTurns(
    [
      toolTurn([
        { id: 's1', name: 'start_server', args: { command: 'npm run dev -- --host 0.0.0.0 --port 3000', port: 3000 } },
        { id: 'b1', name: 'browser_check', args: { port: 3000, viewport: 'mobile' } },
      ]),
      textTurn('Sudah saya periksa di 375px dan desktop — bersih.'),
    ],
    'jalankan server lalu cek tampilannya',
    { shot: true },
  );

  check('tidak ada pengingat tambahan', !events.some((e) => e.type === 'status' && /memeriksa tampilannya/i.test(e.message)));
  check('hasil browser_check terkirim ke UI', events.some((e) => e.type === 'tool_result' && e.name === 'browser_check'));
  check('screenshot diteruskan sebagai event image', events.some((e) => e.type === 'image'));
  check('model text-only diberi tahu ia tidak melihat gambar', JSON.stringify(captured[1]?.messages ?? []).includes('TIDAK bisa dikirim ke model'));
}

console.log(`\nhasil: ${pass} ok, ${fail} gagal`);
if (fail) process.exit(1);
