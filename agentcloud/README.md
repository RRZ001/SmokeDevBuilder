# AgentCloud — Cloud AI Coding Agent

Agent coding AI yang **bekerja**, bukan cuma menulis contoh kode: setiap sesi proyek mendapat **Linux VM terisolasi di cloud (E2B Sandbox)**, tempat agent bisa menjalankan perintah terminal, menulis/mengedit file, menjalankan dev server, memperbaiki error-nya sendiri, dan menampilkan **live preview** di dalam aplikasi.

Stack: **Next.js 15 (App Router) + React 19 + Tailwind CSS + Supabase (fallback otomatis ke SQLite) + E2B Sandbox + OpenRouter**. 

---

## 1. Fitur

| Area | Detail |
| --- | --- |
| **Agent loop** | Function calling OpenRouter: model memutuskan kapan menjalankan terminal, menulis file, atau bertanya balik ke kamu. Maksimal 12 langkah per giliran (`AGENT_MAX_STEPS`). |
| **Cloud sandbox** | Satu proyek = satu sandbox E2B. Sandbox id disimpan di database, jadi sesi bisa disambung ulang (dan otomatis dibuat baru kalau sudah kedaluwarsa). |
| **Tool eksekusi** | `run_command`, `write_file`, `read_file`, `list_files`, `start_server`, `stop_server`, `get_preview_url`. |
| **Auto-debugging** | Kalau sebuah perintah keluar dengan exit code ≠ 0, output error otomatis dikirim balik ke model sebagai instruksi perbaikan (maksimal 2 ronde berturut-turut, bisa dimatikan lewat toggle **Auto-debug**). |
| **Reasoning** | Delta `reasoning`/`reasoning_content` OpenRouter (DeepSeek-R1 dll) dirender sebagai blok "Proses berpikir model" yang bisa dilipat. |
| **Live preview** | iframe ke `https://<port>-<sandbox-id>.e2b.dev`, plus tombol cek status HTTP dan ganti port. |
| **Editor** | File tree sandbox + penampil kode dengan syntax highlighting; kamu juga bisa mengedit dan menyimpan kembali ke sandbox. |
| **Terminal manual** | Terminal di panel kode untuk menjalankan perintah sendiri di sandbox (output di-stream realtime). |
| **Persistence** | Riwayat chat (termasuk kartu tool call + outputnya), daftar proyek, dan konfigurasi disimpan ke **Supabase**; kalau Supabase belum diisi atau sedang tidak bisa diakses, otomatis **fallback ke SQLite** tanpa kehilangan fitur. |
| **Settings modal** | Input OpenRouter API key, pemilih model (katalog + **ratusan model live** dari OpenRouter, ada pencarian), tombol tes koneksi, dan status tiap layanan. |
| **Tanpa key pun jalan** | Tanpa `OPENROUTER_API_KEY` → chat memberi pesan jelas (bukan crash). Tanpa `E2B_API_KEY` → agent otomatis masuk **mode diskusi** (merancang & menulis kode di chat, tanpa eksekusi). |

### Model yang tersedia
Katalog bawaan (`lib/models.ts`): **Claude Sonnet 4.5** (rekomendasi, pengganti Claude 3.7 Sonnet), Claude Sonnet 4, **Claude 3.7 Sonnet & Claude 3.5 Sonnet** (ditandai `arsip` — sudah ditarik dari OpenRouter), **DeepSeek V3 / V3.1**, **DeepSeek R1 / R1-0528**, **GPT-4o**, **GPT-4o mini**, plus seluruh model live dari OpenRouter.

> Catatan: per September 2026 OpenRouter sudah **menghapus** `anthropic/claude-3.7-sonnet` dan `anthropic/claude-3.5-sonnet`. Keduanya tetap ditampilkan di dropdown (dengan badge "arsip" + peringatan) supaya kamu tahu statusnya, tapi akan menjawab HTTP 404 kalau dipilih. Tombol **"Muat live"** di Settings memuat daftar model terkini langsung dari OpenRouter, jadi daftarnya tidak pernah basi.

---

## 2. Arsitektur 

```
┌─────────────── Browser (React) ───────────────┐
│  ProjectRail │ CodePanel (gelap) │ ChatPanel  │
│   Editor / Terminal / Preview iframe          │
└───────┬───────────────────────────────┬───────┘
        │ fetch NDJSON (stream)         │ REST
        ▼                               ▼
┌──────────────────── Next.js Route Handlers (server) ─────────────────────┐
│  /api/chat      → lib/agent/loop.ts: model ⇄ tool ⇄ sandbox              │
│  /api/.../sandbox/* → lib/sandbox/{manager,tools}.ts                     │
│  /api/settings | /api/models | /api/projects | /api/.../messages         │
│  lib/db/index.ts → Supabase  ──gagal?──▶  SQLite (fallback otomatis)     │
└───────┬────────────────────────────────────┬─────────────────────────────┘
        │ HTTPS                              │ HTTPS
        ▼                                    ▼
┌──────────────────┐                ┌──────────────────────────┐
│  OpenRouter      │                │  E2B Cloud Sandbox (VM)  │
│  chat/completions│                │  bash, files, dev server │
│  (streaming +    │                │  preview: <port>-<id>    │
│   tool calling)  │                │  .e2b.dev                │
└──────────────────┘                └──────────────────────────┘
```

Satu giliran percakapan:

1. `POST /api/chat` menyimpan pesan user, merekonstruksi riwayat (termasuk tool call lama) dari kolom `parts`, lalu membuka sandbox + memastikan Node.js tersedia.
2. `runAgent()` memanggil OpenRouter dengan `tools`. Setiap delta teks/reasoning/tool di-stream ke browser sebagai NDJSON.
3. Tool dijalankan di dalam sandbox; output-nya di-stream live ke UI **dan** dikirim balik ke model sebagai pesan `tool`.
4. Kalau ada perintah gagal → pesan auto-debug dikirim, loop lanjut (model memperbaiki).
5. Setelah selesai, jawaban + seluruh blok (teks, reasoning, kartu tool, notice) disimpan ke database.

---

## 3. Struktur kode

```
agentcloud/
├── app/
│   ├── layout.tsx / globals.css / page.tsx     # shell + tema (gelap) + entry UI
│   └── api/
│       ├── bootstrap/route.ts                  # identitas sesi + settings + proyek + kapabilitas
│       ├── chat/route.ts                       # ★ stream NDJSON agent (loop utama)
│       ├── settings/route.ts                   # simpan API key/model + tes koneksi
│       ├── models/route.ts                     # katalog + daftar model live OpenRouter
│       ├── health/route.ts                     # status runtime & storage
│       └── projects/
│           ├── route.ts                        # list & buat proyek
│           └── [id]/
│               ├── route.ts                    # detail / rename / hapus (kill sandbox)
│               ├── messages/route.ts           # riwayat chat (GET / DELETE)
│               └── sandbox/
│                   ├── route.ts                 # start / reset / stop sandbox (stream)
│                   ├── exec/route.ts            # terminal manual (stream)
│                   ├── files/route.ts           # daftar file untuk file tree
│                   ├── file/route.ts            # baca (GET) & simpan (PUT) file
│                   └── preview/route.ts         # URL preview + status HTTP + set port
├── components/
│   ├── Workspace.tsx            # orkestrasi state + konsumsi stream NDJSON
│   ├── ProjectRail.tsx          # daftar & pembuatan proyek (panel gelap)
│   ├── CodePanel.tsx            # tab Editor / Terminal / Preview + kontrol sandbox
│   ├── FileTree.tsx             # file tree dari daftar file sandbox
│   ├── CodeViewer.tsx           # syntax highlighting (highlight.js) + mode edit & simpan
│   ├── TerminalPanel.tsx        # terminal sandbox interaktif
│   ├── PreviewPanel.tsx         # iframe live preview + cek status
│   ├── ChatPanel.tsx            # panel chat terang + composer + toggle auto-debug
│   ├── MessageItem.tsx          # render blok: markdown, reasoning, kartu tool, notice
│   ├── Markdown.tsx             # markdown + GFM + code highlighting
│   ├── SettingsModal.tsx        # API key, pemilih model, status layanan
│   ├── icons.tsx / types.ts     # ikon SVG inline + tipe UI (tree builder)
├── lib/
│   ├── agent/
│   │   ├── loop.ts              # ★ agentic loop + auto-debug + budget langkah
│   │   ├── openrouter.ts        # klien streaming chat/completions + pemetaan error
│   │   ├── history.ts           # rekonstruksi riwayat model dari blok UI
│   │   └── prompt.ts            # system prompt (mode agent & mode diskusi)
│   ├── sandbox/
│   │   ├── manager.ts           # create/connect/kill sandbox + pemasangan Node.js
│   │   └── tools.ts             # definisi 7 tool + eksekutor + pengaman perintah
│   ├── db/
│   │   ├── index.ts             # pemilih driver + fallback otomatis (Proxy)
│   │   ├── supabase.ts          # driver Supabase (import lazy)
│   │   ├── sqlite.ts            # driver SQLite (better-sqlite3, WAL)
│   │   └── types.ts             # kontrak Store + tipe data
│   ├── api.ts                   # helper respons JSON + NDJSON stream
│   ├── auth.ts                  # identitas owner (cookie httpOnly + fallback header)
│   ├── client.ts                # helper fetch klien (basePath + header owner + stream)
│   ├── config.ts / models.ts / session.ts / util.ts / projects.ts
├── supabase/schema.sql          # skema Postgres + policy RLS
├── e2b.Dockerfile               # (opsional) template sandbox dengan Node.js siap pakai
├── server.js                    # custom server: membaca PORT dari environment
├── next.config.mjs              # basePath (untuk deploy di subpath) + serverExternalPackages
└── .env.example                 # daftar environment variable
```

---

## 4. Setup cepat

```bash
# 1. install dependency
npm install

# 2. siapkan environment
cp .env.example .env.local     # lalu isi minimal OPENROUTER_API_KEY
                               # (atau isi lewat UI Settings setelah app jalan)

# 3. mode pengembangan
npm run dev                    # http://localhost:3000

# 4. build produksi
npm run build && npm start
```

> API key boleh diisi dari dua tempat: **environment** (lebih diprioritaskan) atau **modal Settings** di aplikasi (disimpan di tabel `ac_settings`). Key **tidak pernah** dikirim balik ke browser — yang dikirim hanya versi tersamar (`sk-or-v••••2345`).

---

## 5. Environment variables

| Variable | Wajib | Keterangan |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | disarankan | Key dari <https://openrouter.ai/keys>. Dipakai untuk semua panggilan model. Boleh dikosongkan bila ingin mengisi lewat UI Settings. |
| `E2B_API_KEY` | untuk eksekusi | Key dari <https://e2b.dev/dashboard>. Tanpa ini agent jalan di **mode diskusi** (tanpa sandbox/terminal/preview). |
| `SUPABASE_URL` | opsional | `https://<project-ref>.supabase.co`. Kosong ⇒ otomatis pakai SQLite lokal. |
| `SUPABASE_SERVICE_ROLE_KEY` | opsional | Disarankan untuk backend (melewati RLS, tetap di server). |
| `SUPABASE_ANON_KEY` | opsional | Alternatif service role; butuh policy permisif di `supabase/schema.sql`. |
| `E2B_SANDBOX_TIMEOUT_MS` | opsional | Masa hidup sandbox, default `600000` (10 menit). Perpanjang otomatis selama dipakai. |
| `E2B_TEMPLATE` | opsional | Nama template E2B kustom (lihat `e2b.Dockerfile`) supaya Node.js sudah terpasang sejak awal. |
| `AGENT_MAX_STEPS` | opsional | Batas langkah tool per giliran, default `12`. |
| `AGENT_MAX_AUTO_DEBUG` | opsional | Batas ronde auto-debug, default `2`. |
| `OPENROUTER_SITE_URL` / `OPENROUTER_APP_NAME` | opsional | Header atribusi OpenRouter. |
| `AGENTCLOUD_DB_PATH` | opsional | Lokasi file SQLite (default `./data/agentcloud.sqlite`). |
| `SANDBOX_PROJECT_DIR` | opsional | Folder kerja di dalam sandbox, default `/home/user/project`. |
| `NEXT_PUBLIC_BASE_PATH` | deploy | Isi dengan `/<nama-app>` saat dipublish di subpath (lihat §10). |

---

## 6. Setup Supabase (opsional tapi disarankan)

1. Buat project baru di <https://supabase.com> (gratis).
2. Buka **SQL Editor → New query**, tempel seluruh isi `supabase/schema.sql`, lalu **Run**. Ini membuat tabel `ac_settings`, `ac_projects`, `ac_messages` (prefix `ac_` agar aman dipakai bersama aplikasi lain).
3. Buka **Project Settings → API**, salin:
   - `Project URL` → `SUPABASE_URL`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (jangan pernah ditaruh di kode klien)
4. Restart aplikasi. Cek `GET /api/health` — `storage.active` harus berubah menjadi `"supabase"`.

Kalau Supabase tidak bisa dihubungi (URL salah, key salah, atau kuota habis), aplikasi **tidak mati**: `lib/db/index.ts` menangkap error, menulis log peringatan, lalu melanjutkan dengan SQLite. Status ini tampil di modal Settings (kartu **Penyimpanan**).

---

## 7. Setup E2B (Cloud Sandbox)

1. Daftar di <https://e2b.dev>, lalu salin API key dari dashboard.
2. Isi `E2B_API_KEY` di environment **atau** di modal Settings (untuk kenyamanan, environment lebih rapi karena tidak tersimpan di database).
3. Sandbox default dibuat dengan masa hidup 10 menit dan otomatis diperpanjang setiap kali dipakai; kalau sudah kedaluwarsa, aplikasi otomatis membuat sandbox baru (riwayat chat tetap utuh).

### (Opsional) Template kustom agar sandbox langsung siap
Secara default `lib/sandbox/manager.ts` memeriksa `node -v && npm -v` di sandbox; kalau belum ada, Node.js 20 dipasang otomatis (sekali per sandbox, ~20–40 detik pertama). Untuk menghilangkan waktu tunggu itu, build template kustom:

```bash
npx e2b template init                 # menghasilkan e2b.toml
npx e2b template build                # memakai e2b.Dockerfile (Node.js + Python + git)
# lalu set E2B_TEMPLATE=<nama-template> di environment
```

---

## 8. Cara pakai

1. **Settings** — tempelkan OpenRouter API key, pilih model (mis. *Claude Sonnet 4.5*), klik **Tes koneksi** untuk memastikan key + model valid, lalu **Simpan**.
2. **Buat proyek** di panel kiri (satu proyek = satu sandbox + satu riwayat chat).
3. **Tulis instruksi** seperti ke developer, mis. *"Buatkan todo app React + Tailwind, jalankan di port 3000."* Agent akan:
   - bertanya dulu kalau instruksinya ambigu (maksimal 3 pertanyaan singkat + usulan default),
   - menulis file di `/home/user/project` di dalam sandbox,
   - menjalankan `npm install`, `npm run dev`, dan `curl` untuk verifikasi,
   - memperbaiki sendiri error yang muncul,
   - menampilkan hasilnya di tab **Preview**.
4. **Pantau pekerjaannya** lewat kartu tool di panel chat (klik untuk melihat output lengkap), tab **Editor** untuk melihat file yang ditulis/diedit, dan tab **Terminal** untuk menjalankan perintah sendiri.
5. Butuh berhenti di tengah jalan? Tombol **Stop** membatalkan stream (jawaban yang sudah masuk tetap disimpan). Toggle **Auto-debug** bisa dimatikan bila ingin agent berhenti pada error pertama.

Endpoint berguna untuk diagnosa: `GET /api/health` (runtime + driver storage), `GET /api/models` (jumlah model live OpenRouter).

---

## 9. Referensi API

| Endpoint | Method | Fungsi |
| --- | --- | --- |
| `/api/bootstrap` | GET | Identitas sesi, settings, daftar proyek, kapabilitas + driver storage aktif. |
| `/api/settings` | GET / POST | Baca/simpan model & API key. `{"action":"test"}` untuk uji key+model. |
| `/api/models` | GET | Katalog bawaan + seluruh model live OpenRouter (cache 10 menit). |
| `/api/projects` | GET / POST | Daftar / buat proyek. |
| `/api/projects/:id` | GET / PATCH / DELETE | Detail, ubah nama/deskripsi, hapus (sekaligus mematikan sandbox). |
| `/api/projects/:id/messages` | GET / DELETE | Riwayat chat (isi kolom `parts`) / bersihkan riwayat. |
| `/api/chat` | POST | **Stream NDJSON** agent. Body: `{ projectId, message, autoDebug? }`. |
| `/api/projects/:id/sandbox` | GET / POST | Status sandbox; `{action:"start"\|"reset"\|"stop"}` (stream NDJSON). |
| `/api/projects/:id/sandbox/exec` | POST | Jalankan perintah manual di sandbox (stream NDJSON). |
| `/api/projects/:id/sandbox/files` | GET | Daftar file proyek (untuk file tree). |
| `/api/projects/:id/sandbox/file` | GET / PUT | Baca (`?path=`) / simpan (`{path, content}`) satu file. |
| `/api/projects/:id/sandbox/preview` | GET / POST | URL preview + status HTTP; POST untuk set port. |
| `/api/health` | GET | Status runtime, kapabilitas, dan driver storage. |

**Event NDJSON** dari `/api/chat`: `message`, `model`, `status`, `mode`, `sandbox`, `project`, `log`, `text`, `reasoning`, `tool_start`, `tool_output`, `tool_result`, `preview`, `usage`, `error`, `saved`, `done`.

**Tool agent** (`lib/sandbox/tools.ts`): `run_command`, `write_file`, `read_file`, `list_files`, `start_server`, `stop_server`, `get_preview_url`.

---

## 10. Deploy

### Build produksi
```bash
npm run build          # build produksi (basePath /agentcloud, lihat catatan di bawah)
npm start              # node server.js, membaca PORT dari environment
```

`server.js` adalah custom server (`next()` + `http.createServer`) supaya platform hosting bisa menjalankan `node server.js` dengan `PORT` yang diberikan. Platform mengeset `NODE_ENV=production`, sehingga server memakai hasil build produksi — jadi **selalu `npm run build` sebelum deploy** agar output tidak basi.

### basePath (penting!)
Next.js membakar URL aset + navigasi ke dalam hasil build, jadi base path harus **identik antara `next build` dan saat server jalan**. Karena itu `next.config.mjs` menentukannya dari `NODE_ENV`:

| Mode | basePath | URL aplikasi |
| --- | --- | --- |
| `npm run dev` (development) | `` (kosong) | `http://localhost:3000/` |
| `npm run build` + `npm start` (production) | `/agentcloud` | `https://domain/agentcloud` |

Ingin menjalankan build produksi di root (mis. untuk uji lokal)? Override nilainya:
```bash
npm run build:root     # NEXT_PUBLIC_BASE_PATH= next build
NEXT_PUBLIC_BASE_PATH= npm start
```

Seluruh panggilan API sisi klien memakai `BASE` dari `lib/client.ts` (`process.env.NEXT_PUBLIC_BASE_PATH`) sehingga otomatis ikut menyesuaikan — jangan pernah menulis fetch dengan path absolut (`/api/...`) di komponen klien.

Saat mempublikasikan app Node.js yang berjalan di subpath seperti ini, aktifkan opsi **preserve_path_prefix** agar request diterima apa adanya beserta prefix `/agentcloud`.

### Environment di platform hosting
Isi minimal `OPENROUTER_API_KEY` dan `E2B_API_KEY` (plus `SUPABASE_*` bila dipakai) di panel environment platform — nilainya **tidak perlu** ditulis di dalam kode.

---

## 11. Keamanan & batasan

- **Tanpa autentikasi.** Identitas pemilik data berasal dari cookie httpOnly anonim (`ac_owner`, fallback header dari `localStorage`). Ini cukup untuk satu pemakai/satu browser, **bukan** untuk SaaS multi-user. Untuk produksi: aktifkan Supabase Auth, isi `owner_id` dengan `auth.uid()`, dan ganti policy RLS menjadi `auth.uid()::text = owner_id`.
- **API key hanya di server.** Key dibaca dari environment atau tabel `ac_settings`, dan tidak pernah dikirim ke browser (yang dikirim hanya versi tersamar).
- **Pengaman perintah.** `run_command` menolak pola destruktif global (`rm -rf /`, `mkfs`, `shutdown`, `dd of=/dev/...`, fork bomb) dan membatasi path ke `/home/user/**`. Eksekusi tetap terjadi di dalam VM E2B sekali pakai — bukan di server aplikasi.
- **Belum ada rate limit / kuota per user.** Tiap pemanggilan model memakai kredit OpenRouter kamu; tambahkan rate limit sebelum dibuka ke publik.
- **Peringatan Node.js 20.** `@supabase/supabase-js` mencetak deprecation warning bila berjalan di Node 20 (aplikasi tetap normal). Node 22+ menghilangkan peringatan ini. Peringatan dari `npm run build` (`@supabase/storage-js` butuh Node ≥ 22) juga hanya informatif.
- **Yang sudah diuji** di workspace ini: build produksi, seluruh route API, streaming NDJSON, persistensi SQLite (dan fallback dari Supabase yang tidak dapat dihubungi), pemuatan daftar model live OpenRouter, tampilan desktop & mobile, serta jalur error (key invalid → pesan 401 yang ramah; tanpa key → mode diskusi). **Belum diuji** karena butuh kredit asli: panggilan model yang sukses, pembuatan sandbox E2B nyata, dan eksekusi perintah di dalamnya.

---

## 12. Troubleshooting

| Gejala | Penyebab & solusi |
| --- | --- |
| Chat menjawab *"OpenRouter API key belum diisi"* | Isi `OPENROUTER_API_KEY` di environment atau lewat modal Settings. |
| Badge panel kode menulis *"sandbox mati"* / agent hanya berdiskusi | `E2B_API_KEY` belum diisi. Isi, lalu klik **Mulai sandbox**. |
| *"OpenRouter menolak API key (401)"* di chat | Key salah/terhapus. Klik **Tes koneksi** di Settings. |
| *"Kredit OpenRouter tidak cukup (402)"* | Isi saldo di <https://openrouter.ai/credits>. |
| Model menjawab 404 | Model sudah ditarik (mis. Claude 3.7/3.5 Sonnet). Pilih *Claude Sonnet 4.5* atau klik **Muat live** untuk daftar terbaru. |
| Kartu Settings menulis *"Supabase gagal, fallback otomatis"* | `SUPABASE_URL`/key salah atau project pause. Data tetap tersimpan di SQLite; perbaiki env lalu restart. |
| Preview kosong / "server belum merespons" | Dev server belum jalan atau salah port. Jalankan dari Terminal: `npm run dev -- --host 0.0.0.0 --port 3000`, lalu klik **Cek status**. |
| Sandbox membuat ulang terus / lambat di awal | Sandbox E2B kedaluwarsa (normal) atau Node.js sedang dipasang otomatis. Pakai template kustom (§7) untuk startup instan. |
| Halaman tampak tanpa CSS / 404 setelah deploy | basePath build ≠ basePath runtime. Jalankan `npm run build` (NODE_ENV=production ⇒ `/agentcloud`), pastikan server dijalankan dengan `NODE_ENV=production`, lalu deploy ulang. |

---

## 13. Perintah berguna

```bash
npm run dev            # server pengembangan (custom server, membaca PORT), di root
npm run build          # build produksi (basePath /agentcloud)
npm start              # jalankan build produksi
npm run build:root     # build produksi tanpa basePath (uji di root)
npx next lint          # lint (opsional)
```

Data SQLite (mode fallback) tersimpan di `data/agentcloud.sqlite` di dalam folder aplikasi — aman untuk dibackup bersama kodenya, dan otomatis diabaikan Git.
