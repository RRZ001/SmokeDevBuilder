import { MAX_AGENT_STEPS, MAX_AUTO_DEBUG_ROUNDS, MAX_OUTPUT_TOKENS, TOOL_OUTPUT_CHARS } from '@/lib/config';
import type { Block, ChoicesBlock, PlanBlock, PlanItem, TextBlock, ToolBlock, UsageBlock } from '@/lib/db/types';
import { truncate } from '@/lib/util';
import { TOOL_DEFINITIONS, executeTool, type ToolContext, type ToolResult } from '@/lib/sandbox/tools';
import { CHOICE_MARKERS, parseChoices } from './choices';
import { PLAN_MARKERS, parsePlans } from './plan';
import { createMarkerStreamFilter, type MarkerPair } from './marker-block';
import { autoDebugNudge, buildSystemPrompt, stepBudgetNotice, visualCheckNudge, type AgentMode } from './prompt';
import { OpenRouterError, streamChat, type ChatMsg, type UsageInfo } from './openrouter';
import { supportsVision } from './vision';

/**
 * Satu filter untuk SEMUA blok penanda di jawaban model.
 *
 * Sengaja digabung (bukan satu filter per jenis blok): tiap filter menahan ekor
 * buffer yang mungkin awal penandanya, jadi dua filter terpisah bisa saling
 * menahan/menunda teks yang sama saat streaming.
 */
const CONTENT_MARKERS: MarkerPair[] = [...CHOICE_MARKERS, ...PLAN_MARKERS];

export type AgentEvent =
  | { type: 'status'; message: string }
  | { type: 'retry'; attempt: number; maxAttempts: number; waitMs: number; reason: string }
  | { type: 'text'; value: string }
  | { type: 'reasoning'; value: string }
  | { type: 'choices'; questions: import('@/lib/db/types').ChoiceQuestion[] }
  | { type: 'plan'; items: PlanItem[] }
  | { type: 'image'; dataUrl: string; caption: string }
  | { type: 'tool_start'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_output'; id: string; value: string }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; output: string; previewUrl?: string }
  | { type: 'preview'; url: string; port: number }
  /** Link permanen hasil deploy (Vercel) — bukan URL sandbox yang bisa mati. */
  | { type: 'deploy'; url: string }
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
  /** Server preview sudah SIAP dijalankan di giliran ini (untuk nudge browser_check). */
  let previewStarted = false;
  /** Model sudah mencoba memeriksa tampilan di giliran ini. */
  let visuallyChecked = false;
  /** Nudge verifikasi tampilan hanya dikirim SEKALI per giliran (jaga biaya token). */
  let visualNudged = false;

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
      // Menahan markup blok penanda (`:::choices` / `:::plan`) agar tidak
      // berkedip di UI saat streaming.
      const contentFilter = createMarkerStreamFilter(CONTENT_MARKERS);

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
          // Yang dikirim ke UI adalah teks SETELAH blok penanda dibuang.
          const visible = contentFilter.push(event.value);
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

      // Sisa teks yang masih ditahan filter (mis. blok penanda tidak ditutup).
      const tail = contentFilter.flush();
      if (tail) yield { type: 'text', value: tail };

      // Pisahkan blok pilihan & blok rencana dari teks: yang tampil di chat hanya
      // teksnya, sedangkan kedua blok itu dirender sebagai komponen tersendiri.
      const parsed = parseChoices(textBuffer);
      const parsedPlan = parsePlans(parsed.questions.length ? parsed.cleaned : textBuffer);
      const visibleText = parsedPlan.cleaned;

      if (textBlock && visibleText !== textBuffer) textBlock.text = visibleText;

      for (const items of parsedPlan.plans) {
        const planBlock: PlanBlock = { type: 'plan', items };
        blocks.push(planBlock);
        yield { type: 'plan', items };
      }

      if (parsed.questions.length) {
        const choicesBlock: ChoicesBlock = { type: 'choices', questions: parsed.questions };
        blocks.push(choicesBlock);
        yield { type: 'choices', questions: parsed.questions };
      }

      if (visibleText.trim()) finalText = finalText ? `${finalText}\n${visibleText}` : visibleText;

      if (!calls.length) {
        if (finishReason === 'length') {
          yield { type: 'status', message: 'Jawaban model terpotong karena batas token.' };
        }
        break; // giliran user
      }

      /**
       * Model mengajukan pertanyaan (blok `:::choices`) SEKALIGUS memanggil tool di
       * giliran yang sama. Perilaku itu membuat agent "bertanya lalu tetap jalan
       * sendiri" — persis yang dikeluhkan user. VibeCoder berhenti dan menunggu
       * jawaban, jadi tool call pada giliran ini DIBUANG: keputusan user benar-benar
       * dipakai, bukan sekadar diumumkan. Blok pilihannya sudah tersimpan sebagai
       * bagian pesan, jadi tombolnya tetap ada setelah reload.
       */
      if (parsed.questions.length) {
        yield { type: 'status', message: 'Menunggu jawaban pilihanmu sebelum melanjutkan.' };
        break;
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
      /** Screenshot dari browser_check pada langkah ini (untuk model & UI). */
      const shots: Array<{ dataUrl: string; caption: string }> = [];

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

        // Untuk memutuskan nudge verifikasi tampilan di akhir giliran:
        // server preview benar-benar siap, atau model sudah mencoba memeriksanya.
        if (call.name === 'start_server' && result.ok) previewStarted = true;
        if (call.name === 'browser_check') visuallyChecked = true;

        yield {
          type: 'tool_result',
          id: call.id,
          name: call.name,
          ok: result.ok,
          output: toolBlock.output,
          previewUrl: result.previewUrl,
        };

        if (result.previewUrl) {
          // `deploy` mengembalikan LINK PERMANEN (Vercel), bukan URL sandbox:
          // jangan diperlakukan sebagai preview (yang bisa mati saat pause).
          if (call.name === 'deploy') {
            yield { type: 'deploy', url: result.previewUrl };
          } else {
            yield { type: 'preview', url: result.previewUrl, port: result.port ?? 3000 };
          }
        }

        // Screenshot: ditampilkan live ke UI, dan (kalau modelnya bisa melihat)
        // dikirim ke model sebagai bagian pesan berikutnya.
        if (result.image) {
          shots.push(result.image);
          yield { type: 'image', dataUrl: result.image.dataUrl, caption: result.image.caption };
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

      // Kirim screenshot ke model HANYA kalau modelnya memang bisa melihat.
      // Kalau tidak, agent diberi tahu supaya tidak menyangka sudah melihat
      // halaman dan mengandalkan diagnostik teks dari browser_check.
      if (shots.length) {
        const canSee = await supportsVision(model);
        if (canSee) {
          messages.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  `Screenshot dari browser_check (${shots.length} gambar). Periksa tampilannya seperti seorang desainer: ` +
                  'hierarki, jarak, keterbacaan, keselarasan, elemen yang menumpuk/terpotong, dan apakah halaman ini ' +
                  'terlihat seperti template generik. Sebutkan temuan spesifik, lalu perbaiki.',
              },
              ...shots.map((shot) => ({ type: 'image_url' as const, image_url: { url: shot.dataUrl } })),
            ],
          });
        } else {
          messages.push({
            role: 'user',
            content:
              '[sistem] Screenshot TIDAK bisa dikirim ke model yang sedang dipakai (model ini tidak menerima gambar). ' +
              'Kamu TIDAK melihat tampilannya. Andalkan angka & daftar masalah dari hasil browser_check ' +
              '(status HTTP, error console, request gagal, scroll horizontal, gambar rusak) dan jangan mengklaim ' +
              'tampilannya sudah bagus. Kalau user butuh penilaian visual, sarankan memakai model yang mendukung gambar.',
          });
        }
      }

      if (hadError && debugRounds < maxDebugRounds) {
        debugRounds += 1;
        const lastError = [...blocks]
          .reverse()
          .find((b): b is ToolBlock => b.type === 'tool' && b.status === 'error');
        yield { type: 'status', message: `Auto-debug ${debugRounds}/${maxDebugRounds}: mengirim error ke model untuk diperbaiki` };
        messages.push({ role: 'user', content: autoDebugNudge(lastError?.output ?? '') });
        continue;
      }

      /**
       * Server preview sudah jalan tetapi tampilannya belum diperiksa sama sekali
       * di giliran ini → minta sekali lagi. Tanpa dorongan ini agent sering
       * menutup giliran hanya bermodal log server, padahal halaman bisa putih
       * karena error JS atau berantakan di 375px. Dibatasi satu kali per giliran
       * supaya biaya token tetap terkendali.
       */
      if (mode === 'agent' && previewStarted && !visuallyChecked && !visualNudged) {
        visualNudged = true;
        yield { type: 'status', message: 'Meminta agent memeriksa tampilannya dengan browser sungguhan…' };
        messages.push({ role: 'user', content: visualCheckNudge() });
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
      const summaryFilter = createMarkerStreamFilter(CONTENT_MARKERS);
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
      const parsedSummaryPlan = parsePlans(parsedSummary.questions.length ? parsedSummary.cleaned : summaryText);
      const summaryVisible = parsedSummaryPlan.cleaned;
      if (summaryBlock && summaryVisible !== summaryText) summaryBlock.text = summaryVisible;
      for (const items of parsedSummaryPlan.plans) {
        blocks.push({ type: 'plan', items });
        yield { type: 'plan', items };
      }
      if (parsedSummary.questions.length) {
        blocks.push({ type: 'choices', questions: parsedSummary.questions });
        yield { type: 'choices', questions: parsedSummary.questions };
      }
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
