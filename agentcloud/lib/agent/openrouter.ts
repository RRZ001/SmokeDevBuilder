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

export type StreamEvent =
  | { type: 'text'; value: string }
  | { type: 'reasoning'; value: string }
  | { type: 'tool_calls'; calls: Array<{ id: string; name: string; arguments: string }> }
  | { type: 'usage'; value: unknown }
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
};

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
      return `Rate limit / kuota OpenRouter tercapai (429). Coba lagi sebentar. Detail: ${detail}`;
    default:
      return `OpenRouter error ${status}: ${detail}`;
  }
}

/**
 * Streaming completion ke OpenRouter (API-nya kompatibel dengan OpenAI:
 * mendukung `tools` untuk function calling dan field `reasoning` untuk model R1).
 */
export async function* streamChat(options: StreamChatOptions): AsyncGenerator<StreamEvent> {
  const { apiKey, model, messages, tools, temperature = 0.2, signal, maxTokens } = options;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-Title': OPENROUTER_APP_NAME,
  };
  if (OPENROUTER_SITE_URL) headers['HTTP-Referer'] = OPENROUTER_SITE_URL;

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    temperature,
    usage: { include: true },
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (maxTokens) body.max_tokens = maxTokens;

  let response: Response;
  try {
    response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) return;
    throw new OpenRouterError(`Gagal menghubungi OpenRouter: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new OpenRouterError(friendlyStatus(response.status, text), response.status);
  }

  const toolAcc = new Map<number, { id: string; name: string; args: string }>();
  let finishReason: string | undefined;

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
        if (json.usage) yield { type: 'usage', value: json.usage };
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
