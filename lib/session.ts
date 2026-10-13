import { resolveOwnerId } from '@/lib/auth';
import { DEFAULT_MODEL } from '@/lib/models';
import type { Settings, Store } from '@/lib/db/types';
import { OPENROUTER_API_KEY_ENV, VERCEL_TOKEN_ENV } from '@/lib/config';

export async function owner(): Promise<string> {
  return resolveOwnerId();
}

/** API key efektif: environment lebih diprioritaskan, lalu nilai dari Settings. */
export function effectiveApiKey(settings: Settings | null): string {
  return (OPENROUTER_API_KEY_ENV || settings?.openrouter_api_key || '').trim();
}

export function effectiveModel(settings: Settings | null): string {
  return (settings?.model || DEFAULT_MODEL).trim();
}

/**
 * Kredensial deploy Vercel yang benar-benar dipakai.
 *
 * Prioritas: variabel environment hosting `VERCEL_TOKEN` (kalau pemilik aplikasi
 * menaruhnya di sana) lalu nilai dari Settings. Nilainya HANYA boleh dipakai di
 * server (menjalankan CLI di dalam sandbox) — jangan pernah dikirim ke browser
 * atau dimasukkan ke konteks model; UI hanya menerima cuplikan bertopeng.
 */
export async function effectiveVercel(
  store: Store,
  ownerId: string,
): Promise<{ token: string; scope: string; source: 'env' | 'settings' | 'none' }> {
  const settings = await store.getSettings(ownerId);
  const envToken = VERCEL_TOKEN_ENV.trim();
  const token = (envToken || settings?.vercel_token || '').trim();
  const scope = (settings?.vercel_scope || '').trim();
  return { token, scope, source: envToken ? 'env' : token ? 'settings' : 'none' };
}

/** Cuplikan token untuk ditampilkan di UI (tidak pernah nilai penuhnya). */
export function maskSecret(value: string): string {
  const secret = (value || '').trim();
  if (!secret) return '';
  if (secret.length <= 8) return `${secret.slice(0, 2)}••••`;
  return `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}

export function serializeSettings(settings: Settings | null) {
  const key = effectiveApiKey(settings);
  const vercelToken = (VERCEL_TOKEN_ENV || settings?.vercel_token || '').trim();
  return {
    model: effectiveModel(settings),
    hasKey: Boolean(key),
    keySource: OPENROUTER_API_KEY_ENV ? 'env' : settings?.openrouter_api_key ? 'settings' : 'none',
    keyPreview: key ? `${key.slice(0, 7)}••••${key.slice(-4)}` : '',
    updatedAt: settings?.updated_at ?? null,
    /**
     * Status deploy Vercel. Yang dikirim ke browser hanya ini — token aslinya
     * tidak pernah meninggalkan server.
     */
    vercel: {
      hasToken: Boolean(vercelToken),
      tokenPreview: maskSecret(vercelToken),
      tokenSource: VERCEL_TOKEN_ENV ? ('env' as const) : vercelToken ? ('settings' as const) : ('none' as const),
      scope: (settings?.vercel_scope || '').trim(),
    },
  };
}
