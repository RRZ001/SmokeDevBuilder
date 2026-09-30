import { capabilities } from '@/lib/config';
import { getStore } from '@/lib/db';
import { errorResponse, ok } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { info, store } = await getStore();
    await store.ping();
    return ok({
      status: 'ok',
      time: new Date().toISOString(),
      node: process.version,
      capabilities: capabilities(),
      storage: {
        configured: info.configured,
        active: info.active,
        supabaseConfigured: info.supabaseConfigured,
        supabaseError: info.supabaseError ?? null,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
