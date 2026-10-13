-- ===========================================================================
-- Migration 003: deploy ke Vercel dari dalam AgentCloud
--
-- TUJUAN: agent bisa men-deploy aplikasi yang dibangunnya ke akun Vercel MILIK
-- USER, sehingga hasil kerjanya punya LINK PERMANEN (mis. proyek.vercel.app)
-- yang tetap hidup walaupun sandbox E2B di-pause/dimatikan. Sandbox hanya untuk
-- mengembangkan & melihat preview selama proses pengerjaan.
--
-- JALANKAN: Supabase Dashboard -> SQL Editor -> New query -> tempel seluruh file
-- ini -> Run. Aman dijalankan berulang kali (idempotent).
-- ===========================================================================

-- Token deploy disimpan per owner, di database (pilihan user: lewat Settings).
-- Nilainya TIDAK pernah dikirim ke browser (UI hanya menerima cuplikan bertopeng)
-- dan tidak pernah masuk ke konteks model.
alter table public.ac_settings
  add column if not exists vercel_token text not null default '';

-- Scope/team slug Vercel (opsional, mis. "tim-saya").
alter table public.ac_settings
  add column if not exists vercel_scope text not null default '';

-- Hasil deploy terakhir per proyek: link permanennya ditampilkan di panel Preview.
alter table public.ac_projects
  add column if not exists deploy_url text;

alter table public.ac_projects
  add column if not exists deploy_at timestamptz;
