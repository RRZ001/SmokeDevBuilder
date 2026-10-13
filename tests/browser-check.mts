/**
 * Uji pemeriksaan UI lewat browser (Playwright) — TANPA kredit E2B.
 *
 * Dua lapis:
 *  A. MURNI — parse laporan, penilaian (judge), ringkasan, viewport, deteksi
 *     kemampuan gambar model.
 *  B. NYATA — script yang sama yang ditulis ke sandbox benar-benar dijalankan
 *     dengan Chromium di depan dua halaman contoh (satu sehat, satu rusak),
 *     lalu hasilnya diperiksa. Inilah yang membuktikan alat ini bekerja, bukan
 *     sekadar lolos type-check.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BROWSER_SCRIPT_PATH,
  REPORT_MARKER,
  browserScript,
  judgeReport,
  parseBrowserReport,
  summarizeBrowserReport,
  viewportFor,
} from '@/lib/sandbox/browser';
import { visionByPattern } from '@/lib/agent/vision';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIXTURES = path.join(HERE, '..', '..', '_probe', 'browser-fixtures');
const SHOT = path.join(HERE, '..', '..', '_probe', 'browser-fixtures', 'shot.jpg');
const SHARED_PLAYWRIGHT = '/var/lib/vibecoderco/shared-node-modules/node_modules/playwright/index.mjs';

/* ------------------------------------------------------------------ A. murni */

console.log('\n[A1] viewport');
{
  check('mobile = 375x812', viewportFor('mobile').width === 375 && viewportFor('mobile').height === 812);
  check('desktop default', viewportFor(undefined).width === 1440);
  check('nama tidak dikenal -> desktop', viewportFor('tv').width === 1440);
  check('custom dipakai apa adanya', viewportFor('mobile', { width: 500, height: 700 }).width === 500);
  check('custom dibatasi batas aman (min 240)', viewportFor(null, { width: 10, height: 10 }).width === 240);
  check('custom dibatasi batas aman (max 3840)', viewportFor(null, { width: 99999, height: 99999 }).width === 3840);
}

console.log('\n[A2] parse laporan');
const sample = {
  url: 'http://127.0.0.1:3000/',
  viewport: { width: 1440, height: 900 },
  status: 200,
  title: 'Judul',
  h1: 'Halo',
  textLength: 1234,
  loadMs: 850,
  screenshot: true,
  consoleErrors: [{ type: 'error', text: 'boom' }],
  consoleWarnings: [],
  pageErrors: [],
  failedRequests: [],
  httpErrors: [],
  horizontalOverflow: false,
  overflowPx: 0,
  overflowingElements: 0,
  brokenImages: 0,
};
{
  const stdout = `npm noise line\n${REPORT_MARKER}${JSON.stringify(sample)}\n`;
  const report = parseBrowserReport(stdout);
  check('laporan dibaca dari stdout ber-noise', report?.status === 200 && report?.title === 'Judul');
  check('tanpa penanda -> null', parseBrowserReport('tidak ada apa-apa') === null);
  check('JSON rusak -> null', parseBrowserReport(`${REPORT_MARKER}{rusak`) === null);
  check('stdout kosong -> null', parseBrowserReport('') === null);
  check('field hilang tetap aman', (() => {
    const r = parseBrowserReport(`${REPORT_MARKER}{"status":null}`);
    return r !== null && r.consoleErrors.length === 0 && r.textLength === 0 && r.horizontalOverflow === false;
  })());
  check('penanda di tengah log (lastIndexOf) tetap terbaca', (() => {
    const r = parseBrowserReport(`${REPORT_MARKER}${JSON.stringify({ status: 200 })}\nlog setelahnya`);
    return r?.status === 200;
  })());
}

console.log('\n[A3] penilaian masalah');
{
  const clean = judgeReport({ ...sample, consoleErrors: [] } as never);
  check('halaman bersih -> ok', clean.ok && clean.problems.length === 0);
  check('halaman bersih memberi catatan positif', clean.notes.some((n) => /normal/i.test(n)));

  const withConsole = judgeReport({ ...sample, consoleErrors: [{ type: 'error', text: 'boom' }] } as never);
  check('error console terdeteksi', !withConsole.ok && /console browser/i.test(withConsole.problems[0]));

  const jsError = judgeReport({ ...sample, consoleErrors: [], pageErrors: ['x is not defined'] } as never);
  check('error JS terdeteksi', !jsError.ok && /JavaScript/i.test(jsError.problems[0]));

  const overflow = judgeReport({ ...sample, consoleErrors: [], horizontalOverflow: true, overflowPx: 240, overflowingElements: 3 } as never);
  check('scroll horizontal terdeteksi', !overflow.ok && /scroll horizontal/i.test(overflow.problems[0]));
  check('detail overflow disebut', overflow.problems[0].includes('240px'));

  const http500 = judgeReport({ ...sample, consoleErrors: [], status: 500 } as never);
  check('HTTP 500 terdeteksi', !http500.ok && /HTTP 500/.test(http500.problems[0]));

  const noResponse = judgeReport({ ...sample, consoleErrors: [], status: null } as never);
  check('tanpa respons terdeteksi', !noResponse.ok && /tidak bisa dibuka/i.test(noResponse.problems[0]));

  const broken = judgeReport({ ...sample, consoleErrors: [], brokenImages: 2 } as never);
  check('gambar rusak terdeteksi', !broken.ok && /gambar gagal dimuat/i.test(broken.problems[0]));

  const empty = judgeReport({ ...sample, consoleErrors: [], textLength: 12 } as never);
  check('halaman hampir kosong terdeteksi', !empty.ok && /hampir kosong/i.test(empty.problems[0]));

  const scriptError = judgeReport({ ...sample, consoleErrors: [], error: "Executable doesn't exist" } as never);
  check('kegagalan browser dilaporkan sebagai masalah', !scriptError.ok && /Browser gagal/.test(scriptError.problems[0]));

  const manyProblems = judgeReport({
    ...sample,
    consoleErrors: [{ type: 'error', text: 'a' }],
    pageErrors: ['b'],
    horizontalOverflow: true,
    overflowPx: 10,
    overflowingElements: 1,
  } as never);
  check('beberapa masalah dilaporkan sekaligus', manyProblems.problems.length >= 3, String(manyProblems.problems.length));
}

console.log('\n[A4] ringkasan untuk model');
{
  const cleanSample = { ...sample, consoleErrors: [] as typeof sample.consoleErrors };
  const report = parseBrowserReport(`${REPORT_MARKER}${JSON.stringify(cleanSample)}`)!;
  const text = summarizeBrowserReport(report, judgeReport(report), { viewportName: 'desktop' });
  for (const needle of ['url:', 'http_status: 200', 'viewport: 1440x900 (desktop)', 'scroll_horizontal: tidak ada', 'status: BAIK']) {
    check(`ringkasan memuat "${needle}"`, text.includes(needle));
  }
  const bad = parseBrowserReport(`${REPORT_MARKER}${JSON.stringify({ ...sample, consoleErrors: [{ type: 'error', text: 'boom' }] })}`)!;
  const badText = summarizeBrowserReport(bad, judgeReport(bad));
  check('ringkasan menandai masalah dengan tegas', /ADA MASALAH/.test(badText) && /- .*console/.test(badText));
  check('ringkasan tidak membocorkan data mentah', !badText.includes('{"url"'));
}

console.log('\n[A5] deteksi kemampuan gambar model');
{
  check('claude sonnet -> bisa gambar', visionByPattern('anthropic/claude-sonnet-4.5') === 'yes');
  check('gpt-5 -> bisa gambar', visionByPattern('openai/gpt-5.6-luna') === 'yes');
  check('gemini -> bisa gambar', visionByPattern('google/gemini-3-pro') === 'yes');
  check('glm flash -> bisa gambar', visionByPattern('z-ai/glm-5.3-flash') === 'yes');
  check('kimi k3 -> bisa gambar', visionByPattern('moonshotai/kimi-k3') === 'yes');
  check('deepseek chat -> TIDAK bisa gambar', visionByPattern('deepseek/deepseek-chat-v3.1') === 'no');
  check('deepseek r1 -> TIDAK bisa gambar', visionByPattern('deepseek/deepseek-r1') === 'no');
  check('deepseek v4 flash -> TIDAK bisa gambar', visionByPattern('deepseek/deepseek-v4-flash') === 'no');
  check('kimi k2 -> TIDAK bisa gambar', visionByPattern('moonshotai/kimi-k2.6') === 'no');
  check('model asing -> unknown', visionByPattern('perusahaan/model-baru') === 'unknown');
  check('string kosong -> unknown', visionByPattern('') === 'unknown');
}

/* ------------------------------------------------------------------ B. nyata */

console.log('\n[B] eksekusi nyata dengan Chromium');
{
  if (!existsSync(FIXTURES)) {
    check('folder fixture ada', false, FIXTURES);
  } else {
    // Server statis kecil untuk melayani dua halaman contoh.
    const server = createServer(async (req, res) => {
      const url = (req.url || '/').split('?')[0];
      const file = url === '/' || url === '/good' ? 'good.html' : url === '/bad' ? 'bad.html' : url.slice(1);
      try {
        const body = await readFile(path.join(FIXTURES, file));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    });
    await new Promise<void>((resolve) => server.listen(4399, resolve));

    const scriptPath = path.join(FIXTURES, 'browser-check.mjs');
    writeFileSync(scriptPath, browserScript({ screenshotPath: SHOT }), 'utf8');

    const runScript = (env: Record<string, string>) =>
      new Promise<{ stdout: string; code: number | null }>((resolve) => {
        const child = spawn('node', [scriptPath], {
          env: { ...process.env, AC_PLAYWRIGHT: SHARED_PLAYWRIGHT, ...env },
        });
        let stdout = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stdout += d));
        child.on('close', (code) => resolve({ stdout, code }));
      });

    // B1. Halaman sehat, desktop.
    const good = await runScript({ AC_URL: 'http://127.0.0.1:4399/', AC_WIDTH: '1440', AC_HEIGHT: '900', AC_SETTLE: '300' });
    const goodReport = parseBrowserReport(good.stdout);
    check('skrip menghasilkan laporan', goodReport !== null, good.stdout.slice(-300));
    if (goodReport) {
      check('status 200 terbaca', goodReport.status === 200, String(goodReport.status));
      check('judul halaman terbaca', goodReport.title === 'Halaman Bagus', goodReport.title);
      check('h1 terbaca', goodReport.h1.includes('Kelola Bisnis'), goodReport.h1);
      check('teks terlihat terhitung', goodReport.textLength > 200, String(goodReport.textLength));
      check('tidak ada error console', goodReport.consoleErrors.length === 0, JSON.stringify(goodReport.consoleErrors));
      check('tidak ada scroll horizontal di desktop', goodReport.horizontalOverflow === false, String(goodReport.overflowPx));
      check('gambar tidak ada yang rusak', goodReport.brokenImages === 0);
      const verdict = judgeReport(goodReport);
      check('halaman sehat dinilai BAIK', verdict.ok, JSON.stringify(verdict.problems));
      check('screenshot dibuat', goodReport.screenshot === true);
    }
    check('file screenshot ada di disk & bukan kosong', existsSync(SHOT) && statSync(SHOT).size > 1000, String(existsSync(SHOT) ? statSync(SHOT).size : 'tidak ada'));
    check('screenshot berformat JPEG', existsSync(SHOT) && readFileSync(SHOT).subarray(0, 2).toString('hex') === 'ffd8');

    // B2. Halaman rusak: error JS + console error + gambar hilang + overflow di mobile.
    const bad = await runScript({ AC_URL: 'http://127.0.0.1:4399/bad', AC_WIDTH: '375', AC_HEIGHT: '812', AC_SETTLE: '300' });
    const badReport = parseBrowserReport(bad.stdout);
    check('laporan halaman rusak terbaca', badReport !== null);
    if (badReport) {
      check('error JS tertangkap', badReport.pageErrors.length >= 1, JSON.stringify(badReport.pageErrors));
      check('console error tertangkap', badReport.consoleErrors.some((e) => e.text.includes('gagal memuat data')), JSON.stringify(badReport.consoleErrors));
      check('gambar rusak terdeteksi (1)', badReport.brokenImages === 1, String(badReport.brokenImages));
      check('scroll horizontal terdeteksi di 375px', badReport.horizontalOverflow === true, String(badReport.overflowPx));
      check('overflow menyebut elemen pelakunya', badReport.overflowingElements >= 1, String(badReport.overflowingElements));
      check('request 404 ikut tercatat', badReport.httpErrors.some((r) => r.status === 404), JSON.stringify(badReport.httpErrors));
      const verdict = judgeReport(badReport);
      check('halaman rusak TIDAK dinilai baik', verdict.ok === false);
      check('masalah menyebut scroll horizontal & error', verdict.problems.some((p) => /scroll horizontal/i.test(p)) && verdict.problems.some((p) => /console|JavaScript/i.test(p)));
    }

    // B3. Halaman yang sama di desktop: lebar 900px TIDAK overflow.
    const badDesktop = await runScript({ AC_URL: 'http://127.0.0.1:4399/bad', AC_WIDTH: '1440', AC_HEIGHT: '900', AC_SETTLE: '300' });
    const badDesktopReport = parseBrowserReport(badDesktop.stdout);
    check('desktop 1440px tidak overflow (membuktikan cek per-viewport)', badDesktopReport?.horizontalOverflow === false, String(badDesktopReport?.overflowPx));

    server.close();
  }
}

console.log('\n[C] jalur kegagalan yang aman');
{
  const missing = await (async () => {
    const scriptPath = path.join(FIXTURES, 'browser-check.mjs');
    if (!existsSync(scriptPath)) return null;
    return new Promise<string>((resolve) => {
      const child = spawn('node', [scriptPath], {
        env: { ...process.env, AC_URL: 'http://127.0.0.1:9/tidak-ada', AC_SETTLE: '100', AC_TIMEOUT: '3000', AC_PLAYWRIGHT: SHARED_PLAYWRIGHT },
      });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stdout += d));
      child.on('close', () => resolve(stdout));
    });
  })();
  const report = missing ? parseBrowserReport(missing) : null;
  check('server mati tetap menghasilkan laporan (bukan crash)', report !== null);
  check('kegagalan koneksi ditandai masalah', report ? !judgeReport(report).ok : false);
}

console.log(`\nhasil: ${pass} ok, ${fail} gagal`);
if (failures.length) console.log('gagal:', failures.join(' | '));
if (fail) process.exit(1);
