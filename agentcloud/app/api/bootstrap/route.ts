import { capabilities } from '@/lib/config';
import { getStore } from '@/lib/db';
import { ok, errorResponse } from '@/lib/api';
import { effectiveModel, owner, serializeSettings } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Dipanggil sekali saat aplikasi dibuka klien:
 * memastikan identitas owner (cookie), lalu mengirim settings + daftar proyek
 * + status kapabilitas (Supabase/E2B/OpenRouter dari env).
 */
export async function GET() {
  try {
    const ownerId = await owner();
    const { store, info } = await getStore();
    const [settings, projects] = await Promise.all([store.getSettings(ownerId), store.listProjects(ownerId)]);

    return ok({
      owner: ownerId,
      settings: { ...serializeSettings(settings), model: effectiveModel(settings) },
      projects,
      capabilities: {
        ...capabilities(),
        storage: {
          configured: info.configured,
          active: info.active,
          supabaseConfigured: info.supabaseConfigured,
          supabaseRole: info.supabaseRole,
          supabaseError: info.supabaseError ?? null,
        },
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
