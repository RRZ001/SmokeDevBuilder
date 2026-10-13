/**
 * Mesin bersama untuk memisahkan "blok penanda" dari jawaban model.
 *
 * Penanda yang dipakai agent saat ini: `:::choices` (pertanyaan yang bisa
 * diklik) dan `:::plan` (daftar rencana yang dicentang). Keduanya punya bentuk
 * yang sama — pembuka, isi baris-per-baris, penutup — jadi parser dan FILTER
 * STREAMING-nya dibuat satu kali di sini supaya perilakunya konsisten (dan tidak
 * ada dua filter berbeda yang saling menahan ekor buffer saat streaming).
 *
 * Kenapa filter streaming ada (bukan hanya parser): potongan teks dari model
 * datang per delta, sehingga penanda bisa tiba terpecah antar-chunk. Tanpa
 * menahan ekor buffer, markup `:::plan` sempat terlihat berkedip di UI lalu
 * hilang beberapa ratus milidetik kemudian.
 *
 * Semua fungsi di sini MURNI (tanpa I/O) supaya bisa diuji tanpa kredit E2B.
 */

export type MarkerPair = { open: string; close: string };
export type MarkerSegment = { start: number; end: number; body: string; open: string; close: string };

/**
 * Cari semua blok penanda yang SUDAH LENGKAP (pembuka + penutup).
 * Blok yang belum ditutup tidak dikembalikan (pemanggil yang memutuskan).
 */
export function findMarkerSegments(text: string, pairs: MarkerPair[]): MarkerSegment[] {
  const segments: MarkerSegment[] = [];
  let index = 0;

  while (index < text.length) {
    let start = -1;
    let pair: MarkerPair | null = null;
    for (const candidate of pairs) {
      const at = text.indexOf(candidate.open, index);
      if (at === -1) continue;
      if (start === -1 || at < start) {
        start = at;
        pair = candidate;
      }
    }
    if (start === -1 || !pair) break;

    const closeAt = text.indexOf(pair.close, start + pair.open.length);
    if (closeAt === -1) break;

    segments.push({
      start,
      end: closeAt + pair.close.length,
      body: text.slice(start + pair.open.length, closeAt),
      open: pair.open,
      close: pair.close,
    });
    index = closeAt + pair.close.length;
  }

  return segments;
}

/** Rapikan sisa teks setelah blok dibuang (baris kosong beruntun, spasi ekor). */
export function tidyText(text: string): string {
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Pisahkan blok penanda dari teks jawaban.
 *
 * Blok yang isinya TIDAK SAH (parseBody mengembalikan []) dibiarkan apa adanya di
 * dalam teks — kesalahan format tidak boleh membuat isi jawaban agent hilang.
 */
export function splitMarkedBlocks<T>(
  text: string,
  pairs: MarkerPair[],
  parseBody: (body: string) => T[],
): { cleaned: string; items: T[] } {
  const segments = findMarkerSegments(text, pairs);
  if (!segments.length) return { cleaned: text, items: [] };

  let cleaned = '';
  let cursor = 0;
  const items: T[] = [];

  for (const segment of segments) {
    const parsed = parseBody(segment.body);
    if (!parsed.length) continue; // biarkan sebagai teks
    cleaned += text.slice(cursor, segment.start);
    cursor = segment.end;
    items.push(...parsed);
  }

  if (!items.length) return { cleaned: text, items: [] };
  cleaned += text.slice(cursor);
  return { cleaned: tidyText(cleaned), items };
}

/** Panjang ekor buffer yang masih bisa menjadi awal salah satu penanda pembuka. */
export function pendingMarkerLength(buffer: string, pairs: MarkerPair[]): number {
  let longest = 0;
  for (const { open } of pairs) {
    const max = Math.min(open.length - 1, buffer.length);
    for (let k = max; k > 0; k -= 1) {
      if (buffer.endsWith(open.slice(0, k))) {
        longest = Math.max(longest, k);
        break;
      }
    }
  }
  return longest;
}

/**
 * Filter streaming: tahan bagian teks yang mungkin bagian dari blok penanda.
 *
 * Cara pakai: `push(chunk)` untuk setiap delta dari model (pakai hasilnya sebagai
 * teks yang ditampilkan), lalu `flush()` di akhir stream.
 */
export function createMarkerStreamFilter(pairs: MarkerPair[]): { push: (chunk: string) => string; flush: () => string } {
  let buffer = '';

  const drain = (final: boolean): string => {
    let out = '';
    for (;;) {
      let start = -1;
      let pair: MarkerPair | null = null;
      for (const candidate of pairs) {
        const at = buffer.indexOf(candidate.open);
        if (at === -1) continue;
        if (start === -1 || at < start) {
          start = at;
          pair = candidate;
        }
      }

      if (start === -1 || !pair) {
        // Tidak ada pembuka: tahan ekor yang bisa jadi awal penanda.
        const hold = final ? 0 : pendingMarkerLength(buffer, pairs);
        out += buffer.slice(0, buffer.length - hold);
        buffer = buffer.slice(buffer.length - hold);
        break;
      }

      out += buffer.slice(0, start);
      const closeAt = buffer.indexOf(pair.close, start + pair.open.length);
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
      buffer = buffer.slice(closeAt + pair.close.length);
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

/** Baris "- sesuatu" atau "* sesuatu" (opsi pilihan, butir rencana). */
export function isBulletLine(line: string): boolean {
  return /^\s*[-*•]\s+\S/.test(line);
}
