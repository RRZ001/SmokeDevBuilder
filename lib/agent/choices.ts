/**
 * Blok PILIHAN yang bisa diklik user di chat.
 *
 * Kenapa ada: sebelumnya chat hanya punya input teks bebas — agent bisa
 * "bertanya" tetapi user tetap harus mengetik jawabannya, dan karena aturan
 * prompt berbunyi "kalau wajar, pilih default terbaik lalu lanjut", agent hampir
 * tidak pernah bertanya soal desain/fitur. User meminta perilaku seperti
 * VibeCoder: agent menawarkan opsi konkret yang tinggal diklik.
 *
 * Format yang dipakai agent (dipisah dari teks supaya bisa di-strip):
 *
 *     :::choices
 *     Q: Desain seperti apa?
 *     - Bold & colorful ala startup SaaS
 *     - Minimalis bersih ala Linear
 *     :::
 *
 * Semua fungsi di sini MURNI (tanpa I/O) supaya bisa diuji tanpa kredit E2B.
 * Parsing/filter-nya memakai mesin bersama di ./marker-block (dipakai juga oleh
 * blok rencana `:::plan`).
 */

import {
  createMarkerStreamFilter,
  isBulletLine,
  splitMarkedBlocks,
  type MarkerPair,
} from './marker-block';

export type ChoiceQuestion = { question: string; options: string[] };

export const CHOICES_OPEN = ':::choices';
export const CHOICES_CLOSE = ':::';
/** Varian fenced ```choices juga diterima supaya agent tidak mudah salah format. */
const FENCED_OPEN = '```choices';
const FENCED_CLOSE = '```';

/** Pasangan penanda yang dikenali (dipakai parser & filter streaming). */
export const CHOICE_MARKERS: MarkerPair[] = [
  { open: CHOICES_OPEN, close: CHOICES_CLOSE },
  { open: FENCED_OPEN, close: FENCED_CLOSE },
];

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_QUESTION_CHARS = 200;
const MAX_OPTION_CHARS = 90;

export const CHOICE_FORMAT_RULE = `# Menawarkan pilihan (blok \`:::choices\`)
Kalau — dan hanya kalau — permintaan user KURANG DETAIL untuk dikerjakan dengan hasil yang tepat (mis. "buatkan aplikasi kasir" tanpa info gaya/stack/fitur, atau "perbaiki tampilannya" tanpa arah), tawarkan pilihan konkret dengan format PERSIS ini di AKHIR jawabanmu:

${CHOICES_OPEN}
Q: <pertanyaan singkat>
- <opsi 1>
- <opsi 2>
Q: <pertanyaan kedua, opsional>
- <opsi 1>
- <opsi 2>
${CHOICES_CLOSE}

Aturan:
- Maksimal 3 pertanyaan, masing-masing 2–4 opsi. Opsi harus SINGKAT (≤ 90 karakter) dan konkret — tulis hal yang benar-benar akan kamu bangun, bukan "Opsi A"/"Lainnya".
- Sertakan satu opsi bergaya "Terserah, kamu putuskan" bila ada keputusan yang mungkin tidak ingin dipikirkan user.
- Tulis satu kalimat pengantar singkat SEBELUM blok, dan JANGAN menulis apa pun setelah blok penutup.
- **Kalau kamu memakai blok ini, JANGAN memanggil tool apa pun di giliran yang sama**: berhenti dan tunggu jawaban user (sistem memang akan menghentikan langkahmu di situ). Bekerjalah setelah user memilih.
- Blok ini hanya untuk hal yang benar-benar mengubah hasil. JANGAN memakainya untuk basa-basi, konfirmasi sepele, atau saat user sudah spesifik (kalau instruksinya sudah jelas, langsung kerjakan).
- Cukup satu blok per giliran. Kalau user memilih salah satu opsi, lanjutkan pekerjaan memakai pilihan itu tanpa bertanya lagi hal yang sama.
- Jangan pernah menaruh kode atau penjelasan panjang di dalam blok pilihan.`;

function isQuestionLine(line: string): boolean {
  return /^\s*(q|pertanyaan)\s*[:.)]\s*\S/i.test(line);
}

function cleanOption(line: string): string {
  return line.replace(/^\s*[-*•]\s+/, '').replace(/\s+/g, ' ').trim().slice(0, MAX_OPTION_CHARS);
}

function cleanQuestion(line: string): string {
  return line.replace(/^\s*(q|pertanyaan)\s*[:.)]\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION_CHARS);
}

/** Parse isi satu blok pilihan. Mengembalikan [] bila isinya tidak sah. */
export function parseChoiceBody(body: string): ChoiceQuestion[] {
  const questions: ChoiceQuestion[] = [];
  let current: ChoiceQuestion | null = null;

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (isQuestionLine(line)) {
      if (current && current.options.length >= MIN_OPTIONS) questions.push(current);
      const question = cleanQuestion(line);
      current = question ? { question, options: [] } : null;
      continue;
    }
    if (isBulletLine(line)) {
      if (!current) continue;
      if (current.options.length >= MAX_OPTIONS) continue;
      const option = cleanOption(line);
      if (option) current.options.push(option);
      continue;
    }
    // Baris bebas di dalam blok (mis. penjelasan) diabaikan.
  }
  if (current && current.options.length >= MIN_OPTIONS) questions.push(current);

  return questions
    .filter((q) => q.question && q.options.length >= MIN_OPTIONS)
    .map((q) => ({ ...q, options: [...new Set(q.options)] }));
}

/**
 * Pisahkan blok pilihan dari teks jawaban.
 *
 * Blok yang tidak valid (mis. kurang opsi) DIBIARKAN di dalam teks supaya isi
 * jawaban agent tidak hilang karena kesalahan format.
 */
export function parseChoices(text: string): { cleaned: string; questions: ChoiceQuestion[] } {
  const { cleaned, items } = splitMarkedBlocks(text, CHOICE_MARKERS, parseChoiceBody);
  return { cleaned, questions: items.slice(0, MAX_QUESTIONS) };
}

/**
 * Filter streaming: tahan bagian teks yang mungkin bagian dari blok pilihan,
 * supaya markup `:::choices` tidak sempat terlihat berkedip di UI lalu hilang.
 *
 * Catatan: loop agent memakai satu filter gabungan (pilihan + rencana) supaya
 * kedua penanda tidak saling menahan ekor buffer.
 */
export function createChoiceStreamFilter(): { push: (chunk: string) => string; flush: () => string } {
  return createMarkerStreamFilter(CHOICE_MARKERS);
}
