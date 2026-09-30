import { SUPABASE_KEY, SUPABASE_URL, SUPABASE_USES_SERVICE_ROLE } from '@/lib/config';
import { getSqliteStore, SqliteStore } from './sqlite';
import { getSupabaseClient, SupabaseStore } from './supabase';
import type { Store } from './types';

export * from './types';
export { getSqliteStore, SqliteStore } from './sqlite';
export { getSupabaseClient, SupabaseStore } from './supabase';

export type StoreDriver = 'supabase' | 'sqlite';

export type StoreInfo = {
  configured: StoreDriver;
  active: StoreDriver;
  supabaseConfigured: boolean;
  supabaseRole: string;
  supabaseError?: string;
  sqlitePath: string;
};

const HEALTH_TTL_MS = 60_000;
const globalForStore = globalThis as unknown as {
  __acStore?: Store;
  __acStoreInfo?: StoreInfo;
  __acHealthAt?: number;
};

/**
 * Proxy yang mencoba driver utama (Supabase) lalu otomatis jatuh ke SQLite
 * kalau pemanggilan gagal - inilah "fallback otomatis" yang diminta:
 * aplikasi tetap jalan penuh walau Supabase belum diisi / sedang down.
 */
function withFallback(primary: Store, fallback: Store): Store {
  const markBroken = (method: string, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[store] Supabase gagal pada ${method}(), memakai SQLite. Penyebab: ${message}`);
    if (globalForStore.__acStoreInfo) {
      globalForStore.__acStoreInfo.active = 'sqlite';
      globalForStore.__acStoreInfo.supabaseError = message;
    }
  };

  return new Proxy(primary, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const invokeFallback = () => {
          const fn = (fallback as unknown as Record<string, unknown>)[String(prop)];
          if (typeof fn !== 'function') throw new Error(`SQLite tidak mendukung method ${String(prop)}`);
          return (fn as (...a: unknown[]) => unknown).apply(fallback, args);
        };
        let result: unknown;
        try {
          result = (value as (...a: unknown[]) => unknown).apply(target, args);
        } catch (err) {
          markBroken(String(prop), err);
          return Promise.resolve(invokeFallback());
        }
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          return (result as Promise<unknown>).catch((err) => {
            markBroken(String(prop), err);
            return invokeFallback();
          });
        }
        return result;
      };
    },
  });
}

let cachedSqlite: SqliteStore | null = null;

function sqliteStore(): SqliteStore {
  if (!cachedSqlite) cachedSqlite = getSqliteStore();
  return cachedSqlite;
}

/** Store singleton + hasil probe kesehatan Supabase (di-cache 60 detik). */
export async function getStore(): Promise<{ store: Store; info: StoreInfo }> {
  const fallback = sqliteStore();
  const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY);

  if (!supabaseConfigured) {
    const info: StoreInfo = {
      configured: 'sqlite',
      active: 'sqlite',
      supabaseConfigured: false,
      supabaseRole: 'none',
      sqlitePath: fallback.path,
    };
    globalForStore.__acStore = fallback;
    globalForStore.__acStoreInfo = info;
    return { store: fallback, info };
  }

  const now = Date.now();
  if (!globalForStore.__acStore || !globalForStore.__acHealthAt || now - globalForStore.__acHealthAt > HEALTH_TTL_MS) {
    const client = await getSupabaseClient();
    let info: StoreInfo;
    if (!client) {
      info = {
        configured: 'sqlite',
        active: 'sqlite',
        supabaseConfigured: false,
        supabaseRole: 'none',
        sqlitePath: fallback.path,
      };
      globalForStore.__acStore = fallback;
    } else {
      const primary = new SupabaseStore(client);
      let healthy = true;
      let error: string | undefined;
      try {
        await primary.ping();
      } catch (err) {
        healthy = false;
        error = err instanceof Error ? err.message : String(err);
        console.warn(`[store] Supabase tidak bisa dipakai (${error}). Fallback ke SQLite.`);
      }
      info = {
        configured: 'supabase',
        active: healthy ? 'supabase' : 'sqlite',
        supabaseConfigured: true,
        supabaseRole: SUPABASE_USES_SERVICE_ROLE ? 'service_role' : 'anon',
        supabaseError: error,
        sqlitePath: fallback.path,
      };
      globalForStore.__acStore = healthy ? withFallback(primary, fallback) : fallback;
    }
    globalForStore.__acStoreInfo = info;
    globalForStore.__acHealthAt = now;
  }

  return {
    store: globalForStore.__acStore ?? fallback,
    info:
      globalForStore.__acStoreInfo ??
      ({
        configured: 'sqlite',
        active: 'sqlite',
        supabaseConfigured: false,
        supabaseRole: 'none',
        sqlitePath: fallback.path,
      } as StoreInfo),
  };
}
