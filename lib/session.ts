import { resolveOwnerId } from '@/lib/auth';
import { DEFAULT_MODEL } from '@/lib/models';
import type { Settings } from '@/lib/db/types';
import { OPENROUTER_API_KEY_ENV } from '@/lib/config';

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

export function serializeSettings(settings: Settings | null) {
  const key = effectiveApiKey(settings);
  return {
    model: effectiveModel(settings),
    hasKey: Boolean(key),
    keySource: OPENROUTER_API_KEY_ENV ? 'env' : settings?.openrouter_api_key ? 'settings' : 'none',
    keyPreview: key ? `${key.slice(0, 7)}••••${key.slice(-4)}` : '',
    updatedAt: settings?.updated_at ?? null,
  };
}
