/**
 * Pemeriksaan UI lewat browser sungguhan (Playwright) DI DALAM sandbox.
 *
 * Kenapa ada: sebelumnya agent hanya tahu "server merespons HTTP 200" — ia tidak
 * pernah MELIHAT halamannya. Akibatnya dua kelas masalah lolos: (1) halaman putih
 * karena error JS, dan (2) tampilan rusak/berantakan yang mustahil dideteksi dari
 * status HTTP. Dengan modul ini agent bisa membuka halaman, membaca error konsol,
 * mengukur overflow horizontal, dan mengambil screenshot untuk dilihat sendiri.
 *
 * Script dijalankan di dalam sandbox dan menembak http://127.0.0.1:<port> —
 * sengaja TIDAK lewat URL publik E2B, supaya cepat, tidak butuh jaringan keluar,
 * dan tidak bergantung pada proxy port.
 *
 * Bagian murni (parse, ringkas, viewport) dipisah dari I/O supaya bisa diuji
 * tanpa kredit E2B — lihat tests/browser-report.mts.
 */

export const BROWSER_DIR = '/home/user/.agentcloud-browser';
export const BROWSER_SCRIPT_PATH = `${BROWSER_DIR}/browser-check.mjs`;
/** Penanda "browser sudah terpasang" di dalam sandbox (bertahan saat pause). */
export const BROWSER_MARKER = '/home/user/.agentcloud-browser-ready';
export const BROWSER_SHOT_PATH = '/home/user/.agentcloud-shot.jpg';

/** Penanda JSON di stdout supaya log lain tidak merusak parsing. */
export const REPORT_MARKER = '__AC_BROWSER_JSON__';

export const VIEWPORTS = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 },
} as const;

export type ViewportName = keyof typeof VIEWPORTS;

export function viewportFor(name?: string | null, custom?: { width?: number; height?: number }): { width: number; height: number; name: ViewportName | 'custom' } {
  if (custom?.width && custom?.height) {
    return { width: clamp(custom.width, 240, 3840), height: clamp(custom.height, 240, 2160), name: 'custom' };
  }
  const key = (name || 'desktop') as ViewportName;
  const preset = VIEWPORTS[key] ?? VIEWPORTS.desktop;
  return { ...preset, name: VIEWPORTS[key] ? key : 'desktop' };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/* -------------------------------------------------------------------------- */
/* Laporan                                                                    */
/* -------------------------------------------------------------------------- */

export type ConsoleEntry = { type: string; text: string };
export type FailedRequest = { url: string; error?: string; status?: number };

export type BrowserReport = {
  ok: boolean;
  url: string;
  viewport: { width: number; height: number };
  status: number | null;
  title: string;
  h1: string;
  textLength: number;
  loadMs: number;
  /** Screenshot berhasil dibuat. */
  screenshot: boolean;
  consoleErrors: ConsoleEntry[];
  consoleWarnings: ConsoleEntry[];
  pageErrors: string[];
  failedRequests: FailedRequest[];
  /** Respons dengan status >= 400 (selain favicon). */
  httpErrors: FailedRequest[];
  /** true = ada scroll horizontal (layout bocor di lebar ini). */
  horizontalOverflow: boolean;
  overflowPx: number;
  /** Jumlah elemen yang lebih lebar dari viewport. */
  overflowingElements: number;
  /** Gambar yang gagal dimuat (naturalWidth = 0). */
  brokenImages: number;
  error?: string;
};

export function parseBrowserReport(stdout: string): BrowserReport | null {
  if (!stdout) return null;
  const index = stdout.lastIndexOf(REPORT_MARKER);
  if (index === -1) return null;
  const rest = stdout.slice(index + REPORT_MARKER.length);
  // Ambil baris JSON pertama (script menulis tepat satu baris setelah penanda).
  const line = rest.split('\n').map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as Partial<BrowserReport>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return normalizeReport(parsed);
  } catch {
    return null;
  }
}

function normalizeReport(raw: Partial<BrowserReport>): BrowserReport {
  const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return {
    ok: true,
    url: String(raw.url ?? ''),
    viewport: {
      width: num((raw.viewport as { width?: number } | undefined)?.width, 0),
      height: num((raw.viewport as { height?: number } | undefined)?.height, 0),
    },
    status: typeof raw.status === 'number' ? raw.status : null,
    title: String(raw.title ?? ''),
    h1: String(raw.h1 ?? ''),
    textLength: num(raw.textLength),
    loadMs: num(raw.loadMs),
    screenshot: Boolean(raw.screenshot),
    consoleErrors: toEntries(raw.consoleErrors),
    consoleWarnings: toEntries(raw.consoleWarnings),
    pageErrors: toStringList(raw.pageErrors),
    failedRequests: toFailures(raw.failedRequests),
    httpErrors: toFailures(raw.httpErrors),
    horizontalOverflow: Boolean(raw.horizontalOverflow),
    overflowPx: num(raw.overflowPx),
    overflowingElements: num(raw.overflowingElements),
    brokenImages: num(raw.brokenImages),
    error: typeof raw.error === 'string' ? raw.error : undefined,
  };
}

function toEntries(value: unknown): ConsoleEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is ConsoleEntry => Boolean(v) && typeof v === 'object')
    .map((v) => ({ type: String((v as ConsoleEntry).type ?? ''), text: String((v as ConsoleEntry).text ?? '').slice(0, 400) }))
    .slice(0, 30);
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).slice(0, 400)).slice(0, 20);
}

function toFailures(value: unknown): FailedRequest[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is FailedRequest => Boolean(v) && typeof v === 'object')
    .map((v) => ({
      url: String((v as FailedRequest).url ?? '').slice(0, 300),
      error: (v as FailedRequest).error ? String((v as FailedRequest).error).slice(0, 200) : undefined,
      status: typeof (v as FailedRequest).status === 'number' ? (v as FailedRequest).status : undefined,
    }))
    .slice(0, 25);
}

/**
 * Kesimpulan yang bisa langsung dipakai agent: apa yang salah dan apa yang harus
 * diperbaiki. Sengaja tegas — "halaman terbuka" tidak sama dengan "halaman benar".
 */
export type BrowserVerdict = {
  ok: boolean;
  problems: string[];
  notes: string[];
};

export function judgeReport(report: BrowserReport, options: { expectOverflowCheck?: boolean } = {}): BrowserVerdict {
  const problems: string[] = [];
  const notes: string[] = [];

  if (report.error) problems.push(`Browser gagal menjalankan pemeriksaan: ${report.error}`);
  if (report.status === null) problems.push('Halaman tidak bisa dibuka sama sekali dari dalam sandbox.');
  else if (report.status >= 400) problems.push(`Halaman menjawab HTTP ${report.status} (seharusnya 200).`);
  if (report.pageErrors.length) problems.push(`${report.pageErrors.length} error JavaScript yang menghentikan halaman: ${report.pageErrors[0]}`);
  if (report.consoleErrors.length) problems.push(`${report.consoleErrors.length} error di console browser: ${report.consoleErrors[0].text}`);
  if (report.httpErrors.length) problems.push(`${report.httpErrors.length} request gagal (mis. ${report.httpErrors[0].status} ${report.httpErrors[0].url}).`);
  if (report.failedRequests.length) notes.push(`${report.failedRequests.length} request tidak terkirim (bisa normal untuk endpoint opsional).`);
  if (report.brokenImages > 0) problems.push(`${report.brokenImages} gambar gagal dimuat (ikon/tautan rusak).`);
  if (options.expectOverflowCheck !== false && report.horizontalOverflow) {
    problems.push(
      `Ada scroll horizontal di lebar ${report.viewport.width}px (kelebihan ${report.overflowPx}px, ${report.overflowingElements} elemen lebih lebar dari viewport) — layout bocor.`,
    );
  }
  if (report.textLength < 200) problems.push(`Halaman hampir kosong (hanya ${report.textLength} karakter teks terlihat) — kemungkinan gagal render.`);
  if (!report.screenshot) notes.push('Screenshot tidak berhasil dibuat.');

  if (!problems.length) {
    notes.push(`Halaman terbuka normal (HTTP ${report.status}), tanpa error JS, tanpa request gagal, dan tanpa scroll horizontal.`);
  }
  return { ok: problems.length === 0, problems, notes };
}

/** Ringkasan untuk model: padat, terstruktur, tanpa data mentah yang tak perlu. */
export function summarizeBrowserReport(report: BrowserReport, verdict: BrowserVerdict, extra?: { viewportName?: string }): string {
  const lines: string[] = [];
  lines.push(`url: ${report.url}`);
  lines.push(`viewport: ${report.viewport.width}x${report.viewport.height}${extra?.viewportName ? ` (${extra.viewportName})` : ''}`);
  lines.push(`http_status: ${report.status ?? 'tidak ada respons'}`);
  lines.push(`judul: ${report.title || '(kosong)'}`);
  lines.push(`h1: ${report.h1 || '(tidak ada h1)'}`);
  lines.push(`teks_terlihat: ${report.textLength} karakter`);
  lines.push(`waktu_muat: ${report.loadMs} ms`);
  lines.push(`scroll_horizontal: ${report.horizontalOverflow ? `ADA (+${report.overflowPx}px, ${report.overflowingElements} elemen)` : 'tidak ada'}`);
  lines.push(`gambar_rusak: ${report.brokenImages}`);
  lines.push(`status: ${verdict.ok ? 'BAIK - tidak ada masalah terdeteksi' : 'ADA MASALAH - perbaiki dulu sebelum bilang selesai'}`);

  if (verdict.problems.length) {
    lines.push('masalah:');
    for (const problem of verdict.problems) lines.push(`  - ${problem}`);
  }
  if (verdict.notes.length) {
    lines.push('catatan:');
    for (const note of verdict.notes) lines.push(`  - ${note}`);
  }
  if (report.consoleErrors.length > 1) {
    lines.push('error_console_lain:');
    for (const entry of report.consoleErrors.slice(1, 6)) lines.push(`  - ${entry.text}`);
  }
  if (report.pageErrors.length > 1) {
    lines.push('error_js_lain:');
    for (const entry of report.pageErrors.slice(1, 5)) lines.push(`  - ${entry}`);
  }
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Script yang dijalankan di dalam sandbox                                     */
/* -------------------------------------------------------------------------- */

/**
 * Skrip Node yang ditulis ke sandbox lalu dijalankan.
 * Playwright di-resolve dari folder instalasi kita, dengan fallback ke resolusi
 * biasa (kalau proyek user sudah punya Playwright sendiri).
 */
export function browserScript(options: { screenshotPath?: string } = {}): string {
  const shot = options.screenshotPath ?? BROWSER_SHOT_PATH;
  return `// Dibuat otomatis oleh AgentCloud - pemeriksaan UI dengan browser sungguhan.
const MARKER = '${REPORT_MARKER}';
const SHOT = process.env.AC_SHOT || ${JSON.stringify(shot)};
const URL_TARGET = process.env.AC_URL || 'http://127.0.0.1:3000/';
const WIDTH = Number(process.env.AC_WIDTH || 1440);
const HEIGHT = Number(process.env.AC_HEIGHT || 900);
const FULL_PAGE = process.env.AC_FULL === '1';
const SETTLE_MS = Number(process.env.AC_SETTLE || 1200);
const TIMEOUT_MS = Number(process.env.AC_TIMEOUT || 30000);

function emit(payload) {
  // Satu baris JSON setelah penanda supaya log lain tidak merusak parsing.
  process.stdout.write('\\n' + MARKER + JSON.stringify(payload) + '\\n');
}

async function loadPlaywright() {
  const candidates = [
    process.env.AC_PLAYWRIGHT,
    'playwright',
    '${BROWSER_DIR}/node_modules/playwright/index.mjs',
  ].filter(Boolean);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error('Playwright tidak bisa dimuat: ' + (lastError && lastError.message ? lastError.message : 'unknown'));
}

const report = {
  url: URL_TARGET,
  viewport: { width: WIDTH, height: HEIGHT },
  status: null,
  title: '',
  h1: '',
  textLength: 0,
  loadMs: 0,
  screenshot: false,
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

let browser = null;
try {
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({
    // Flag wajib agar Chromium jalan di container (E2B) tanpa sandbox kernel.
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const page = await context.newPage();

  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (type === 'error') report.consoleErrors.push({ type, text });
    else if (type === 'warning') report.consoleWarnings.push({ type, text });
  });
  page.on('pageerror', (err) => report.pageErrors.push(err && err.message ? err.message : String(err)));
  page.on('requestfailed', (req) => {
    const failure = req.failure();
    report.failedRequests.push({ url: req.url(), error: failure ? failure.errorText : 'unknown' });
  });
  page.on('response', (res) => {
    const status = res.status();
    const url = res.url();
    if (status >= 400 && !/favicon/i.test(url)) report.httpErrors.push({ url, status });
  });

  const started = Date.now();
  const response = await page.goto(URL_TARGET, { waitUntil: 'load', timeout: TIMEOUT_MS });
  report.status = response ? response.status() : null;
  // Beri waktu framework dev menyelesaikan render sisi klien.
  await page.waitForTimeout(SETTLE_MS);
  report.loadMs = Date.now() - started;

  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const viewportWidth = window.innerWidth;
    const overflowPx = Math.max(0, doc.scrollWidth - viewportWidth);
    let overflowingElements = 0;
    let brokenImages = 0;
    for (const el of Array.from(document.body ? document.body.querySelectorAll('*') : [])) {
      const rect = el.getBoundingClientRect();
      if (rect.width > viewportWidth + 1) overflowingElements += 1;
    }
    for (const img of Array.from(document.images || [])) {
      if (img.complete && img.naturalWidth === 0) brokenImages += 1;
    }
    const heading = document.querySelector('h1');
    return {
      title: document.title || '',
      h1: heading ? (heading.textContent || '').trim().slice(0, 200) : '',
      textLength: (document.body ? document.body.innerText || '' : '').replace(/\\s+/g, ' ').trim().length,
      horizontalOverflow: overflowPx > 1,
      overflowPx,
      overflowingElements,
      brokenImages,
    };
  });
  Object.assign(report, metrics);

  try {
    await page.screenshot({ path: SHOT, type: 'jpeg', quality: 72, fullPage: FULL_PAGE });
    report.screenshot = true;
  } catch (shotError) {
    report.screenshot = false;
    report.shotError = shotError && shotError.message ? shotError.message : String(shotError);
  }

  await context.close();
} catch (err) {
  report.error = err && err.message ? err.message : String(err);
} finally {
  if (browser) { try { await browser.close(); } catch {} }
}

emit(report);
process.exit(report.error && report.status === null ? 1 : 0);
`;
}
