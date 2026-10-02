-- ===========================================================================
-- AgentCloud - skema Supabase (Postgres)
-- Jalankan seluruh file ini di Supabase Dashboard > SQL Editor > New query.
--
-- Tabel diberi prefix `ac_` supaya aman dipakai bersama aplikasi lain
-- di project Supabase yang sama.
-- ===========================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Pengaturan per pemilik (owner) : API key + model pilihan
-- ---------------------------------------------------------------------------
create table if not exists public.ac_settings (
  owner_id          text primary key,
  openrouter_api_key text not null default '',
  model             text not null default '',
  updated_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Proyek : satu proyek = satu sesi sandbox E2B + riwayat chat
-- ---------------------------------------------------------------------------
create table if not exists public.ac_projects (
  id            uuid primary key default gen_random_uuid(),
  owner_id      text not null,
  name          text not null,
  description   text not null default '',
  sandbox_id    text,                -- id sandbox E2B yang sedang dipakai
  preview_port  integer,             -- port dev server yang di-preview
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_ac_projects_owner
  on public.ac_projects (owner_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- Pesan chat : `parts` menyimpan blok terurut (text/reasoning/tool/notice)
-- supaya UI bisa merender ulang tool call & output terminal.
-- ---------------------------------------------------------------------------
create table if not exists public.ac_messages (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.ac_projects (id) on delete cascade,
  owner_id    text not null,
  role        text not null check (role in ('user', 'assistant', 'system')),
  content     text not null default '',
  parts       jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists idx_ac_messages_project
  on public.ac_messages (project_id, created_at asc);

-- ---------------------------------------------------------------------------
-- File proyek : isi sandbox yang disimpan ke database agar bisa DIPULIHKAN
-- ke sandbox E2B mana pun (sandbox boleh mati tanpa kehilangan kode).
-- Hanya file teks proyek; node_modules/.next/.git tidak disimpan.
-- ---------------------------------------------------------------------------
create table if not exists public.ac_files (
  project_id  uuid not null references public.ac_projects (id) on delete cascade,
  owner_id    text not null,
  path        text not null,
  content     text not null default '',
  size        integer not null default 0,
  mtime       double precision not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (project_id, path)
);

create index if not exists idx_ac_files_owner
  on public.ac_files (owner_id, project_id);

-- ---------------------------------------------------------------------------
-- RLS
--
-- Aplikasi ini BELUM punya autentikasi user (identitas hanya cookie anonim),
-- jadi dua pilihan:
--
-- A. Pakai SERVICE ROLE KEY di server (SUPABASE_SERVICE_ROLE_KEY).
--    Key ini melewati RLS, jadi data hanya bisa diakses lewat backend kamu.
--    -> JANGAN pernah mengirim service role key ke browser.
--
-- B. Pakai ANON KEY. Supaya backend bisa membaca/menulis, aktifkan policy
--    permisif di bawah. Ini artinya siapa pun yang punya anon key bisa
--    membaca seluruh data - hanya cocok untuk single-user / demo internal.
--    Untuk multi-user produksi: tambahkan Supabase Auth, simpan auth.uid()
--    pada kolom owner_id, lalu ganti policy menjadi auth.uid()::text = owner_id.
-- ---------------------------------------------------------------------------

alter table public.ac_settings enable row level security;
alter table public.ac_projects enable row level security;
alter table public.ac_messages enable row level security;
alter table public.ac_files enable row level security;

-- Policy permisif (opsi B). Hapus blok ini kalau memakai service role key.
drop policy if exists ac_settings_all on public.ac_settings;
drop policy if exists ac_projects_all on public.ac_projects;
drop policy if exists ac_messages_all on public.ac_messages;
drop policy if exists ac_files_all on public.ac_files;

create policy ac_settings_all on public.ac_settings
  for all to anon, authenticated using (true) with check (true);

create policy ac_projects_all on public.ac_projects
  for all to anon, authenticated using (true) with check (true);

create policy ac_messages_all on public.ac_messages
  for all to anon, authenticated using (true) with check (true);

create policy ac_files_all on public.ac_files
  for all to anon, authenticated using (true) with check (true);
