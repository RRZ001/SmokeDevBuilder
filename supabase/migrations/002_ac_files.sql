-- ===========================================================================
-- Migration 002: penyimpanan file proyek (tabel ac_files)
--
-- TUJUAN: file proyek (kode) disimpan di database, sehingga bisa DIPULIHKAN ke
-- sandbox E2B mana pun. Sandbox boleh mati kapan saja tanpa kehilangan pekerjaan
-- dan tanpa perlu membangun ulang proyek dari nol.
--
-- JALANKAN: Supabase Dashboard -> SQL Editor -> New query -> tempel seluruh file
-- ini -> Run. Aman dijalankan berulang kali (idempotent).
-- ===========================================================================

create table if not exists public.ac_files (
  project_id  uuid not null references public.ac_projects (id) on delete cascade,
  owner_id    text not null,
  path        text not null,               -- relatif terhadap folder proyek
  content     text not null default '',    -- isi file (teks)
  size        integer not null default 0,  -- ukuran byte
  mtime       double precision not null default 0,  -- waktu modifikasi (epoch detik)
  updated_at  timestamptz not null default now(),
  primary key (project_id, path)
);

create index if not exists idx_ac_files_owner
  on public.ac_files (owner_id, project_id);

-- RLS: sama seperti tabel lain - aplikasi memakai service role key, jadi policy
-- permisif ini hanya relevan bila kamu memakai anon key.
alter table public.ac_files enable row level security;

drop policy if exists ac_files_all on public.ac_files;

create policy ac_files_all on public.ac_files
  for all to anon, authenticated using (true) with check (true);
