import type { Block, Message } from '@/lib/db/types';
import type { ChatMsg, OpenRouterToolCall } from './openrouter';

/**
 * Rekonstruksi riwayat model dari blok UI yang disimpan di kolom `parts`.
 *
 * Urutan blok dipertahankan: blok `text` menjadi isi assistant message,
 * blok `tool` menjadi `tool_calls` + pesan `tool` balasannya. Ini membuat
 * percakapan multi-turn (termasuk tool call) tetap valid untuk model.
 */
export function buildHistory(messages: Message[], limit = 24): ChatMsg[] {
  const recent = messages.slice(-limit);
  const out: ChatMsg[] = [];

  for (const message of recent) {
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
      } else if (block.type === 'reasoning') {
        // Reasoning tidak dikirim balik supaya konteks tidak membengkak.
        continue;
      } else if (block.type === 'tool') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.args ?? {}) },
        });
        toolReplies.push({
          role: 'tool',
          tool_call_id: block.id,
          name: block.name,
          content: (block.output ?? '').trim() || (block.status === 'error' ? 'gagal' : 'ok'),
        });
      }
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
