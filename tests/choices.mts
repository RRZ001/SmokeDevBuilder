/**
 * Uji blok pilihan (tombol opsi yang bisa diklik user) — MURNI, tanpa kredit E2B.
 *
 * Latar belakang: user meminta perilaku seperti VibeCoder, yaitu agent
 * menawarkan opsi konkret yang bisa diklik, HANYA saat permintaannya kurang
 * detail. Yang paling rawan rusak: filter streaming (markup `:::choices` tidak
 * boleh sempat berkedip di UI) dan parser (blok tidak sah harus dibiarkan
 * sebagai teks supaya jawaban agent tidak hilang).
 */
import { matchChosenOption } from '@/lib/choice-select';
import {
  CHOICE_FORMAT_RULE,
  createChoiceStreamFilter,
  parseChoiceBody,
  parseChoices,
} from '@/lib/agent/choices';
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

const SAMPLE = `Aku butuh sedikit info dulu.

:::choices
Q: Desain seperti apa?
- Bold & colorful ala startup SaaS
- Minimalis bersih ala Linear
Q: Datanya dari mana?
- Data contoh di dalam app
- Sambungkan ke API sendiri
:::`;

console.log('\n[1] parser blok pilihan');
{
  const { cleaned, questions } = parseChoices(SAMPLE);
  check('2 pertanyaan terbaca', questions.length === 2, JSON.stringify(questions.length));
  check('opsi pertanyaan pertama terbaca', questions[0]?.options.length === 2, JSON.stringify(questions[0]));
  check('teks pertanyaan bersih dari "Q:"', questions[0]?.question === 'Desain seperti apa?', questions[0]?.question);
  check('markup terbuang dari teks', !cleaned.includes(':::choices') && !cleaned.includes('- Bold'), cleaned);
  check('teks pengantar tetap ada', cleaned.includes('Aku butuh sedikit info dulu.'), cleaned);
  check('teks tidak menyisakan baris kosong menumpuk', !/\n{3,}/.test(cleaned));
}
{
  const fenced = 'Tanya dulu ya.\n\n```choices\nQ: Stack?\n- Next.js\n- Express\n```\n';
  const { cleaned, questions } = parseChoices(fenced);
  check('varian ```choices ikut didukung', questions.length === 1 && questions[0].options.length === 2);
  check('varian fenced dibersihkan dari teks', !cleaned.includes('```'), cleaned);
}
{
  const multi = `${SAMPLE}\n\n:::choices\nQ: Bahasa?\n- Indonesia\n- Inggris\n:::`;
  const { questions } = parseChoices(multi);
  check('beberapa blok digabung', questions.length === 3, String(questions.length));
}
{
  const broken = 'Aku perlu tahu satu hal.\n\n:::choices\nQ: Cuma satu opsi\n- Hanya ini\n:::';
  const { cleaned, questions } = parseChoices(broken);
  check('blok dengan 1 opsi ditolak (bukan pilihan)', questions.length === 0);
  check('blok tidak sah dibiarkan sebagai teks (jawaban tidak hilang)', cleaned.includes('Cuma satu opsi'), cleaned);
}
{
  const noQuestion = ':::choices\n- A\n- B\n:::';
  check('blok tanpa Q ditolak', parseChoices(noQuestion).questions.length === 0);
}
check('teks biasa tanpa blok tidak berubah', parseChoices('Halo, ini jawaban biasa.').cleaned === 'Halo, ini jawaban biasa.');
check('parseChoiceBody menolak isi kosong', parseChoiceBody('').length === 0);
check(
  'opsi duplikat dibuang',
  (() => {
    const q = parseChoiceBody('Q: A?\n- sama\n- sama\n- beda');
    return q.length === 1 && q[0].options.length === 2;
  })(),
);
check(
  'maksimal 4 opsi per pertanyaan',
  parseChoiceBody('Q: A?\n- 1\n- 2\n- 3\n- 4\n- 5').every((q) => q.options.length <= 4),
);

console.log('\n[2] filter streaming (anti-kedip)');
{
  // Simulasi model menulis blok pilihan karakter demi karakter.
  const filter = createChoiceStreamFilter();
  let visible = '';
  for (const ch of SAMPLE) visible += filter.push(ch);
  visible += filter.flush();

  check('markup tidak pernah muncul sebagian pun', !visible.includes(':') || !visible.includes('choices'), visible.slice(-80));
  check('tidak ada tanda ":::" yang terlihat', !visible.includes(':::'), visible);
  check('tidak ada nama opsi yang bocor ke teks', !visible.includes('Minimalis bersih'), visible);
  check('teks pengantar tetap tampil di UI', visible.includes('Aku butuh sedikit info dulu.'), visible);
  check(
    'teks yang tampil sama dengan hasil parser',
    visible.trim() === parseChoices(SAMPLE).cleaned,
    JSON.stringify(visible.trim().slice(0, 60)),
  );
}
{
  const filter = createChoiceStreamFilter();
  let visible = '';
  for (const ch of 'Ini jawaban biasa tanpa pilihan.') visible += filter.push(ch);
  visible += filter.flush();
  check('teks biasa diteruskan utuh', visible === 'Ini jawaban biasa tanpa pilihan.', visible);
}
{
  // Blok tidak pernah ditutup (model berhenti di tengah): konten tetap muncul.
  const filter = createChoiceStreamFilter();
  let visible = '';
  for (const ch of 'Tanya dulu.\n\n:::choices\nQ: A?\n- X\n- Y') visible += filter.push(ch);
  visible += filter.flush();
  check('blok tak tertutup ditampilkan apa adanya (tidak hilang)', visible.includes('Q: A?') && visible.includes('- X'), visible);
}
{
  // Teks setelah blok penutup harus tetap tampil.
  const filter = createChoiceStreamFilter();
  let visible = '';
  for (const ch of 'Awal.\n:::choices\nQ: A?\n- X\n- Y\n:::\nAkhir.') visible += filter.push(ch);
  visible += filter.flush();
  check('teks setelah blok tetap tampil', visible.includes('Awal.') && visible.includes('Akhir.'), visible);
}
{
  // Penanda terpotong di batas chunk: harus tetap tertahan, tidak bocor.
  const filter = createChoiceStreamFilter();
  const first = filter.push('Halo ::');
  const second = filter.push(':choices\nQ: A?\n- X\n- Y\n:::');
  const tail = filter.flush();
  check('penanda terpotong antar-chunk tidak bocor', !`${first}${second}${tail}`.includes(':::'), `${first}|${second}|${tail}`);
  check('teks sebelum penanda tetap terkirim', first === 'Halo ', JSON.stringify(first));
}

console.log('\n[3] status "sudah dijawab" (tanpa menulis ulang DB)');
{
  const { questions } = parseChoices(SAMPLE);
  check('jawaban sama persis cocok', matchChosenOption('Minimalis bersih ala Linear', questions) === 'Minimalis bersih ala Linear');
  check('cocok walau beda huruf besar/kecil', matchChosenOption('minimalis bersih ala linear', questions) === 'Minimalis bersih ala Linear');
  check('cocok walau ada spasi berlebih', matchChosenOption('  Minimalis   bersih ala Linear ', questions) === 'Minimalis bersih ala Linear');
  check('cocok walau ada tanda titik di akhir', matchChosenOption('Next.js.', parseChoiceBody('Q: a?\n- Next.js\n- Express')) === 'Next.js');
  check('teks bebas bukan pilihan', matchChosenOption('coba pakai nuxt saja', questions) === null);
  check('daftar pertanyaan kosong aman', matchChosenOption('apa saja', undefined) === null);
}

console.log('\n[4] aturan prompt');
{
  const agent = buildSystemPrompt('agent');
  const chat = buildSystemPrompt('chat');
  check('aturan pilihan ada di prompt agent', agent.includes(CHOICE_FORMAT_RULE));
  check('aturan pilihan ada di prompt diskusi', chat.includes(CHOICE_FORMAT_RULE));
  check('format blok dijelaskan persis', agent.includes(':::choices') && agent.includes(':::'));
  check('dibatasi hanya saat permintaan kurang detail', /KURANG DETAIL/.test(agent));
  check('melarang pemakaian untuk basa-basi', /JANGAN memakainya untuk basa-basi/.test(agent));
  check('menyarankan opsi "Terserah, kamu putuskan"', /Terserah, kamu putuskan/.test(agent));
  check('batas 2-4 opsi disebut', /2–4 opsi/.test(agent));
  check('langkah 1 mengarahkan ke blok pilihan', /AJUKAN PERTANYAAN dulu lewat blok/.test(agent));
  check('aturan lama tidak hilang (panduan desain)', /bold & colorful/.test(agent));
  check('aturan lama tidak hilang (bind 0.0.0.0)', /listen di `0\.0\.0\.0`/.test(agent));
}

console.log(`\nhasil: ${pass} ok, ${fail} gagal`);
if (fail > 0) process.exit(1);
