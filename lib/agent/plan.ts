/**
 * Blok RENCANA (`:::plan`) — daftar langkah yang terlihat user dan dicentang
 * seiring pekerjaan berjalan.
 *
 * Kenapa ada: sebelumnya agent hanya "berencana" di dalam teks bebas, sehingga
 * user tidak bisa melihat progres pekerjaan tanpa membaca ulang seluruh chat —
 * terasa kaku dibanding VibeCoder yang menampilkan daftar tugas. Dengan blok ini
 * rencana jadi daftar yang bisa dicentang, dan agent mengirim ulang blok yang
 * sama dengan `[x]` pada langkah yang sudah selesai.
 *
 * Format:
 *
 *     :::plan
 *     - Periksa struktur proyek yang ada
 *     - Tulis halaman + style
 *     - Jalankan server & cek tampilan dengan browser_check
 *     :::
 *
 * Semua fungsi di sini MURNI (tanpa I/O) supaya bisa diuji tanpa kredit E2B.
 */

import {
  createMarkerStreamFilter,
  isBulletLine,
  splitMarkedBlocks,
  type MarkerPair,
} from './marker-block';

export type PlanItem = { text: string; done: boolean };

export const PLAN_OPEN = ':::plan';
export const PLAN_CLOSE = ':::';
const FENCED_OPEN = '```plan';
const FENCED_CLOSE = '```';

export const PLAN_MARKERS: MarkerPair[] = [
  { open: PLAN_OPEN, close: PLAN_CLOSE },
  { open: FENCED_OPEN, close: FENCED_CLOSE },
];

const MAX_ITEMS = 12;
const MAX_ITEM_CHARS = 120;
/** Satu giliran tidak perlu menampilkan lebih dari ini (sisanya tetap teks). */
const MAX_PLANS = 2;

export const PLAN_FORMAT_RULE = `# Menuliskan rencana (blok \`:::plan\`)
Untuk tugas yang butuh LEBIH DARI SATU langkah nyata (membangun/memperbaiki aplikasi, refactor, debug berantai), tulis rencana singkat di AWAL pekerjaan dengan format PERSIS ini:

${PLAN_OPEN}
- <langkah 1>
- <langkah 2>
- <langkah 3>
${PLAN_CLOSE}

Aturan:
- 3–6 langkah, masing-masing ≤ 120 karakter, diawali kata kerja, dan sebutkan hasil yang bisa diperiksa (mis. "jalankan server & cek tampilan dengan browser_check"), bukan niat kabur seperti "membuat kode bagus".
- Untuk memperbarui: kirim blok \`:::plan\` lagi dengan \`[x]\` pada langkah yang sudah selesai (tambahkan langkah baru bila rencananya memang berubah). Jangan mengirim ulang blok yang isinya tidak berubah — cukup tulis prose singkat.
- Blok rencana TIDAK menggantikan penjelasan: tetap tulis temuan/hasil singkat di teks biasa.
- Kalau tugasnya sepele (satu file, satu perintah), JANGAN memakai blok ini.`;

function cleanItem(line: string): string {
  return line
    .replace(/^\s*\d+[.)]\s*/, '')
    .replace(/^\s*[-*•]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ITEM_CHARS);
}

function isChecked(line: string): boolean {
  const box = line.match(/^\s*[-*•]\s*\[([ xX])\]/);
  return Boolean(box && box[1].toLowerCase() === 'x');
}

/**
 * Parse isi satu blok rencana.
 *
 * Baris non-bullet tetap diterima sebagai langkah (tanpa centang) supaya format
 * yang sedikit meleset tidak membuat markup `:::plan` bocor ke layar.
 */
export function parsePlanBody(body: string): PlanItem[] {
  const items: PlanItem[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Baris pembatas/section (mis. "##") diabaikan.
    if (/^[#>|]+$/.test(line)) continue;
    const bullet = isBulletLine(line) || /^\d+[.)]\s+\S/.test(line);
    const text = cleanItem(line);
    if (text) items.push({ text, done: bullet ? isChecked(line) : false });
    if (items.length >= MAX_ITEMS) break;
  }
  return items.slice(0, MAX_ITEMS);
}

/**
 * Pisahkan semua blok rencana dari teks jawaban.
 * Blok kosong/tidak sah dibiarkan sebagai teks (prinsip yang sama dengan blok pilihan).
 */
export function parsePlans(text: string): { cleaned: string; plans: PlanItem[][] } {
  // Satu blok = satu grup langkah (bukan digabung), jadi parseBody membungkus
  // hasilnya dalam satu elemen.
  const { cleaned, items } = splitMarkedBlocks<PlanItem[]>(text, PLAN_MARKERS, (body) => {
    const steps = parsePlanBody(body);
    return steps.length ? [steps] : [];
  });
  return { cleaned, plans: items.slice(0, MAX_PLANS) };
}

/** Filter streaming untuk blok rencana (lihat ./marker-block). */
export function createPlanStreamFilter(): { push: (chunk: string) => string; flush: () => string } {
  return createMarkerStreamFilter(PLAN_MARKERS);
}
