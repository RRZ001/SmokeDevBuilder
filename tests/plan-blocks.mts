/**
 * Uji blok RENCANA (`:::plan`) — MURNI, tanpa kredit E2B.
 *
 * Latar belakang: user meminta perilaku seperti VibeCoder, yaitu agent menulis
 * rencana yang TERLIHAT oleh user lalu mencentangnya seiring pekerjaan berjalan.
 * Dua hal paling rawan rusak:
 *  1. Filter streaming — markup `:::plan` tidak boleh sempat berkedip di UI, dan
 *     penanda yang datang terpecah antar-chunk harus tetap tertahan.
 *  2. Parser — blok yang isinya tidak sah HARUS dibiarkan sebagai teks biasa,
 *     supaya kesalahan format tidak menghilangkan jawaban agent.
 */
import {
  PLAN_FORMAT_RULE,
  createPlanStreamFilter,
  parsePlanBody,
  parsePlans,
} from '@/lib/agent/plan';
import { CHOICE_MARKERS } from '@/lib/agent/choices';
import { createMarkerStreamFilter } from '@/lib/agent/marker-block';
import { buildSystemPrompt } from '@/lib/agent/prompt';

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const SAMPLE = `Aku mulai dari struktur proyek dulu.

:::plan
- Periksa struktur proyek yang ada
- Tulis halaman utama + style
- [x] Jalankan dev server
- [ ] Cek tampilan dengan browser_check di 375px
:::

Setelah itu saya jalankan server.`;

console.log('\n[1] parser blok rencana');
{
  const { cleaned, plans } = parsePlans(SAMPLE);
  check('satu blok rencana terbaca', plans.length === 1, String(plans.length));
  check('4 langkah terbaca', plans[0]?.length === 4, JSON.stringify(plans[0]?.length));
  check('langkah belum selesai ditandai done=false', plans[0]?.[0]?.done === false);
  check('langkah [x] ditandai done=true', plans[0]?.[2]?.done === true, JSON.stringify(plans[0]?.[2]));
  check('langkah [ ] tetap done=false', plans[0]?.[3]?.done === false);
  check('markup terbuang dari teks', !cleaned.includes(':::plan') && !cleaned.includes('- Periksa'), cleaned);
  check('teks pengantar tetap ada', cleaned.includes('Aku mulai dari struktur proyek dulu.'), cleaned);
  check('teks setelah blok tetap ada', cleaned.includes('Setelah itu saya jalankan server.'), cleaned);
}
{
  check('blok tanpa langkah dibiarkan sebagai teks', parsePlanBody('').length === 0);
  const { cleaned, plans } = parsePlans('Coba:\n\n:::plan\n\n:::\n\nselesai');
  check('blok kosong tidak menghasilkan rencana', plans.length === 0);
  check('blok kosong tetap muncul apa adanya (tidak hilang)', cleaned.includes(':::plan'), cleaned);
}
{
  const body = ['1. Ambil data dari API', '* Tulis komponen daftar', 'Periksa hasilnya di browser'].join('\n');
  const items = parsePlanBody(body);
  check('penomoran 1. dirapikan', items[0]?.text === 'Ambil data dari API', items[0]?.text);
  check('bullet * diterima', items[1]?.text === 'Tulis komponen daftar', items[1]?.text);
  check('baris tanpa bullet tetap jadi langkah (anti-markup bocor)', items[2]?.text === 'Periksa hasilnya di browser', items[2]?.text);
}
{
  const many = Array.from({ length: 20 }, (_, i) => `- langkah ${i + 1}`).join('\n');
  check('jumlah langkah dibatasi (12)', parsePlanBody(many).length === 12, String(parsePlanBody(many).length));
}
{
  const two = ':::plan\n- a\n- b\n:::\n\nteks\n\n```plan\n- c\n- d\n```';
  const { plans } = parsePlans(two);
  check('varian fenced ```plan diterima', plans.some((p) => p[0]?.text === 'c'), JSON.stringify(plans));
  check('dua blok tetap dipisah (bukan digabung)', plans.length === 2, String(plans.length));
}

console.log('\n[2] filter streaming: markup tidak boleh berkedip');
{
  // Dikirim per satu karakter: penanda terpecah antar-chunk, kasus terburuk.
  const filter = createPlanStreamFilter();
  let shown = '';
  for (const ch of SAMPLE) shown += filter.push(ch);
  shown += filter.flush();

  check('teks yang tampil tidak memuat :::plan', !shown.includes(':::plan'), shown);
  check('teks yang tampil tidak memuat penanda penutup', !shown.includes(':::'), shown);
  check('isi blok tidak bocor ke teks', !shown.includes('Cek tampilan dengan browser_check'));
  check('teks di luar blok tetap tampil', shown.includes('Aku mulai dari struktur proyek dulu.'));
  check('teks setelah blok tetap tampil', shown.includes('Setelah itu saya jalankan server.'));
}
{
  const filter = createPlanStreamFilter();
  const out = filter.push('Renacananya: :::pl') + filter.flush();
  check('penanda terpotong tidak hilang saat stream berakhir', out.includes(':::pl'), out);
}
{
  // Satu filter gabungan (pilihan + rencana) — pemakaian nyata di loop agent.
  const combined = createMarkerStreamFilter([
    ...CHOICE_MARKERS,
    { open: ':::plan', close: ':::' },
  ]);
  const text = `Tanya dulu ya.\n\n:::choices\nQ: Warna?\n- Indigo\n- Hijau\n:::\n\n:::plan\n- Tulis halaman\n- Cek tampilan\n:::\n`;
  let shown = '';
  for (const ch of text) shown += combined.push(ch);
  shown += combined.flush();

  check('filter gabungan membuang markup pilihan', !shown.includes('Q: Warna?'), shown);
  check('filter gabungan membuang markup rencana', !shown.includes('Tulis halaman'), shown);
  check('teks biasa tetap tampil', shown.includes('Tanya dulu ya.'), shown);
}

console.log('\n[3] aturan prompt');
{
  const agent = buildSystemPrompt('agent');
  const chat = buildSystemPrompt('chat');
  check('aturan blok plan ada di prompt agent', agent.includes(PLAN_FORMAT_RULE));
  check('aturan blok plan juga ada di mode diskusi', chat.includes(PLAN_FORMAT_RULE));
  check('format :::plan dicontohkan', agent.includes(':::plan'));
  check('cara mencentang [x] dijelaskan', /`\[x\]`/.test(agent));
  check('jumlah langkah 3-6 disebut', /3–6 langkah/.test(agent));
  check('dilarang memakai blok untuk tugas sepele', /JANGAN memakai blok ini/.test(agent));
  check('langkah kerja menyebut blok rencana', /2\. \*\*Tulis rencana yang terlihat/.test(agent));
  check('aturan blok pilihan tidak hilang', agent.includes(':::choices'));
  check('panduan desain tidak hilang', agent.includes('# Panduan desain (WAJIB untuk tugas UI)'));
  check('perintah bind 0.0.0.0 tidak hilang', /listen di `0\.0\.0\.0`/.test(agent));
}

console.log(`\nhasil: ${pass} ok, ${fail} gagal`);
if (fail > 0) process.exit(1);
