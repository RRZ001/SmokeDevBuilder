'use client';

/**
 * Helper HTTP sisi klien.
 *
 * Soal base path: aplikasi bisa dilayani di root (Vercel, custom domain) atau di
 * subpath (mis. https://domain/agentcloud). Salah menebak base path membuat SEMUA
 * request API 404 dan aplikasi berhenti di layar "Gagal memuat workspace".
 *
 * Karena itu base path di sini TIDAK hanya percaya environment variable (yang
 * bisa tertinggal/keliru di dashboard hosting), tapi dideteksi ulang di browser
 * dari URL aset Next yang sebenarnya dipakai halaman ini:
 *     <script src="/agentcloud/_next/static/...">  => base path "/agentcloud"
 *     <script src="/_next/static/...">             => base path "" (root)
 */

const ENV_BASE = process.env.NEXT_PUBLIC_BASE_PATH || '';

const OWNER_STORAGE_KEY = 'agentcloud.owner';

let resolvedBase: string | null = null;

/** Deteksi base path dari elemen <script>/<link> Next yang ada di DOM. */
function detectBaseFromDom(): string | null {
  if (typeof document === 'undefined') return null;
  const nodes = document.querySelectorAll<HTMLElement>('script[src], link[href]');
  for (const node of Array.from(nodes)) {
    const url = node.getAttribute('src') || node.getAttribute('href') || '';
    const index = url.indexOf('/_next/');
    if (index >= 0) return url.slice(0, index);
  }
  // Tidak menemukan aset → pakai nilai environment (atau root bila kosong).
  return null;
}

export function getBase(): string {
  if (resolvedBase !== null) return resolvedBase;
  const detected = detectBaseFromDom();
  resolvedBase = detected ?? ENV_BASE;
  return resolvedBase;
}

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

function buildUrl(path: string): string {
  return `${getBase()}${path}`;
}

/**
 * Jaring pengaman terakhir: kalau base path ternyata salah tebak (request 404
 * padahal base-nya tidak kosong), coba sekali lagi TANPA prefix dan ingat hasil
 * yang berhasil. Ini membuat aplikasi tetap jalan walau environment variable
 * base path di dashboard hosting keliru.
 */
async function fetchApi(path: string, init?: RequestInit): Promise<Response> {
  const base = getBase();
  const response = await fetch(buildUrl(path), init);
  if (response.status === 404 && base) {
    const retry = await fetch(path, init);
    if (retry.ok) {
      console.warn(`[agentcloud] base path "${base}" tidak valid di hosting ini - memakai root.`);
      resolvedBase = '';
      return retry;
    }
  }
  return response;
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchApi(path, {
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
  const response = await fetchApi(path, {
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
