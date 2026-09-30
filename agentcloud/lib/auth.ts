import { cookies, headers } from 'next/headers';
import { randomUUID } from 'node:crypto';

export const OWNER_COOKIE = 'ac_owner';
const OWNER_HEADER = 'x-ac-owner';
const VALID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Identitas pemilik data (namespace), bukan autentikasi.
 *
 * Aplikasi ini belum memakai Supabase Auth, jadi data di-namespace per-browser:
 *  1. cookie httpOnly `ac_owner` (di-set pada request pertama),
 *  2. fallback header `x-ac-owner` yang dikirim klien dari localStorage
 *     (berguna kalau cookie diblokir),
 *  3. fallback terakhir: id baru.
 *
 * Untuk multi-user sungguhan, ganti dengan Supabase Auth (lihat README).
 */
export async function resolveOwnerId(): Promise<string> {
  const cookieStore = await cookies();
  const fromCookie = cookieStore.get(OWNER_COOKIE)?.value;
  if (fromCookie && VALID.test(fromCookie)) return fromCookie;

  const h = await headers();
  const fromHeader = h.get(OWNER_HEADER);
  const owner = fromHeader && VALID.test(fromHeader) ? fromHeader : randomUUID();

  // Sinkronkan ke cookie supaya request berikutnya konsisten.
  // `cookies().set` hanya valid di Route Handler / Server Action, jadi error-nya
  // dijaga (kalau gagal, header klien tetap menjaga konsistensi owner).
  try {
    cookieStore.set({
      name: OWNER_COOKIE,
      value: owner,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    });
  } catch {
    /* Server Component: abaikan, cookie akan di-set oleh route handler */
  }

  return owner;
}
