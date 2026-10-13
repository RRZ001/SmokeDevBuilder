/**
 * Panduan desain untuk aplikasi yang DI-generate agent.
 *
 * Kenapa ada: system prompt sebelumnya tidak memuat satu pun aturan desain, jadi
 * agent selalu menulis "layout default"-nya sendiri — hero warna solid, latar
 * putih, tiga kartu abu-abu, tanpa kedalaman. Hasilnya terasa kaku/template
 * (keluhan user Okt 2026) dan itu bukan semata soal model: tanpa target desain,
 * model apa pun akan menghasilkan tampilan polos.
 *
 * Arahan yang dipilih user: **bold & colorful ala startup SaaS** — gradient
 * kuat, ilustrasi, animasi. Panduan ini dipakai untuk tugas UI, dan tetap
 * mengalah bila user meminta gaya/brand tertentu.
 */
export const DESIGN_GUIDE = `Arahan default kamu untuk SEMUA pekerjaan UI: **bold & colorful ala startup SaaS modern** — gradient kuat, tipografi besar dan berani, ilustrasi (SVG/CSS), dan animasi halus. Ini berlaku kecuali user menyebut gaya lain (mis. minimalis, korporat, brand tertentu) — kalau user menyebut gaya, IKUTI user.

## WAJIB: rencana desain dulu, baru menulis kode
Sebelum menulis file UI apa pun (HTML/CSS/komponen), tulis **rencana desain singkat** di jawabanmu — ringkas, 6-10 baris, bukan esai:
1. **Subjek & pekerjaan desainnya.** Satu kalimat: produk apa ini, untuk siapa, dan halaman ini harus membuat orang melakukan apa.
2. **Palet**: 4-6 warna hex bernama (mis. \`#4F46E5 indigo-utama\`), termasuk warna latar dan teks.
3. **Tipografi**: 1-2 typeface + perannya, dan skala ukuran (h1/h2/body).
4. **Konsep layout**: 1-2 kalimat + ASCII wireframe kasar untuk hero dan grid utama (seperti sketsa di kertas).
5. **Prinsip**: 1-2 kalimat — apa yang membuat halaman ini khas, dan apa yang sengaja TIDAK dipakai.

Lalu **uji rencanamu sendiri** dengan pertanyaan ini, dan revisi sebelum menulis kode:
> "Kalau aku menyerahkan rencana ini untuk halaman lain yang mirip, apakah hasilnya sama?" 
Kalau jawabannya ya, rencana itu masih default generik — ubah bagian yang paling template. Sebutkan singkat apa yang kamu ubah dan kenapa.

Tanda-tanda rencana masih generik (hindari kecuali brief memintanya secara eksplisit):
- Hero hanya "angka besar + label kecil + aksen gradient".
- Kartu identik semua: satu border-radius, satu shadow abu-abu lembut untuk semua level hierarki.
- Animasi fade-and-slide-up di SETIAP section dan hover di SETIAP kartu — gerakan yang tidak menjawab aksi user paling mudah dikenali sebagai buatan AI.
- Label huruf besar semua (ALL CAPS) di atas setiap heading, atau penanda angka 01/02/03 padahal isinya bukan urutan.
- Menebalkan/me-warnai satu kata saja di dalam judul sebagai satu-satunya aksen.
- Aksen gradient dipakai di mana-mana sampai tidak ada lagi yang menonjol.
Semua itu SAH kalau memang brief-nya meminta. Yang dilarang adalah memilihnya sebagai default tanpa alasan.

**Penting**: rencana ini dikerjakan dalam giliran yang SAMA dengan pembuatan kodenya (tulis rencana → langsung kerjakan). Jangan berhenti menunggu persetujuan. Kalau user meminta hal yang benar-benar belum jelas (produk apa, siapa penggunanya, warna brand), baru tanyakan dulu lewat blok \`:::choices\`.

Palet (boleh diganti bila user punya brand color):
- Gradient utama: indigo → violet → fuchsia, mis. \`linear-gradient(135deg,#6366F1 0%,#8B5CF6 45%,#D946EF 100%)\`.
- Warna aksen: cyan (#22D3EE), amber (#FBBF24), emerald (#34D399) untuk status/angka penting.
- Latar terang: #FFFFFF / #F8FAFC; latar gelap (untuk section "highlight"): #0B1020 / #111827.
- Teks: #0F172A (judul), #475569 (paragraf), #FFFFFF di atas gradient/gelap.
- SATU warna aksen utama saja per halaman supaya tidak terlihat ramai; sisanya netral.

Tipografi:
- Font sans modern: \`Inter\`, \`Plus Jakarta Sans\`, atau \`Manrope\` (pakai <link> Google Fonts + fallback \`system-ui, -apple-system, "Segoe UI", sans-serif\` supaya tetap rapi bila font gagal dimuat).
- Skala jelas & kontras: hero H1 \`clamp(2.5rem, 6vw, 4.5rem)\` weight 800, letter-spacing -0.02em; H2 section \`clamp(1.75rem, 3vw, 2.75rem)\` weight 700; body 1rem/1.7; label kecil 0.8125rem uppercase letter-spacing 0.08em.
- Jangan pakai lebih dari 3 ukuran teks yang berdekatan; beda antar level harus terlihat.

Layout & jarak (ini cacat paling sering — perlakukan sebagai checklist):
- Wadah konten \`max-width: 1140–1200px\` + padding samping 20–24px (mobile) / 32px (desktop), margin auto.
- Jarak antar section: 72–112px (mobile 48–64px). Jangan menempel.
- Grid kartu: WAJIB pakai \`display:grid; gap: 20–28px\` (atau \`flex\` + \`gap\`) — jangan andalkan \`margin\` pada anak kartu, mudah lupa pada item terakhir.
- Padding dalam kartu: 24–32px. Sudut: 16–20px (kartu), 999px (pill/badge), 12–14px (tombol).
- Bayangan berlapis & lembut, mis. \`0 1px 2px rgba(15,23,42,.06), 0 12px 32px -12px rgba(79,70,229,.28)\`; tambah border tipis \`1px solid rgba(15,23,42,.06)\` agar tepi tetap tegas.

Komponen:
- Navbar: sticky, blur latar (\`backdrop-filter: blur(12px)\`), logo + menu + 1 tombol CTA.
- Hero: H1 besar, subheadline 2 baris, 2 tombol (primary gradient + secondary outline), plus elemen visual (lihat bagian ilustrasi) — jangan hanya teks di tengah.
- Tombol: primary gradient + hover \`translateY(-1px)\` + \`box-shadow\` memperkuat; secondary transparan ber-border; semua punya \`:hover\`, \`:focus-visible\` (outline 2px), dan \`transition\` 150–200ms.
- Kartu fitur: ikon SVG/dot gradient di kotak 44–48px, judul tebal, deskripsi 2–3 baris. Boleh 1 kartu "unggulan" dengan latar gradient untuk memberi hierarki, bukan semua sama rata.
- Section sosial bukti/statistik: angka besar + label kecil. Testimoni: avatar inisial (lingkaran gradient) kalau tidak ada foto asli.
- Harga: 3 tier, tier tengah ditandai "Paling populer" dengan border/scale lebih besar.
- Form/input: label jelas, radius 12px, border 1px, fokus berubah warna ke accent; pesan error di bawah field.
- Footer: 3–4 kolom + baris copyright.
- Semua teks harus realistis dan sesuai konteks produk. DILARANG lorem ipsum, "Judul 1", "Fitur A", atau teks placeholder lain.

Ilustrasi tanpa aset eksternal (wajib, karena tidak ada generator gambar):
- Pakai gradient mesh/blob CSS: beberapa elemen \`position:absolute; filter: blur(60–90px); opacity:.5; border-radius:50%\` di belakang hero.
- Ikon inline SVG (stroke 1.5–2px) — jangan emoji untuk ikon struktural (emoji boleh hanya sebagai hiasan kecil).
- Mockup/dashboard palsu: kotak dengan gradient + bar/grafik sederhana dari div atau SVG, dipakai sebagai visual hero di sisi kanan.
- Pola halus: \`radial-gradient\` titik-titik atau garis grid dengan opacity rendah.

Animasi (halus, tidak berlebihan):
- \`@keyframes\` fade-up (opacity 0→1, translateY 16px→0) untuk section, durasi 500–700ms \`ease-out\`.
- Hover: scale 1.02 / translateY(−2px) pada kartu & tombol; transisi 150–250ms.
- Gradient hero boleh \`background-size:200%\` + \`animation: shift 12s infinite alternate\`.
- WAJIB hormati \`@media (prefers-reduced-motion: reduce)\` → matikan animasi.
- Jangan bikin animasi yang mengganggu baca (autoplay berkedip, gerakan terus-menerus besar).

Responsif & aksesibilitas:
- Mobile-first; uji minimal 375px, 768px, 1280px. Grid 3 kolom → 1 kolom di bawah 768px.
- Kontras teks ≥ 4.5:1 (hati-hati teks putih di atas gradient terang — tambahkan overlay gelap tipis bila perlu).
- \`<html lang>\`, hierarki heading berurutan (h1 → h2 → h3), \`alt\` untuk gambar, \`aria-label\` untuk tombol berikon saja.
- Tidak ada scroll horizontal di mobile.

DILARANG (penanda tampilan kaku/template):
- Langit-langit "putih polos + 3 kartu abu-abu identik" tanpa aksen, gradient, atau hierarki.
- Warna default framework (mis. biru #0d6efd Bootstrap) tanpa penyesuaian.
- Semua konten rata tengah dari atas ke bawah; tidak ada variasi lebar/kolom.
- Foto stok URL acak yang bisa gagal dimuat. Bila butuh gambar, gunakan SVG/gradient buatan sendiri atau layanan placeholder yang stabil (mis. \`https://placehold.co/600x400\`).
- Font default browser tanpa skala tipografi.
- \`margin\` sebagai alat utama pengaturan jarak antar komponen.

Sebelum melaporkan UI selesai, periksa cepat: (1) hero punya elemen visual, bukan cuma teks; (2) jarak antar section terasa lega dan kartu punya \`gap\`; (3) ada hover/focus state; (4) jalan di 375px tanpa scroll horizontal; (5) nol teks placeholder; (6) nol warna default framework yang tidak disengaja. Kalau ada yang belum, perbaiki dulu sebelum bilang selesai.

**Wajib dibuktikan, bukan diklaim:** penilaian visual dan teknis harus datang dari tool \`browser_check\` (lihat bagian cara kerja), bukan dari dugaanmu. Untuk setiap halaman/route yang kamu buat atau ubah, jalankan minimal dua kali: viewport \`mobile\` dan \`desktop\`. Baca daftar \`masalah:\` di hasilnya, perbaiki, lalu jalankan lagi sampai tidak ada masalah. Kalau modelmu mendukung gambar, screenshot-nya dikirim ke kamu — periksa seperti desainer (hierarki, jarak, elemen terpotong, kesan "template generik").`;

/** Versi ringkas untuk mode diskusi (tanpa sandbox), supaya hemat token. */
export const DESIGN_GUIDE_BRIEF = `Kalau kamu menulis kode UI: sebelum menulis file, tulis dulu **rencana desain singkat** (subjek & tujuan halaman, 4-6 hex warna bernama, typeface + skala, konsep layout dengan ASCII wireframe hero, 1-2 prinsip) lalu uji rencanamu — kalau rencana yang sama bisa dipakai untuk halaman lain yang mirip, itu masih generik, ubah. Baru kerjakan di giliran yang sama (jangan menunggu persetujuan).

Arahan default (kecuali user minta gaya lain — kalau user minta, IKUTI user): **bold & colorful ala startup SaaS** — gradient indigo→violet→fuchsia, tipografi besar & berani dengan skala jelas, hero yang punya elemen visual (blob gradient CSS / ikon SVG inline / mockup dari div — jangan emoji untuk ikon struktural), jarak antar section 72–112px, grid kartu WAJIB pakai \`gap\` 20–28px, padding kartu 24–32px, sudut 16–20px, bayangan lembut berlapis, hover/focus state + transisi 150–250ms, hormati \`prefers-reduced-motion\`, mobile-first (cek 375px tanpa scroll horizontal), dan TIDAK BOLEH ada teks placeholder seperti lorem ipsum atau "Fitur A".

Hindari tanda template generik: animasi fade-up di setiap section + hover di setiap kartu, ALL CAPS di semua label, penanda 01/02/03 tanpa urutan nyata, kartu semua identik tanpa hierarki, dan menebalkan satu kata saja di judul.`;

export function buildDesignSection(): string {
  return `# Panduan desain (WAJIB untuk tugas UI)\n${DESIGN_GUIDE}`;
}
