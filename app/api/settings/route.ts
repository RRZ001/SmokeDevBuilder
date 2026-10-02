import { fail, ok, errorResponse, readJson } from '@/lib/api';
import { OPENROUTER_BASE_URL } from '@/lib/config';
import { getStore } from '@/lib/db';
import { modelLabel } from '@/lib/models';
import { effectiveApiKey, effectiveModel, owner, serializeSettings } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const ownerId = await owner();
    const { store, info } = await getStore();
    const settings = await store.getSettings(ownerId);
    return ok({
      settings: serializeSettings(settings),
      storage: { configured: info.configured, active: info.active, supabaseError: info.supabaseError ?? null },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

type Body = {
  openrouter_api_key?: string;
  model?: string;
  action?: 'save' | 'test';
};

export async function POST(request: Request) {
  try {
    const ownerId = await owner();
    const body = await readJson<Body>(request);
    const { store } = await getStore();

    if (body.action === 'test') {
      const existing = await store.getSettings(ownerId);
      const apiKey = (body.openrouter_api_key || '').trim() || effectiveApiKey(existing);
      if (!apiKey) return fail('API key masih kosong, tidak ada yang bisa diuji.', 400);
      const model = (body.model || '').trim() || effectiveModel(existing);
      const started = Date.now();
      try {
        const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'Balas dengan satu kata: OK' }],
            max_tokens: 5,
            temperature: 0,
          }),
        });
        const text = await res.text();
        if (!res.ok) {
          return ok({
            ok: false,
            latencyMs: Date.now() - started,
            message: `OpenRouter menolak (${res.status}): ${text.slice(0, 300)}`,
          });
        }
        const json = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
        return ok({
          ok: true,
          latencyMs: Date.now() - started,
          message: `Key & model valid (${modelLabel(model)}). Balasan model: ${
            json.choices?.[0]?.message?.content?.trim().slice(0, 40) ?? '(kosong)'
          }`,
        });
      } catch (err) {
        return ok({
          ok: false,
          latencyMs: Date.now() - started,
          message: `Gagal menghubungi OpenRouter: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const patch: { openrouter_api_key?: string; model?: string } = {};
    if (typeof body.openrouter_api_key === 'string') {
      patch.openrouter_api_key = body.openrouter_api_key.trim();
    }
    if (typeof body.model === 'string' && body.model.trim()) {
      patch.model = body.model.trim();
    }
    if (!Object.keys(patch).length) return fail('Tidak ada perubahan yang dikirim.', 400);

    const saved = await store.saveSettings(ownerId, patch);
    return ok({ settings: serializeSettings(saved) });
  } catch (err) {
    return errorResponse(err);
  }
}
