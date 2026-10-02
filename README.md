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
| **Proyek tahan sandbox hilang** | File proyek disimpan otomatis ke database dan **dipulihkan ke sandbox baru** — sandbox boleh mati/di-kill/diganti tanpa kehilangan kode. `node_modules` tidak disimpan, jadi setelah restore cukup `npm install` lagi. |
| **Hemat biaya** | Sandbox idle **di-pause** (E2B tidak menagih saat paused) + auto-resume; prompt caching Claude via `cache_control`; `session_id` untuk menjaga cache tetap hangat; isi file lama tidak dikirim ulang ke model; batas token keluaran; **pemakaian token & biaya tiap giliran ditampilkan di UI**. |
| **Retry otomatis** | Error sementara dari OpenRouter (429/5xx) dicoba ulang otomatis 3× dengan menghormati `Retry-After`; statusnya terlihat live di panel chat. |
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
| `AGENT_MAX_OUTPUT_TOKENS` | opsional | Batas token keluaran per langkah, default `8192`. |
| `AGENT_HISTORY_TOOL_DETAILS` | opsional | Hanya N pemanggilan tool terakhir yang isinya dikirim utuh ke model, default `4`. |
| `AGENT_HISTORY_CHAR_BUDGET` | opsional | Batas keras ukuran prompt (karakter), default `60000`. |
| `AGENT_HISTORY_MESSAGES` | opsional | Batas jumlah pesan dalam riwayat, default `24`. |
| `AGENT_TOOL_OUTPUT_CHARS` | opsional | Batas hasil tool yang dikirim balik ke model, default `4000`. |
| `OPENROUTER_BASE_URL` | opsional | Override endpoint OpenRouter (gateway/proxy sendiri). |
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
2. Isi `E2B_API_KEY` sebagai **variabel environment** saat aplikasi di-host (bukan lewat modal Settings — modal itu hanya menampilkan status). Nilainya tidak perlu ditulis di dalam kode.
3. Sandbox default dibuat dengan masa hidup 10 menit dan otomatis diperpanjang setiap kali dipakai; kalau sudah kedaluwarsa, aplikasi otomatis membuat sandbox baru (riwayat chat tetap utuh).

### (Opsional) Template kustom agar sandbox langsung siap
Secara default `lib/sandbox/manager.ts` memeriksa `node -v && npm -v` di sandbox; kalau belum ada, Node.js 20 dipasang otomatis (sekali per sandbox, ~20–40 detik pertama). Untuk menghilangkan waktu tunggu itu, build template kustom:

```bash
npx e2b template init                 # menghasilkan e2b.toml
npx e2b template build                # memakai e2b.Dockerfile (Node.js + Python + git)
# lalu set E2B_TEMPLATE=<nama-template> di environment
```

---

## 7b. Menghemat biaya (OpenRouter & E2B)

Ini praktik yang sudah aktif secara default, plus cara menekan biaya lebih jauh.

### Sandbox E2B: pause, bukan kill
Aplikasi membuat sandbox dengan `lifecycle: { onTimeout: 'pause', autoResume: true }`. Artinya:

- saat idle, sandbox **di-pause** — E2B **tidak menagih selama paused**, dan isinya (file proyek + memori, termasuk dev server yang jalan) tersimpan **tanpa batas waktu**;
- begitu ada aktivitas (kirim pesan, perintah, atau membuka URL preview) sandbox **bangun sendiri** (~1 detik).

Dokumentasi E2B menyatakannya eksplisit: *"You only pay while a sandbox is actively running. Once a sandbox is paused, killed or times out, billing stops immediately."*

Kontrol yang berguna:

| Aksi | Efek |
| --- | --- |
| Diamkan | Setelah `E2B_SANDBOX_TIMEOUT_MS` (default 10 menit) sandbox di-pause, tagihan berhenti |
| Buka preview / kirim pesan | Sandbox bangun sendiri, kerja lanjut dari kondisi terakhir |
| Tombol **Stop** atau hapus proyek | Sandbox di-*kill* permanen: semua file proyek di dalamnya ikut hilang |
| Tombol **Sandbox baru** | Menghapus sandbox lama lalu mulai dari nol. Ada dialog konfirmasi — tombol ini **bukan** cara melanjutkan pekerjaan |

Catatan: saat sandbox paused, URL preview tidak melayani request sampai ada aktivitas yang membangunkannya (klien lama terputus dan perlu connect ulang).

### File proyek disimpan di database (tahan sandbox hilang)

Sandbox E2B bisa hilang: di-*kill*, kedaluwarsa, atau diganti. Tanpa penanganan, seluruh kode proyek ikut hilang dan agent harus membangun ulang dari nol (mahal dan melelahkan). Karena itu file proyek disimpan ke database:

| Kejadian | Yang dilakukan aplikasi |
| --- | --- |
| Setiap giliran agent selesai | Memindai folder proyek, menyimpan file yang **baru/berubah** saja (bandingkan mtime + ukuran) |
| Perintah manual di Terminal | Sama — disimpan setelah perintah selesai (mis. setelah `npx create-next-app`) |
| Kamu menyimpan file dari editor | File itu langsung disimpan ke database |
| Sandbox dibuat/dipulihkan | **Memulihkan** semua file ke sandbox baru, lalu menjalankan `npm install` sebagai langkah pertama |
| Tekan **Stop** / **Sandbox baru** | File disimpan dulu, baru sandbox dihapus |

Yang disimpan hanya file teks proyek. `node_modules`, `.next`, `dist`, `.git`, file biner (gambar), dan file >256 KB **tidak** disimpan — file-file itu bisa dibuat ulang, dan menyimpannya akan membengkakkan database.

Karena `node_modules` tidak ikut, setelah pemulihan **dependency belum terpasang**. Agent sudah diberi tahu hal ini di system prompt, jadi ia menjalankan `npm install` sendiri. Kalau perlu, cukup minta: *"npm install lalu jalankan servernya"*.

> **Wajib satu kali:** tabel penyimpanannya harus dibuat di Supabase. Jalankan isi `supabase/migrations/002_ac_files.sql` di **Supabase → SQL Editor**. Kalau belum, aplikasi tetap jalan (file disimpan sementara di SQLite lokal), dan muncul peringatan di panel chat berisi instruksi ini. Untuk instalasi baru, `supabase/schema.sql` sudah memuat tabel ini.

### Token OpenRouter: yang memakan biaya dan cara menekannya
Penyebab terbesar adalah **isi file yang dikirim ulang**: argumen `write_file` memuat isi file lengkap, dan dalam loop function calling argumen itu wajib dikirim balik di setiap langkah. Yang sudah diterapkan:

1. **Kompaksi riwayat** — hanya `AGENT_HISTORY_TOOL_DETAILS` (default 4) pemanggilan tool terakhir yang isinya dikirim utuh; yang lebih lama diringkas (isi file diganti penanda ukuran). Pada kasus nyata (2 giliran, 10 file ~15 KB per file) ukuran prompt turun dari **175k → 4,3k karakter (~97% lebih kecil, ~41×)** tanpa merusak struktur tool call. Kompaksi dibuat deterministik supaya prefix prompt stabil — kalau prefix berubah tiap request, prompt cache selalu miss dan malah lebih mahal.
2. **Prompt caching** — untuk Claude, penanda `cache_control` dipasang di system prompt dan ujung riwayat. Bagian yang sudah dibaca dibayar **~0,1×** harga input; sangat berpengaruh karena loop agent memanggil tool berkali-kali. Terlihat di UI sebagai *"N% dari cache"*.
3. **`session_id`** — id proyek dikirim sebagai `session_id`, sehingga OpenRouter memakai *sticky routing*: permintaan lanjutan diarahkan ke provider yang sama dan cache tetap hangat.
4. **Batas keluaran** — `AGENT_MAX_OUTPUT_TOKENS` (default 8192) mencegah model "ngobrol panjang" yang dibayar mahal.
5. **Batas hasil tool** — `AGENT_TOOL_OUTPUT_CHARS` (default 4000) agar hasil besar tidak membengkakkan langkah-langkah berikutnya.
6. **Transparansi** — setiap giliran menampilkan token masuk/keluar, persentase cache, dan perkiraan biaya; total sesi tampil sebagai chip di header panel chat.

### Lever yang perlu keputusan kamu
- **Pilih model sesuai tugas.** Model berlabel **hemat** (DeepSeek V3/R1) jauh lebih murah daripada Claude dan cukup untuk scaffold/refactor rutin; pakai Claude untuk arsitektur kompleks atau debugging berliku. Ganti kapan saja di Settings.
- **Pecah tugas besar** menjadi beberapa instruksi. Satu perintah "buat seluruh game lengkap" memicu satu giliran raksasa (banyak langkah, banyak token). "Buat struktur + lobby dulu" lalu "lanjutkan fase malam" jauh lebih hemat dan lebih mudah dikoreksi.
- **Aktifkan auto-debug hanya saat perlu.** Setiap ronde auto-debug menambah satu panggilan model. Kalau kamu ingin memeriksa error lebih dulu, matikan toggle-nya.
- **Jangan minta agent mengulang hal yang sudah dikerjakan.** Kalau sandbox paused, cukup lanjutkan — file masih ada (tidak perlu "tulis ulang semua file").

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

### Deploy ke Vercel (langkah rinci)

1. **Push repo ke GitHub** → di Vercel: **Add New → Project → Import** repo tersebut. Framework terdeteksi otomatis sebagai Next.js; biarkan Build Command `next build` dan Output default. `server.js` **tidak dipakai** Vercel (Vercel punya runtime sendiri) — biarkan saja ada di repo, tidak mengganggu.
2. **Environment Variables** (Project → Settings → Environment Variables):

   | Nama | Nilai | Wajib |
   | --- | --- | --- |
   | `OPENROUTER_API_KEY` | `sk-or-v1-...` | ya (atau isi lewat UI Settings) |
   | `E2B_API_KEY` | `e2b_...` | ya, untuk fitur eksekusi sandbox |
   | `SUPABASE_URL` | `https://xxxx.supabase.co` (persis begini: tanpa kutip/spasi, **bukan** baris `SUPABASE_URL=...` utuh) | **sangat disarankan** di Vercel |
   | `SUPABASE_SERVICE_ROLE_KEY` | service role key | **sangat disarankan** di Vercel |

3. **JANGAN set `NEXT_PUBLIC_BASE_PATH` di Vercel.** Di Vercel aplikasi dilayani di root domain (`https://nama-app.vercel.app/`), jadi base path harus kosong. `next.config.mjs` sudah otomatis mendeteksi Vercel (env `VERCEL`) dan memaksa basePath `''`. Kalau variabel ini masih tertinggal bernilai `/agentcloud`, itulah penyebab klasik **halaman tampil tapi muncul "Gagal memuat workspace — Permintaan gagal (HTTP 404)"** (HTML & aset oke, tapi `fetch` diarahkan ke `/agentcloud/api/...` yang tidak ada). Hapus variabel itu, lalu **Redeploy**.
4. **Penyimpanan di Vercel wajib Supabase.** Kalau Supabase dikonfigurasi tetapi tidak bisa dihubungi, indikator di panel chat berubah menjadi "SQLite (fallback)" + banner peringatan, dan setiap error chat menyebutkan penyebabnya. Tanpa itu aplikasi memakai SQLite di `/tmp` (lihat `DEFAULT_SQLITE_PATH`): cukup untuk mencoba, tapi **tidak persisten** — riwayat chat & daftar proyek hilang saat instance berganti/redeploy. Banner peringatan oranye akan muncul di panel chat selama kondisi ini.
5. **Durasi fungsi.** Vercel membatasi lama eksekusi fungsi (plan Hobby jauh lebih pendek dari Pro). Giliran agent yang meng-`npm install` + menjalankan dev server bisa melewatinya. Atur bila perlu lewat `vercel.json`:
   ```json
   { "functions": { "app/api/chat/route.ts": { "maxDuration": 60 } } }
   ```
   (naikkan sesuai plan kamu; nilai melebihi batas plan akan ditolak Vercel).
6. **Verifikasi setelah deploy:** buka `https://<app>.vercel.app/api/health`. Yang diharapkan:
   - `storage.active`: `"supabase"` (bukan `"sqlite"`) — kalau masih `sqlite` padahal env Supabase sudah diisi, `storage.supabaseError` menjelaskan sebabnya;
   - `e2b.apiKey: true` dan `e2b.sdk.ok: true`.
7. **Catatan sandbox.** SDK E2B sengaja **tidak** dimasukkan ke `serverExternalPackages` supaya ikut ter-bundle ke dalam fungsi server, dan `lib/sandbox/manager.ts` memuatnya secara *lazy + fail-soft*. Jadi kalau sandbox gagal disiapkan, chat tetap jalan dalam **mode diskusi** (dengan pesan jelas), bukan error 500 tanpa keterangan.

### Deploy ke platform yang melayani subpath (mis. `/agentcloud`)
Biarkan default: `npm run build` saat `NODE_ENV=production` memberi basePath `/agentcloud` pada build **dan** saat runtime, lalu publish dengan opsi **preserve_path_prefix** aktif.

---

## 11. Keamanan & batasan

- **Tanpa autentikasi.** Identitas pemilik data berasal dari cookie httpOnly anonim (`ac_owner`, fallback header dari `localStorage`). Ini cukup untuk satu pemakai/satu browser, **bukan** untuk SaaS multi-user. Untuk produksi: aktifkan Supabase Auth, isi `owner_id` dengan `auth.uid()`, dan ganti policy RLS menjadi `auth.uid()::text = owner_id`.
- **API key hanya di server.** Key dibaca dari environment atau tabel `ac_settings`, dan tidak pernah dikirim ke browser (yang dikirim hanya versi tersamar).
- **Pengaman perintah.** `run_command` menolak pola destruktif global (`rm -rf /`, `mkfs`, `shutdown`, `dd of=/dev/...`, fork bomb) dan membatasi path ke `/home/user/**`. Eksekusi tetap terjadi di dalam VM E2B sekali pakai — bukan di server aplikasi.
- **Vercel/serverless: penyimpanan lokal tidak persisten.** `lib/config.ts` mengarahkan SQLite ke `/tmp` saat mendeteksi lingkungan serverless; data bisa hilang antar-instance. Gunakan Supabase untuk data permanen (peringatan tampil otomatis di UI selama belum dihubungkan).
- **Belum ada rate limit / kuota per user.** Tiap pemanggilan model memakai kredit OpenRouter kamu; tambahkan rate limit sebelum dibuka ke publik.
- **Peringatan Node.js 20.** `@supabase/supabase-js` mencetak deprecation warning bila berjalan di Node 20 (aplikasi tetap normal). Node 22+ menghilangkan peringatan ini. Peringatan dari `npm run build` (`@supabase/storage-js` butuh Node ≥ 22) juga hanya informatif.
- **Yang sudah diuji** di workspace ini: build produksi, seluruh route API, streaming NDJSON, persistensi SQLite (dan fallback dari Supabase yang tidak dapat dihubungi), pemuatan daftar model live OpenRouter, tampilan desktop & mobile, serta jalur error (key invalid → pesan 401 yang ramah; tanpa key → mode diskusi). **Belum diuji** karena butuh kredit asli: panggilan model yang sukses, pembuatan sandbox E2B nyata, dan eksekusi perintah di dalamnya.

---

## 12. Troubleshooting

| Gejala | Penyebab & solusi |
| --- | --- |
| Chat menjawab *"OpenRouter API key belum diisi"* | Isi `OPENROUTER_API_KEY` di environment atau lewat modal Settings. |
| Badge panel kode menulis *"Sandbox nonaktif (E2B_API_KEY)"* / agent hanya berdiskusi | `E2B_API_KEY` belum diisi. Pasang sebagai variabel environment di hosting, lalu jalankan ulang aplikasi (modal Settings hanya menampilkan status), lalu klik **Mulai sandbox**. |
| *"OpenRouter menolak API key (401)"* di chat | Key salah/terhapus. Klik **Tes koneksi** di Settings. |
| *"Kredit OpenRouter tidak cukup (402)"* | Isi saldo di <https://openrouter.ai/credits>. |
| *"OpenRouter menolak sementara (429) ... could not verify available credits ... retry shortly"* | Ini **bukan** tanda saldo habis, melainkan throttle sementara di sisi OpenRouter (`openrouter_admission_control`) yang bisa muncul saat permintaan datang bertubi-tubi. Aplikasi otomatis mencoba ulang 3× mengikuti header `Retry-After` (maks 30 detik total), dan status "mencoba lagi dalam N detik" muncul di panel chat. Kalau tetap gagal: tunggu ~1 menit lalu kirim ulang pesan — pekerjaan di sandbox tidak hilang. |
| Model menjawab 404 | Model sudah ditarik (mis. Claude 3.7/3.5 Sonnet). Pilih *Claude Sonnet 4.5* atau klik **Muat live** untuk daftar terbaru. |
| Kartu Settings menulis *"Supabase gagal, fallback otomatis"* | `SUPABASE_URL`/key salah atau project pause. Data tetap tersimpan di SQLite; perbaiki env lalu restart. |
| `/api/health` menulis `supabaseError: "Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL."` | Nilai `SUPABASE_URL` tidak persis. Nilai yang benar hanya satu: `https://<project-ref>.supabase.co` — tanpa tanda kutip, tanpa spasi, dan bukan baris `SUPABASE_URL=...` yang ter-paste utuh. `normalizeSupabaseUrl()` menormalkan semua kesalahan itu otomatis. |
| `/api/health` menulis `supabaseError: "[supabase:ping] Invalid path specified in request URL"` | Nilai `SUPABASE_URL` mengandung **path** (biasanya `/rest/v1` atau `/auth/v1` karena menyalin URL endpoint, bukan Project URL). supabase-js menambahkan `/rest/v1` sendiri sehingga path-nya menjadi ganda. Kode sekarang memangkasnya ke origin saja (`https://<project-ref>.supabase.co`), tapi memperbaiki nilainya tetap disarankan. |
| Kartu Settings: *"SUPABASE_URL ada tapi formatnya tidak sah"* | Nilai tidak bisa diurai menjadi URL yang masuk akal (mis. salah tempel teks lain). Salin ulang **Project URL** dari Supabase → Project Settings → Data API. |
| Di Vercel: proyek & riwayat chat "hilang", chat menjawab *"Proyek tidak ditemukan"* | Supabase belum benar-benar aktif sehingga aplikasi memakai SQLite di `/tmp` yang tidak bertahan antar-instance. Perbaiki `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, pastikan `storage.active: "supabase"` di `/api/health`, lalu muat ulang. |
| Preview kosong / "server belum merespons" | Dev server belum jalan atau salah port. Jalankan dari Terminal: `npm run dev -- --host 0.0.0.0 --port 3000`, lalu klik **Cek status**. |
| Preview tampak "memeriksa…" lalu menampilkan pesan panel sendiri | Normal: server belum listen. URL preview tidak lagi langsung di-iframe-kan, dan status dicek otomatis tiap 4 detik sampai server merespons (maks ~36 detik). |
| Preview menampilkan "Closed Port Error" / "Connection refused on port 3000" | Sandbox hidup tapi belum ada proses yang listen di port itu. Paling sering: aplikasi dibuat di sub-folder lalu server dijalankan tanpa `cwd`. Minta agent menjalankan `start_server` dengan `cwd` folder aplikasinya (mis. `werewolf-game`), atau jawab saja *"jalankan servernya"*. |
| Preview tidak merespons, tapi proyek & file masih ada | Sandbox sedang **di-pause** (hemat biaya). Kirim pesan atau buka ulang URL preview — sandbox bangun sendiri (~1 detik). |
| Biaya OpenRouter terasa cepat habis | Lihat baris *"Pemakaian"* di bawah balasan agent: porsi dari cache (idealnya besar) dan biayanya. Tekan biaya: pilih model berlabel **hemat** (DeepSeek), pecah tugas besar, matikan auto-debug bila tidak perlu. Lihat §7b. |
| Pesan *"Sandbox sudah tidak ada lagi"* di panel file / agent masuk **Mode diskusi** | Sandbox proyek itu sudah dihapus E2B (terjadi pada sandbox yang dibuat sebelum fitur auto-pause aktif), jadi file proyeknya tidak bisa dipulihkan. Klik **Sandbox baru** lalu minta agent membangun ulang. Sandbox yang dibuat setelah pembaruan tidak akan hilang saat idle — ia di-pause dan bangun sendiri. |
| Sandbox membuat ulang terus / lambat di awal | Sandbox E2B kedaluwarsa (normal) atau Node.js sedang dipasang otomatis. Pakai template kustom (§7) untuk startup instan. |
| Halaman tampak tanpa CSS / 404 setelah deploy | basePath build ≠ basePath runtime. Jalankan `npm run build` (NODE_ENV=production ⇒ `/agentcloud`), pastikan server dijalankan dengan `NODE_ENV=production`, lalu deploy ulang. |
| **Di Vercel:** halaman tampil, tapi muncul "Gagal memuat workspace - Permintaan gagal (HTTP 404)" | `NEXT_PUBLIC_BASE_PATH` masih terpasang di Environment Variables Vercel. Hapus variabel itu lalu Redeploy; `lib/client.ts` juga sudah mendeteksi ulang base path dari URL aset sebagai jaring pengaman. |
| **Di Vercel:** route apa pun yang menyentuh sandbox E2B menjawab 500 (termasuk request yang seharusnya 400) | SDK E2B di-`require` dari `node_modules` yang tidak ada di runtime fungsi. Sejak perbaikan ini `@e2b/code-interpreter` tidak lagi di `serverExternalPackages` sehingga ikut ter-bundle (verifikasi: `e2b.sdk.ok` di `/api/health`). |
| **Di Vercel:** riwayat chat/proyek hilang setelah beberapa saat | Hosting serverless tidak punya disk persisten. Isi `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. |

---

## 13. Perintah berguna

```bash
npm run dev            # server pengembangan (custom server, membaca PORT), di root
npm run build          # build produksi (basePath /agentcloud)
npm start              # jalankan build produksi
npm run build:root     # build produksi tanpa basePath (uji di root)
npm run test:files     # uji snapshot & restore file proyek (sandbox tiruan, tanpa kredit E2B)
npm run test:files-fallback  # uji perilaku saat tabel ac_files belum dibuat
npx next lint          # lint (opsional)
```

Data SQLite (mode fallback) tersimpan di `data/agentcloud.sqlite` di dalam folder aplikasi — aman untuk dibackup bersama kodenya, dan otomatis diabaikan Git.
