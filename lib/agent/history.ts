import { HISTORY_CHAR_BUDGET, HISTORY_MESSAGES, HISTORY_TOOL_DETAILS, HISTORY_TOOL_OUTPUT_CHARS } from '@/lib/config';
import type { Block, Message } from '@/lib/db/types';
import { truncate } from '@/lib/util';
import type { ChatMsg, OpenRouterToolCall } from './openrouter';

/**
 * Rekonstruksi riwayat model dari blok UI yang disimpan di kolom `parts`.
 *
 * **Penghematan biaya (penyebab prompt membengkak nomor satu).**
 * Argumen `write_file` memuat ISI FILE LENGKAP, dan dalam loop function calling
 * argumen itu wajib dikirim ulang di setiap langkah berikutnya. Untuk proyek
 * dengan 10 file, puluhan ribu token terkirim berulang tanpa manfaat: model tidak
 * perlu membaca ulang isi file yang sudah ada di sandbox — ia bisa memanggil
 * `read_file` bila benar-benar butuh.
 *
 * Aturan (deterministik, supaya prefix prompt stabil dan prompt caching tetap
 * efektif — prefix yang berubah-ubah setiap request akan selalu cache-miss):
 *  1. Hanya `HISTORY_TOOL_DETAILS` pemanggilan tool TERAKHIR yang dikirim utuh.
 *  2. Argumen `write_file` yang lebih lama: isi diganti penanda ukuran.
 *  3. Hasil tool yang lebih lama: dipotong `HISTORY_TOOL_OUTPUT_CHARS`.
 *  4. Bila total masih melebihi `HISTORY_CHAR_BUDGET`, kompaksi diperketat
 *     bertahap (jumlah tool detail diturunkan) sampai masuk anggaran.
 */
export function buildHistory(messages: Message[], limit = HISTORY_MESSAGES): ChatMsg[] {
  const window = messages.slice(-limit);

  for (const keep of buildKeepPlan(HISTORY_TOOL_DETAILS)) {
    const rendered = renderWindow(window, keep);
    if (measure(rendered) <= HISTORY_CHAR_BUDGET) return rendered;
  }

  // Anggaran tetap terlampaui (percakapan sangat besar): kembalikan versi
  // paling ringkas yang bisa dibuat, masih dengan struktur tool yang valid.
  return renderWindow(window, 0, true);
}

/** Urutan pengetatan: mulai dari setelan normal, lalu turun bertahap. */
function buildKeepPlan(initial: number): number[] {
  const plan = [initial, Math.min(initial, 2), 0];
  return [...new Set(plan)].filter((value) => value >= 0);
}

function renderWindow(window: Message[], keepToolDetails: number, minimalOutput = false): ChatMsg[] {
  const detailed = lastToolCallIds(window, keepToolDetails);
  const out: ChatMsg[] = [];

  for (const message of window) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
      continue;
    }
    if (message.role === 'system') {
      out.push({ role: 'system', content: message.content });
      continue;
    }

    const blocks: Block[] = message.parts ?? [{ type: 'text', text: message.content }];
    const toolCalls: OpenRouterToolCall[] = [];
    const toolReplies: ChatMsg[] = [];
    let text = '';

    for (const block of blocks) {
      if (block.type === 'text') {
        text += block.text;
        continue;
      }
      // Reasoning, notice, dan ringkasan pemakaian token tidak dikirim balik.
      if (block.type !== 'tool') continue;

      const isDetailed = detailed.has(block.id);
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(isDetailed ? (block.args ?? {}) : compactArgs(block)),
        },
      });
      toolReplies.push({
        role: 'tool',
        tool_call_id: block.id,
        name: block.name,
        content: isDetailed && !minimalOutput
          ? truncate((block.output ?? '').trim() || (block.status === 'error' ? 'gagal' : 'ok'), 1_500)
          : truncate(humanResult(block), HISTORY_TOOL_OUTPUT_CHARS),
      });
    }

    if (!text && !toolCalls.length) continue;

    out.push({
      role: 'assistant',
      content: text || message.content || '',
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
    out.push(...toolReplies);
  }

  return out;
}

/** Id tool call yang isinya boleh dikirim utuh (N terakhir, urut dari belakang). */
function lastToolCallIds(window: Message[], keep: number): Set<string> {
  if (keep <= 0) return new Set();
  const ids: string[] = [];
  for (let i = window.length - 1; i >= 0 && ids.length < keep; i -= 1) {
    const blocks = window[i].parts ?? [];
    const toolBlocks = blocks.filter((b): b is Extract<Block, { type: 'tool' }> => b.type === 'tool');
    for (let j = toolBlocks.length - 1; j >= 0 && ids.length < keep; j -= 1) {
      ids.push(toolBlocks[j].id);
    }
  }
  return new Set(ids);
}

/** Ganti argumen besar (isi file) dengan ringkasan ukuran. */
function compactArgs(block: Extract<Block, { type: 'tool' }>): Record<string, unknown> {
  const args = block.args ?? {};
  if (block.name !== 'write_file') return args;

  const content = typeof args.content === 'string' ? args.content : '';
  return {
    path: args.path,
    content: `[isi file ${content.length} karakter tidak dikirim ulang - sudah ada di sandbox; gunakan read_file bila perlu]`,
  };
}

/** Ringkasan hasil tool untuk pesan lama (mis. "File x.js tersimpan (2,1 KB)"). */
function humanResult(block: Extract<Block, { type: 'tool' }>): string {
  const output = (block.output ?? '').trim();
  if (!output) return block.status === 'error' ? 'gagal' : 'ok';
  return output.split('\n').slice(0, 4).join('\n');
}

function measure(messages: ChatMsg[]): number {
  return JSON.stringify(messages).length;
}
