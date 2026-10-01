import { capabilities, SUPABASE_URL } from '@/lib/config';
import { getStore } from '@/lib/db';
import { errorResponse, ok } from '@/lib/api';
import { e2bSdkStatus } from '@/lib/sandbox/manager';

export const dynamic = 'force-dynamic';

/**
 * Diagnosa cepat - berguna terutama setelah deploy:
 *  - `capabilities`    : key yang terbaca dari environment
 *  - `storage`         : driver yang benar-benar dipakai (Supabase/SQLite)
 *  - `e2b.sdk`         : apakah SDK sandbox berhasil dimuat di runtime ini
 */
export async function GET() {
  try {
    const { info, store } = await getStore();
    await store.ping();
    const e2b = await e2bSdkStatus();
    const caps = capabilities(info.active);
    return ok({
      status: 'ok',
      time: new Date().toISOString(),
      node: process.version,
      capabilities: caps,
      storage: {
        configured: info.configured,
        active: info.active,
        supabaseConfigured: info.supabaseConfigured,
        /** Host Supabase yang benar-benar dipakai (memudahkan verifikasi project). */
        supabaseHost: SUPABASE_URL ? new URL(SUPABASE_URL).host : null,
        supabaseError: info.supabaseError ?? null,
        sqlitePath: info.sqlitePath,
      },
      e2b: { apiKey: caps.e2bFromEnv, sdk: e2b },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
