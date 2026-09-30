'use client';

/**
 * Helper HTTP untuk sisi klien.
 *
 * Semua path WAJIB lewat BASE (basePath) supaya tetap benar saat aplikasi
 * dipublish di subpath, mis. https://domain/agentcloud.
 */
export const BASE = process.env.NEXT_PUBLIC_BASE_PATH || '';

const OWNER_STORAGE_KEY = 'agentcloud.owner';

export function getStoredOwner(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(OWNER_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setStoredOwner(id: string): void {
  if (typeof window === 'undefined' || !id) return;
  try {
    window.localStorage.setItem(OWNER_STORAGE_KEY, id);
  } catch {
    /* storage bisa diblokir */
  }
}

function buildHeaders(extra?: HeadersInit): HeadersInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const owner = getStoredOwner();
  if (owner) headers['x-ac-owner'] = owner;
  return { ...headers, ...(extra as Record<string, string> | undefined) };
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: buildHeaders(init?.headers),
    cache: 'no-store',
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data?.error || `Permintaan gagal (HTTP ${response.status})`);
  return data;
}

export type StreamEvent = { type: string } & Record<string, unknown>;

/** Membaca stream NDJSON dari endpoint agent/sandbox. */
export async function* streamNdjson(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok || !response.body) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data?.error || `Permintaan gagal (HTTP ${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line) as StreamEvent;
      } catch {
        /* baris tidak lengkap - abaikan */
      }
    }
  }

  const rest = buffer.trim();
  if (rest) {
    try {
      yield JSON.parse(rest) as StreamEvent;
    } catch {
      /* abaikan */
    }
  }
}
