import { NextResponse } from 'next/server';

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data as object, init);
}

export function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export function errorResponse(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[api] error:', message);
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    const data = await request.json();
    return (data ?? {}) as T;
  } catch {
    return {} as T;
  }
}

/**
 * Helper streaming NDJSON (Newline Delimited JSON): dipakai oleh endpoint agent,
 * sandbox dan exec supaya UI bisa merender progres secara live.
 */
export function ndjsonStream(
  handler: (send: (event: unknown) => void, signal: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true;
        }
      };
      const abortController = new AbortController();
      const abort = () => {
        closed = true;
        abortController.abort();
      };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        await handler(send, abortController.signal);
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        signal?.removeEventListener('abort', abort);
        try {
          controller.close();
        } catch {
          /* sudah tertutup */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
