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
 */

export type ChoiceQuestion = { question: string; options: string[] };

export const CHOICES_OPEN = ':::choices';
export const CHOICES_CLOSE = ':::';
/** Varian fenced ```choices juga diterima supaya agent tidak mudah salah format. */
const FENCED_OPEN = '```choices';
const FENCED_CLOSE = '```';

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
- Blok ini hanya untuk hal yang benar-benar mengubah hasil. JANGAN memakainya untuk basa-basi, konfirmasi sepele, atau saat user sudah spesifik (kalau instruksinya sudah jelas, langsung kerjakan).
- Cukup satu blok per giliran. Kalau user memilih salah satu opsi, lanjutkan pekerjaan memakai pilihan itu tanpa bertanya lagi hal yang sama.
- Jangan pernah menaruh kode atau penjelasan panjang di dalam blok pilihan.`;

function isOptionLine(line: string): boolean {
  return /^\s*[-*•]\s+\S/.test(line);
}

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
    if (isOptionLine(line)) {
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
    .slice(0, MAX_QUESTIONS)
    .map((q) => ({ question: q.question, options: [...new Set(q.options)] }));
}

type Segment = { start: number; end: number; body: string; open: string; close: string };

/** Cari semua blok pilihan (baik `:::choices` maupun fenced) yang sudah lengkap. */
function findSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let index = 0;
  while (index < text.length) {
    const colon = text.indexOf(CHOICES_OPEN, index);
    const fenced = text.indexOf(FENCED_OPEN, index);
    let start = -1;
    let open = CHOICES_OPEN;
    let close = CHOICES_CLOSE;
    if (colon !== -1 && (fenced === -1 || colon <= fenced)) {
      start = colon;
    } else if (fenced !== -1) {
      start = fenced;
      open = FENCED_OPEN;
      close = FENCED_CLOSE;
    }
    if (start === -1) break;
    const closeAt = text.indexOf(close, start + open.length);
    if (closeAt === -1) break;
    segments.push({
      start,
      end: closeAt + close.length,
      body: text.slice(start + open.length, closeAt),
      open,
      close,
    });
    index = closeAt + close.length;
  }
  return segments;
}

/**
 * Pisahkan blok pilihan dari teks jawaban.
 *
 * Blok yang tidak valid (mis. kurang opsi) DIBIARKAN di dalam teks supaya isi
 * jawaban agent tidak hilang karena kesalahan format.
 */
export function parseChoices(text: string): { cleaned: string; questions: ChoiceQuestion[] } {
  const segments = findSegments(text);
  if (!segments.length) return { cleaned: text, questions: [] };

  let cleaned = '';
  let cursor = 0;
  const questions: ChoiceQuestion[] = [];

  for (const segment of segments) {
    const parsed = parseChoiceBody(segment.body);
    if (!parsed.length) continue; // biarkan sebagai teks
    cleaned += text.slice(cursor, segment.start);
    cursor = segment.end;
    for (const question of parsed) {
      if (questions.length < MAX_QUESTIONS) questions.push(question);
    }
  }

  if (!questions.length) return { cleaned: text, questions: [] };
  cleaned += text.slice(cursor);
  return { cleaned: tidy(cleaned), questions };
}

function tidy(text: string): string {
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Filter streaming: tahan bagian teks yang mungkin bagian dari blok pilihan,
 * supaya markup `:::choices` tidak sempat terlihat berkedip di UI lalu hilang.
 *
 * Cara pakai: `push(chunk)` untuk setiap delta dari model (pakai hasilnya
 * sebagai teks yang ditampilkan), lalu `flush()` di akhir stream.
 */
export function createChoiceStreamFilter(): { push: (chunk: string) => string; flush: () => string } {
  let buffer = '';

  const drain = (final: boolean): string => {
    let out = '';
    for (;;) {
      const colon = buffer.indexOf(CHOICES_OPEN);
      const fenced = buffer.indexOf(FENCED_OPEN);
      let start = -1;
      let open = CHOICES_OPEN;
      let close = CHOICES_CLOSE;
      if (colon !== -1 && (fenced === -1 || colon <= fenced)) start = colon;
      else if (fenced !== -1) {
        start = fenced;
        open = FENCED_OPEN;
        close = FENCED_CLOSE;
      }

      if (start === -1) {
        // Tidak ada pembuka: tahan ekor yang bisa jadi awal penanda.
        const hold = final ? 0 : pendingMarkerLength(buffer);
        out += buffer.slice(0, buffer.length - hold);
        buffer = buffer.slice(buffer.length - hold);
        break;
      }

      out += buffer.slice(0, start);
      const closeAt = buffer.indexOf(close, start + open.length);
      if (closeAt === -1) {
        if (final) {
          // Blok tidak pernah ditutup: tampilkan apa adanya (degradasi wajar),
          // isinya tetap muncul sebagai teks biasa.
          out += buffer.slice(start);
          buffer = '';
        } else {
          buffer = buffer.slice(start);
        }
        break;
      }
      // Blok lengkap: jangan tampilkan isinya, lanjut memeriksa sisa teks.
      buffer = buffer.slice(closeAt + close.length);
    }
    return out;
  };

  return {
    push: (chunk: string) => {
      buffer += chunk ?? '';
      return drain(false);
    },
    flush: () => drain(true),
  };
}

/** Panjang ekor buffer yang masih bisa menjadi awal penanda pembuka. */
function pendingMarkerLength(buffer: string): number {
  for (const marker of [CHOICES_OPEN, FENCED_OPEN]) {
    const max = Math.min(marker.length - 1, buffer.length);
    for (let k = max; k > 0; k -= 1) {
      if (buffer.endsWith(marker.slice(0, k))) return k;
    }
  }
  return 0;
}
