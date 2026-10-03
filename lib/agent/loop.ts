import { MAX_AGENT_STEPS, MAX_AUTO_DEBUG_ROUNDS, MAX_OUTPUT_TOKENS, TOOL_OUTPUT_CHARS } from '@/lib/config';
import type { Block, ChoicesBlock, TextBlock, ToolBlock, UsageBlock } from '@/lib/db/types';
import { truncate } from '@/lib/util';
import { TOOL_DEFINITIONS, executeTool, type ToolContext, type ToolResult } from '@/lib/sandbox/tools';
import { createChoiceStreamFilter, parseChoices } from './choices';
import { autoDebugNudge, buildSystemPrompt, stepBudgetNotice, type AgentMode } from './prompt';
import { OpenRouterError, streamChat, type ChatMsg, type UsageInfo } from './openrouter';

export type AgentEvent =
  | { type: 'status'; message: string }
  | { type: 'retry'; attempt: number; maxAttempts: number; waitMs: number; reason: string }
  | { type: 'text'; value: string }
  | { type: 'reasoning'; value: string }
  | { type: 'choices'; questions: import('@/lib/db/types').ChoiceQuestion[] }
  | { type: 'tool_start'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_output'; id: string; value: string }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; output: string; previewUrl?: string }
  | { type: 'preview'; url: string; port: number }
  | { type: 'usage'; value: UsageInfo }
  | { type: 'error'; message: string }
  | { type: 'done'; blocks: Block[]; content: string; finishReason?: string };

export type RunAgentOptions = {
  apiKey: string;
  model: string;
  history: ChatMsg[];
  userText: string;
  /** Wajib diisi saat mode 'agent'; boleh null pada mode 'chat'. */
  toolCtx?: ToolContext | null;
  autoDebug?: boolean;
  maxSteps?: number;
  signal?: AbortSignal;
  /** 'agent' = tool eksekusi sandbox aktif; 'chat' = hanya diskusi/nasihat. */
  mode?: AgentMode;
  /** Kunci sesi OpenRouter (mis. id proyek) untuk menjaga prompt cache tetap hangat. */
  sessionId?: string;
};

/**
 * Loop agentik: model -> tool call -> eksekusi di sandbox -> umpan balik -> ulangi.
 * Semua kejadian di-stream sebagai AgentEvent (dipakai route /api/chat).
 */
export async function* runAgent(options: RunAgentOptions): AsyncGenerator<AgentEvent> {
  const { apiKey, model, userText, signal, sessionId } = options;
  const toolCtx = options.toolCtx ?? null;
  const autoDebug = options.autoDebug ?? true;
  const mode: AgentMode = options.mode ?? 'agent';
  const tools = mode === 'agent' ? TOOL_DEFINITIONS : undefined;
  const maxSteps = options.maxSteps ?? MAX_AGENT_STEPS;
  const maxDebugRounds = autoDebug ? MAX_AUTO_DEBUG_ROUNDS : 0;

  const messages: ChatMsg[] = [
    { role: 'system', content: buildSystemPrompt(mode) },
    ...options.history,
    { role: 'user', content: userText },
  ];

  const blocks: Block[] = [];
  // Total pemakaian token satu giliran (semua langkah) untuk ditampilkan ke user.
  const turnUsage: UsageInfo = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: undefined };
  let finalText = '';
  let debugRounds = 0;
  let step = 0;
  let hitStepLimit = false;

  try {
    while (step < maxSteps) {
      if (signal?.aborted) break;
      step += 1;
      if (step > 1) yield { type: 'status', message: `Langkah ${step}/${maxSteps}: melanjutkan pekerjaan…` };

      let textBuffer = '';
      let textBlock: TextBlock | null = null;
      let reasoningBlock: { type: 'reasoning'; text: string } | null = null;
      let calls: Array<{ id: string; name: string; arguments: string }> = [];
      let finishReason: string | undefined;
      // Menahan markup `:::choices` agar tidak berkedip di UI saat streaming.
      const choiceFilter = createChoiceStreamFilter();

      // Akumulasi pemakaian token pada langkah ini (untuk ditampilkan ke user).
      const stepUsage: UsageInfo = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: undefined };

      for await (const event of streamChat({ apiKey, model, messages, tools, signal, maxTokens: MAX_OUTPUT_TOKENS, sessionId })) {
        if (event.type === 'text') {
          textBuffer += event.value;
          if (!textBlock) {
            textBlock = { type: 'text', text: '' };
            blocks.push(textBlock);
          }
          textBlock.text += event.value;
          // Yang dikirim ke UI adalah teks SETELAH blok pilihan dibuang.
          const visible = choiceFilter.push(event.value);
          if (visible) yield { type: 'text', value: visible };
        } else if (event.type === 'reasoning') {
          if (!reasoningBlock) {
            reasoningBlock = { type: 'reasoning', text: '' };
            blocks.push(reasoningBlock);
          }
          reasoningBlock.text += event.value;
          yield { type: 'reasoning', value: event.value };
        } else if (event.type === 'tool_calls') {
          calls = event.calls;
        } else if (event.type === 'usage') {
          stepUsage.promptTokens += event.value.promptTokens;
          stepUsage.completionTokens += event.value.completionTokens;
          stepUsage.cachedTokens = (stepUsage.cachedTokens ?? 0) + (event.value.cachedTokens ?? 0);
          if (typeof event.value.costUsd === 'number') {
            stepUsage.costUsd = (stepUsage.costUsd ?? 0) + event.value.costUsd;
          }
          // stepUsage = pemakaian langkah ini; ditampilkan langsung di UI.
          yield { type: 'usage', value: stepUsage };
        } else if (event.type === 'retry') {
          yield event; // diteruskan apa adanya ke UI (ditampilkan sebagai status)
        } else if (event.type === 'done') {
          finishReason = event.finishReason;
        }
      }

      // Akumulasi ke total satu giliran (dipakai untuk blok usage yang disimpan).
      turnUsage.promptTokens += stepUsage.promptTokens;
      turnUsage.completionTokens += stepUsage.completionTokens;
      turnUsage.cachedTokens = (turnUsage.cachedTokens ?? 0) + (stepUsage.cachedTokens ?? 0);
      if (typeof stepUsage.costUsd === 'number') {
        turnUsage.costUsd = (turnUsage.costUsd ?? 0) + stepUsage.costUsd;
      }

      // Sisa teks yang masih ditahan filter (mis. blok pilihan tidak ditutup).
      const tail = choiceFilter.flush();
      if (tail) yield { type: 'text', value: tail };

      // Pisahkan blok pilihan dari teks: yang tampil di chat hanya teksnya,
      // sedangkan pilihannya menjadi blok terstruktur (tombol yang bisa diklik).
      const parsed = parseChoices(textBuffer);
      if (parsed.questions.length) {
        if (textBlock) textBlock.text = parsed.cleaned;
        const choicesBlock: ChoicesBlock = { type: 'choices', questions: parsed.questions };
        blocks.push(choicesBlock);
        yield { type: 'choices', questions: parsed.questions };
      }
      const visibleText = parsed.questions.length ? parsed.cleaned : textBuffer;

      if (visibleText.trim()) finalText = finalText ? `${finalText}\n${visibleText}` : visibleText;

      if (!calls.length) {
        if (finishReason === 'length') {
          yield { type: 'status', message: 'Jawaban model terpotong karena batas token.' };
        }
        break; // giliran user
      }

      if (mode === 'chat' || !toolCtx) break; // tidak ada tool yang bisa dijalankan

      messages.push({
        role: 'assistant',
        content: textBuffer,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments || '{}' },
        })),
      });

      let hadError = false;

      for (const call of calls) {
        if (signal?.aborted) break;
        const args = safeParseArgs(call.arguments);
        const toolBlock: ToolBlock = { type: 'tool', id: call.id, name: call.name, args, status: 'running' };
        blocks.push(toolBlock);
        yield { type: 'tool_start', id: call.id, name: call.name, args };

        // Output tool di-stream live ke UI (terminal mini di panel chat).
        const queue: string[] = [];
        let notify: (() => void) | null = null;
        let finished = false;
        let settled: ToolResult | null = null;

        const running = executeTool(
          { ...toolCtx, onOutput: (chunk) => { queue.push(chunk); notify?.(); notify = null; } },
          call.name,
          args,
        ).then((res) => {
          settled = res;
          finished = true;
          notify?.();
          notify = null;
          return res;
        });

        while (!finished || queue.length) {
          while (queue.length) {
            const chunk = queue.shift()!;
            yield { type: 'tool_output', id: call.id, value: truncate(chunk, 2_000) };
          }
          if (finished) break;
          await new Promise<void>((resolve) => { notify = resolve; });
        }

        const result = settled ?? (await running);
        toolBlock.status = result.ok ? 'ok' : 'error';
        toolBlock.output = truncate(result.output, 6_000);
        if (result.previewUrl) toolBlock.previewUrl = result.previewUrl;
        if (!result.ok) hadError = true;

        yield {
          type: 'tool_result',
          id: call.id,
          name: call.name,
          ok: result.ok,
          output: toolBlock.output,
          previewUrl: result.previewUrl,
        };

        if (result.previewUrl) {
          yield { type: 'preview', url: result.previewUrl, port: result.port ?? 3000 };
        }

        // Dibatas agar hasil besar (mis. isi file) tidak membengkakkan prompt
        // di setiap langkah berikutnya - lihat AGENT_TOOL_OUTPUT_CHARS.
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: truncate(result.output, TOOL_OUTPUT_CHARS),
        });
      }

      if (signal?.aborted) break;

      if (hadError && debugRounds < maxDebugRounds) {
        debugRounds += 1;
        const lastError = [...blocks]
          .reverse()
          .find((b): b is ToolBlock => b.type === 'tool' && b.status === 'error');
        yield { type: 'status', message: `Auto-debug ${debugRounds}/${maxDebugRounds}: mengirim error ke model untuk diperbaiki` };
        messages.push({ role: 'user', content: autoDebugNudge(lastError?.output ?? '') });
        continue;
      }

      // Model sudah memanggil tool: lanjut supaya ia melihat hasilnya dan menutup giliran.
      continue;
    }

    if (step >= maxSteps && !signal?.aborted) {
      hitStepLimit = true;
      yield { type: 'status', message: 'Batas langkah tercapai, meminta ringkasan…' };
      messages.push({ role: 'user', content: stepBudgetNotice() });
      let summaryBlock: TextBlock | null = null;
      let summaryText = '';
      const summaryFilter = createChoiceStreamFilter();
      for await (const event of streamChat({ apiKey, model, messages, signal, maxTokens: MAX_OUTPUT_TOKENS, sessionId })) {
        if (event.type === 'text') {
          if (!summaryBlock) {
            summaryBlock = { type: 'text', text: '' };
            blocks.push(summaryBlock);
          }
          summaryText += event.value;
          summaryBlock.text = summaryText;
          const visible = summaryFilter.push(event.value);
          if (visible) yield { type: 'text', value: visible };
        }
      }
      const summaryTail = summaryFilter.flush();
      if (summaryTail) yield { type: 'text', value: summaryTail };
      const parsedSummary = parseChoices(summaryText);
      if (parsedSummary.questions.length) {
        if (summaryBlock) summaryBlock.text = parsedSummary.cleaned;
        blocks.push({ type: 'choices', questions: parsedSummary.questions });
        yield { type: 'choices', questions: parsedSummary.questions };
      }
      const summaryVisible = parsedSummary.questions.length ? parsedSummary.cleaned : summaryText;
      if (summaryVisible.trim()) finalText = finalText ? `${finalText}\n${summaryVisible}` : summaryVisible;
    }
  } catch (err) {
    const message =
      err instanceof OpenRouterError
        ? err.message
        : `Terjadi error saat menjalankan agent: ${err instanceof Error ? err.message : String(err)}`;
    blocks.push({ type: 'notice', level: 'error', text: message });
    yield { type: 'error', message };
  }

  void hitStepLimit;

  // Ringkasan pemakaian giliran ini: terlihat oleh user (transparansi biaya)
  // dan tersimpan bersama pesan sehingga bisa ditinjau ulang.
  if (turnUsage.promptTokens || turnUsage.completionTokens) {
    const usageBlock: UsageBlock = {
      type: 'usage',
      promptTokens: turnUsage.promptTokens,
      completionTokens: turnUsage.completionTokens,
      cachedTokens: turnUsage.cachedTokens,
      costUsd: turnUsage.costUsd,
    };
    blocks.push(usageBlock);
  }

  yield { type: 'done', blocks, content: finalText };
}

function safeParseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
