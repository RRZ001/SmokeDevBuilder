/**
 * basePath: aplikasi ini saat diproduksi berjalan di bawah subpath /agentcloud
 * (mis. https://<domain>/agentcloud), karena platform hosting mem-proxy-nya di
 * subpath tersebut dengan prefix yang tidak dipangkas.
 *
 * PENTING: nilai ini harus SAMA saat `next build` dan saat server dijalankan,
 * karena Next membakar basePath ke dalam URL aset/HTML. Supaya tidak bergantung
 * pada satu env khusus yang mudah terlupa, nilainya ditentukan dari NODE_ENV:
 *   - NODE_ENV=production (build produksi & `npm start`)  -> '/agentcloud'
 *   - NODE_ENV=development (`npm run dev`, uji lokal)     -> '' (root)
 *
 * Bisa dioverride kapan saja, mis. untuk uji build produksi di root:
 *   NEXT_PUBLIC_BASE_PATH= npm start
 */
const isProduction = process.env.NODE_ENV === 'production';
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? (isProduction ? '/agentcloud' : '');

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: '',
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  // Paket native / server-only tetap di-require dari node_modules (tidak di-bundle).
  serverExternalPackages: ['better-sqlite3', '@e2b/code-interpreter', '@supabase/supabase-js'],
  env: {
    // Di-inline ke bundle klien; dipakai lib/client.ts untuk prefix semua fetch.
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default nextConfig;
