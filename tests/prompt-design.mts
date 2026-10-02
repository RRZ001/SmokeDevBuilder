/**
 * Uji system prompt: memastikan panduan desain benar-benar ada di prompt yang
 * dikirim ke model, dan aturan penting sebelumnya tidak hilang karena
 * penyuntingan (regression guard).
 *
 * Latar belakang: sebelum Okt 2026 system prompt tidak punya aturan desain sama
 * sekali, sehingga semua app yang di-generate tampil polos/template. Panduan itu
 * mudah terhapus tanpa sengaja saat prompt disunting, jadi diuji di sini.
 */
import { DESIGN_GUIDE, DESIGN_GUIDE_BRIEF, buildDesignSection } from '@/lib/agent/design';
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

const agent = buildSystemPrompt('agent');
const chat = buildSystemPrompt('chat');

console.log('\n[1] panduan desain ada di prompt mode agent');
check('bagian "Panduan desain" disisipkan', agent.includes('# Panduan desain (WAJIB untuk tugas UI)'));
check('arahan bold & colorful', /bold & colorful ala startup SaaS/.test(agent));
check('palet gradient indigo→violet→fuchsia', /indigo → violet → fuchsia/.test(agent));
check('aturan gap pada grid kartu', /gap: 20–28px|gap\\\\?: 20–28px/.test(agent));
check('jarak antar section eksplisit', /72–112px/.test(agent));
check('larangan teks placeholder', /DILARANG lorem ipsum/.test(agent));
check('aturan prefers-reduced-motion', /prefers-reduced-motion/.test(agent));
check('uji mobile 375px', /375px/.test(agent));
check('larangan warna default framework', /Bootstrap/.test(agent) && /0d6efd/.test(agent));
check('ilustrasi tanpa aset eksternal (SVG/CSS)', /Ikon inline SVG/.test(agent) && /blob CSS|blur\(60–90px\)/.test(agent));
check('hover/focus state wajib', /focus-visible/.test(agent));
check('daftar periksa sebelum lapor selesai', /Sebelum melaporkan UI selesai/.test(agent));
check('gaya user mengalahkan default', /IKUTI user/.test(agent));
check(
  'langkah "Tampilan bukan pelengkap" ada',
  /3\. \*\*Tampilan bukan pelengkap\.\*\*/.test(agent),
);
check('panduan desain tidak bocor sebagai template literal', !agent.includes('undefined') && !agent.includes('[object Object]'));

console.log('\n[2] mode diskusi pakai versi ringkas (hemat token)');
check('versi ringkas disisipkan', chat.includes(DESIGN_GUIDE_BRIEF));
check('versi ringkas menyebut gradient', /gradient indigo→violet→fuchsia/.test(chat));
check('versi ringkas juga mengalah pada gaya user', /IKUTI user/.test(chat));
check('versi ringkas TIDAK memuat panduan penuh (hemat token)', !chat.includes('## Komponen') || chat.length < agent.length);
check('prompt diskusi lebih pendek dari prompt agent', chat.length < agent.length, `${chat.length} vs ${agent.length}`);

console.log('\n[3] aturan lama tidak hilang (regression guard)');
check('aturiran bind 0.0.0.0 masih ada', /listen di `0\.0\.0\.0`/.test(agent));
check('status SIAP tool masih dijelaskan', /BELUM SIAP/.test(agent) && /JANGAN bilang preview siap/.test(agent));
check('larangan mengarang URL preview', /Jangan pernah mengarang URL preview/.test(agent));
check('npm install sebelum start_server', /`npm install`\) SEBELUM `start_server`/.test(agent));
check('E2B key = variabel environment hosting (bukan Settings)', /variabel environment hosting/.test(chat));
check('larangan perintah destruktif', /rm -rf \//.test(agent));
check('folder proyek disebut', /\/home\/user\/project/.test(agent));

console.log('\n[4] penomoran langkah berurutan');
{
  const nums = [...agent.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
  const expected = Array.from({ length: nums.length }, (_, i) => i + 1);
  check(`langkah 1..${nums.length} berurutan tanpa duplikat`, JSON.stringify(nums) === JSON.stringify(expected), nums.join(','));
}

console.log('\n[5] ukuran panduan wajar (biaya token masuk akal)');
check('panduan < 8 KB', Buffer.byteLength(DESIGN_GUIDE, 'utf8') < 8_000, `${Buffer.byteLength(DESIGN_GUIDE, 'utf8')} byte`);
check('prompt agent < 20 KB', Buffer.byteLength(agent, 'utf8') < 20_000, `${Buffer.byteLength(agent, 'utf8')} byte`);
check('versi ringkas < 1,5 KB', Buffer.byteLength(DESIGN_GUIDE_BRIEF, 'utf8') < 1_500);
check('buildDesignSection memuat judul + isi', buildDesignSection().startsWith('# Panduan desain') && buildDesignSection().includes('Palet'));

console.log(`\nhasil: ${pass} ok, ${fail} gagal`);
if (fail > 0) process.exit(1);
