import { OPENROUTER_APP_NAME, OPENROUTER_BASE_URL, OPENROUTER_SITE_URL } from '@/lib/config';

export type ChatMsg = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OpenRouterToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type OpenRouterToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type ToolDef = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type UsageInfo = {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  costUsd?: number;
};

export type StreamEvent =
  | { type: 'text'; value: string }
  | { type: 'reasoning'; value: string }
  | { type: 'tool_calls'; calls: Array<{ id: string; name: string; arguments: string }> }
  | { type: 'usage'; value: UsageInfo }
  | { type: 'retry'; attempt: number; maxAttempts: number; waitMs: number; reason: string }
  | { type: 'done'; finishReason?: string };

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

export type StreamChatOptions = {
  apiKey: string;
  model: string;
  messages: ChatMsg[];
  tools?: ToolDef[];
  temperature?: number;
  signal?: AbortSignal;
  maxTokens?: number;
  /**
   * Kunci sesi (mis. id proyek). Dipakai OpenRouter untuk "sticky routing" dan
   * pengelompokan sesi: permintaan lanjutan diarahkan ke provider yang sama
   * sehingga prompt cache tetap hangat (hemat biaya percakapan multi-turn).
   */
  sessionId?: string;
};

/** Provider di balik model Anthropic butuh penanda cache eksplisit. */
function needsExplicitCache(model: string): boolean {
  return model.toLowerCase().startsWith('anthropic/');
}

/** Ubah content pesan menjadi blok teks + penanda cache (dipakai untuk Claude). */
function withCacheControl(message: ChatMsg): ChatMsg {
  if (typeof message.content !== 'string' || !message.content) return message;
  return {
    ...message,
    content: [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }],
  } as unknown as ChatMsg;
}

function friendlyStatus(status: number, body: string): string {
  const detail = body.slice(0, 400);
  switch (status) {
    case 401:
      return `OpenRouter menolak API key (401). Periksa kembali key di Settings. Detail: ${detail}`;
    case 402:
      return `Kredit OpenRouter tidak cukup (402). Isi ulang saldo di openrouter.ai/credits. Detail: ${detail}`;
    case 403:
      return `Akses ditolak OpenRouter (403) - model mungkin butuh izin/opt-in. Detail: ${detail}`;
    case 404:
      return `Model tidak ditemukan di OpenRouter (404). Pilih model lain di Settings. Detail: ${detail}`;
    case 429:
      return `OpenRouter menolak sementara (429) setelah beberapa kali dicoba ulang. Ini biasanya throttle/pemeriksaan saldo di sisi OpenRouter, BUKAN tanda saldo habis - pekerjaanmu di sandbox tetap aman. Tunggu sebentar lalu kirim ulang pesanmu (atau tekan "lanjutkan"). Detail: ${detail}`;
    default:
      return `OpenRouter error ${status}: ${detail}`;
  }
}

/** Batas percobaan ulang untuk error yang bersifat sementara (429 / 5xx). */
const MAX_RETRIES = 3;
/** Batas menunggu per percobaan & total, agar tidak memakan durasi fungsi hosting. */
const MAX_WAIT_PER_ATTEMPT_MS = 15_000;
const MAX_TOTAL_WAIT_MS = 30_000;
const BACKOFF_MS = [2_000, 5_000, 8_000];

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Lama menunggu sebelum mencoba ulang. OpenRouter mengirim Retry-After (detik)
 * atau X-RateLimit-Reset (epoch detik) - keduanya dihormati bila ada.
 */
function computeWaitMs(headers: Headers, attempt: number): number {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_WAIT_PER_ATTEMPT_MS, Math.max(1_000, seconds * 1_000));
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.min(MAX_WAIT_PER_ATTEMPT_MS, Math.max(1_000, date - Date.now()));
    }
  }

  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    const ms = reset > 1_000_000_000 ? reset * 1_000 - Date.now() : reset;
    if (ms > 0) return Math.min(MAX_WAIT_PER_ATTEMPT_MS, Math.max(1_000, ms));
  }

  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  return Math.min(MAX_WAIT_PER_ATTEMPT_MS, base + Math.floor(Math.random() * 700));
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Streaming completion ke OpenRouter (API-nya kompatibel dengan OpenAI:
 * mendukung `tools` untuk function calling dan field `reasoning` untuk model R1).
 *
 * Penghematan biaya:
 *  - `session_id` dipasang supaya routing provider tetap sama (prompt cache hangat).
 *  - Untuk Claude, penanda `cache_control` dipasang di system prompt dan di ujung
 *    riwayat: bagian yang sudah terbaca dibayar ~0,1x harga input, sangat
 *    berpengaruh pada loop agent yang memanggil banyak tool.
 *  - Error sementara (429/5xx) dicoba ulang mengikuti header Retry-After.
 */
export async function* streamChat(options: StreamChatOptions): AsyncGenerator<StreamEvent> {
  const { apiKey, model, messages, tools, temperature = 0.2, signal, maxTokens, sessionId } = options;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-Title': OPENROUTER_APP_NAME,
  };
  if (OPENROUTER_SITE_URL) headers['HTTP-Referer'] = OPENROUTER_SITE_URL;
  if (sessionId) headers['x-session-id'] = sessionId.slice(0, 256);

  // Penanda cache (maksimum 4 breakpoint di Anthropic): system prompt + pesan terakhir.
  let outgoingMessages: ChatMsg[] = messages;
  if (needsExplicitCache(model) && messages.length) {
    const lastIndex = messages.length - 1;
    outgoingMessages = messages.map((message, index) => {
      if (index === 0 && message.role === 'system') return withCacheControl(message);
      if (index === lastIndex && message.role !== 'tool') return withCacheControl(message);
      return message;
    });
  }

  const body: Record<string, unknown> = {
    model,
    messages: outgoingMessages,
    stream: true,
    temperature,
    usage: { include: true },
  };
  if (sessionId) body.session_id = sessionId.slice(0, 256);
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (maxTokens) body.max_tokens = maxTokens;

  let response: Response | null = null;
  let totalWaited = 0;
  let attempt = 0;

  while (!response) {
    let current: Response;
    try {
      current = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) return;
      // Gangguan jaringan juga layak dicoba ulang.
      if (attempt < MAX_RETRIES && totalWaited < MAX_TOTAL_WAIT_MS) {
        const waitMs = computeWaitMs(new Headers(), attempt);
        attempt += 1;
        totalWaited += waitMs;
        yield { type: 'retry', attempt, maxAttempts: MAX_RETRIES, waitMs, reason: 'koneksi gagal' };
        await sleep(waitMs, signal);
        if (signal?.aborted) return;
        continue;
      }
      throw new OpenRouterError(`Gagal menghubungi OpenRouter: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (current.ok && current.body) {
      response = current;
      break;
    }

    const status = current.status;
    const text = await current.text().catch(() => '');

    if (!isRetryable(status) || attempt >= MAX_RETRIES || totalWaited >= MAX_TOTAL_WAIT_MS) {
      throw new OpenRouterError(friendlyStatus(status, text), status);
    }

    const waitMs = computeWaitMs(current.headers, attempt);
    attempt += 1;
    totalWaited += waitMs;
    yield { type: 'retry', attempt, maxAttempts: MAX_RETRIES, waitMs, reason: `HTTP ${status}` };
    await sleep(waitMs, signal);
    if (signal?.aborted) return;
  }

  const toolAcc = new Map<number, { id: string; name: string; args: string }>();
  let finishReason: string | undefined;

  if (!response.body) {
    throw new OpenRouterError('OpenRouter tidak mengirim body pada respons streaming.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let json: any;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }

        if (json.error) {
          const message = json.error.message || JSON.stringify(json.error);
          throw new OpenRouterError(`OpenRouter mengembalikan error: ${message}`);
        }

        const choice = json.choices?.[0];
        if (json.usage) yield { type: 'usage', value: toUsage(json.usage) };
        if (!choice) continue;

        const delta = choice.delta ?? {};
        const text = typeof delta.content === 'string' ? delta.content : extractTextContent(delta.content);
        if (text) yield { type: 'text', value: text };

        // DeepSeek-R1 & model reasoning lain mengirim chain-of-thought di sini.
        const reasoning = delta.reasoning ?? delta.reasoning_content;
        if (typeof reasoning === 'string' && reasoning) yield { type: 'reasoning', value: reasoning };

        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            const index = typeof call.index === 'number' ? call.index : 0;
            const acc = toolAcc.get(index) ?? { id: '', name: '', args: '' };
            if (call.id) acc.id = call.id;
            if (call.function?.name) acc.name = call.function.name;
            if (typeof call.function?.arguments === 'string') acc.args += call.function.arguments;
            toolAcc.set(index, acc);
          }
        }

        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }

  if (toolAcc.size) {
    const calls = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, acc]) => ({
        id: acc.id || `call_${index}_${Math.random().toString(36).slice(2, 8)}`,
        name: acc.name,
        arguments: acc.args || '{}',
      }))
      .filter((c) => c.name);
    if (calls.length) yield { type: 'tool_calls', calls };
  }

  yield { type: 'done', finishReason };
}

function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
    .join('');
}

/**
 * Ringkas objek usage OpenRouter. Field biaya (`cost`) hanya ada bila akun
 * mengaktifkan akuntansi biaya; kalau tidak ada, UI cukup menampilkan token.
 */
function toUsage(raw: Record<string, unknown>): UsageInfo {
  const num = (value: unknown): number | undefined => {
    const parsed = typeof value === 'string' ? Number(value) : value;
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
  };
  const details = (raw.prompt_tokens_details ?? {}) as Record<string, unknown>;
  return {
    promptTokens: num(raw.prompt_tokens) ?? 0,
    completionTokens: num(raw.completion_tokens) ?? 0,
    cachedTokens: num(details.cached_tokens),
    costUsd: num(raw.cost) ?? num(raw.total_cost),
  };
}
