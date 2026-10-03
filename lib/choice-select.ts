import type { ChoiceQuestion } from '@/lib/db/types';

/**
 * Cocokkan teks pesan user dengan salah satu opsi pada blok pilihan.
 *
 * Dipakai UI untuk menandai pilihan yang sudah diklik (dan menonaktifkan tombol
 * lainnya) TANPA menulis ulang blok di database: statusnya diturunkan dari pesan
 * user berikutnya. Modul ini sengaja terpisah dari `lib/agent/choices.ts` agar
 * aturan prompt (yang hanya untuk server) tidak ikut ke bundle klien.
 */
export function matchChosenOption(text: string, questions: ChoiceQuestion[] | undefined): string | null {
  if (!text || !questions?.length) return null;
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;:]+$/g, '').trim();
  const target = normalize(text);
  for (const question of questions) {
    for (const option of question.options) {
      if (normalize(option) === target) return option;
    }
  }
  return null;
}
