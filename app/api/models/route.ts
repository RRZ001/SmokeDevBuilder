import { errorResponse, ok } from '@/lib/api';
import { OPENROUTER_BASE_URL } from '@/lib/config';
import { mergeCatalog, MODEL_CATALOG } from '@/lib/models';

export const dynamic = 'force-dynamic';

type Cache = { at: number; ids: string[] };
const globalForModels = globalThis as unknown as { __acModels?: Cache };
const TTL_MS = 10 * 60 * 1000;

async function liveModelIds(): Promise<{ ids: string[]; error?: string }> {
  const cached = globalForModels.__acModels;
  if (cached && Date.now() - cached.at < TTL_MS) return { ids: cached.ids };

  try {
    const res = await fetch(`${OPENROUTER_BASE_URL}/models`, { headers: { accept: 'application/json' } });
    if (!res.ok) return { ids: [], error: `OpenRouter models HTTP ${res.status}` };
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    globalForModels.__acModels = { at: Date.now(), ids };
    return { ids };
  } catch (err) {
    return { ids: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = (url.searchParams.get('q') || '').toLowerCase().trim();
    const { ids, error } = await liveModelIds();
    const { catalog, liveExtra } = mergeCatalog(ids);

    const filter = (list: typeof catalog) =>
      query ? list.filter((m) => m.id.toLowerCase().includes(query) || m.label.toLowerCase().includes(query)) : list;

    return ok({
      catalog: filter(catalog),
      liveExtra: filter(liveExtra),
      liveCount: ids.length,
      liveError: error ?? null,
      defaultModel: MODEL_CATALOG.find((m) => m.recommended)?.id ?? MODEL_CATALOG[0].id,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
