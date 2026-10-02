/**
 * Konfigurasi basePath.
 *
 * Aturan nilainya:
 *  - Di Vercel (env `VERCEL` diset otomatis) aplikasi selalu dilayani di root
 *    domain, jadi basePath WAJIB ''. Nilai NEXT_PUBLIC_BASE_PATH yang mungkin
 *    masih tertinggal di Environment Variables sengaja DIABAIKAN, karena
 *    ketidakcocokan nilai inilah yang membuat seluruh request API 404
 *    (halaman tampil, tapi fetch ke /agentcloud/api/... tidak ada).
 *  - Di platform yang melayani aplikasi di subpath /agentcloud (production
 *    non-Vercel) basePath diisi /agentcloud saat build DAN saat runtime,
 *    karena Next membakar basePath ke dalam URL aset.
 *  - Development dilayani di root.
 *
 * Override manual (kapan pun perlu): NEXT_PUBLIC_BASE_PATH=/sesuatu
 *   contoh uji build produksi di root: NEXT_PUBLIC_BASE_PATH= npm run build
 */
const isVercel = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
const isProduction = process.env.NODE_ENV === 'production';

const basePath = isVercel ? '' : (process.env.NEXT_PUBLIC_BASE_PATH ?? (isProduction ? '/agentcloud' : ''));

/** Base path juga dideteksi ulang di browser (lib/client.ts) dari URL aset Next. */
/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: basePath || undefined,
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  // Paket native harus tetap di-require dari node_modules (tidak bisa di-bundle).
  // Catatan PENTING: '@e2b/code-interpreter' SENGAJA TIDAK ada di daftar ini.
  // Saat ditandai external, runtime serverless (Vercel) harus menemukan paketnya
  // lewat node_modules dan kegagalan pencarian membuat SELURUH route yang
  // mengimpornya menjawab 500 tanpa pesan jelas. Dengan dibiarkan ter-bundle,
  // SDK ikut ke dalam fungsi route (dan lib/sandbox/manager.ts memuatnya secara
  // lazy + fail-soft, jadi kegagalan tetap terlaporkan sebagai pesan yang jelas).
  serverExternalPackages: ['better-sqlite3', '@supabase/supabase-js'],
  env: {
    // Nilai awal untuk klien; lib/client.ts memverifikasinya lagi saat runtime.
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default nextConfig;
