/**
 * Uji DIAGNOSA halaman error dev server — MURNI + sandbox tiruan, tanpa kredit E2B.
 *
 * Insiden nyata yang melahirkan modul ini (Okt 2026, proyek "Sistem kasir"):
 * `next dev` menjawab HTTP 500 dengan halaman "Failed to compile — Module not
 * found: Can't resolve 'class-variance-authority'", tetapi kesiapan preview
 * dinilai hanya dari "ada status HTTP" → agent melaporkan "Preview sudah bisa
 * dibuka dan landing page terlihat profesional", sementara user melihat layar
 * error. Uji di sini memastikan kasus itu terdeteksi, perintah perbaikannya
 * disebut, dan pemulihan otomatis TIDAK menjalankan ulang server yang error
 * kompilasi (menjalankan ulang tidak akan menolong).
 */
import {
  detectPreviewIssue,
  extractMissingPackages,
  installCommand,
  issueDetail,
  packageManagerFromLockfile,
  packageNameFromSpecifier,
  summarizeIssue,
} from '@/lib/sandbox/diagnostics';
import { decideServerReadiness, evaluatePublicProbe, planPreviewRecovery } from '@/lib/sandbox/preview-status';
import { startServer } from '@/lib/sandbox/tools';
import type { Sandbox } from '@e2b/code-interpreter';

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

/** Halaman error Next.js persis seperti pada screenshot user (dipadatkan). */
const NEXT_COMPILE_ERROR_PAGE = `<html><body>
<div id="__next_error__"></div>
<main><h1>Failed to compile</h1>
<pre>./components/ui/badge.tsx:2:0
Module not found: Can't resolve 'class-variance-authority'
  1 | import * as React from "react"
&gt; 2 | import { cva, type VariantProps } from "class-variance-authority"
https://nextjs.org/docs/messages/module-not-found
Import trace for requested module:
./app/pos/page.tsx</pre>
<p>This error occurred during the build process and can only be dismissed by fixing the error.</p>
</main></body></html>`;

const HEALTHY_PAGE = '<html><body><h1>Kasir Toko Saya</h1><p>Selamat datang</p></body></html>';

console.log('\n[1] ekstraksi nama paket');
{
  check('scoped package', packageNameFromSpecifier('@radix-ui/react-dialog') === '@radix-ui/react-dialog');
  check('subpath diambil paket induknya', packageNameFromSpecifier('lodash/fp/curry') === 'lodash');
  check('scoped subpath diambil paket induknya', packageNameFromSpecifier('@scope/pkg/sub') === '@scope/pkg');
  check('path relatif diabaikan', packageNameFromSpecifier('./utils') === null);
  check('path absolut diabaikan', packageNameFromSpecifier('/lib/utils') === null);
  check('modul bawaan Node diabaikan', packageNameFromSpecifier('fs') === null && packageNameFromSpecifier('node:fs') === null);
  check('specifier berquery diabaikan', packageNameFromSpecifier('x.svg?url') === null);
  check('nama tidak sah diabaikan', packageNameFromSpecifier('path dengan spasi') === null);
}
{
  const text = `./components/ui/badge.tsx:2:0
Module not found: Can't resolve 'class-variance-authority'
Cannot find module '@radix-ui/react-slot'
error TS2307: Cannot find module 'lucide-react'
Failed to resolve import "clsx" from "src/app.tsx"
./lib/utils.ts`;
  const pkgs = extractMissingPackages(text);
  check('semua bentuk pesan terbaca', pkgs.length === 4, JSON.stringify(pkgs));
  check('nama paket benar & terurut', JSON.stringify(pkgs) === JSON.stringify(['@radix-ui/react-slot', 'class-variance-authority', 'clsx', 'lucide-react']), JSON.stringify(pkgs));
  check('modul lokal tidak dimasukkan', !pkgs.includes('./lib/utils'));
  check('teks tanpa masalah => kosong', extractMissingPackages('server siap di port 3000').length === 0);
}

console.log('\n[2] deteksi halaman error');
{
  const issue = detectPreviewIssue({ status: 500, body: NEXT_COMPILE_ERROR_PAGE });
  check('halaman error Next terdeteksi', Boolean(issue), String(issue));
  check('jenis = missing-package', issue?.kind === 'missing-package', issue?.kind);
  check('paket yang hilang terbaca', issue?.packages.join(',') === 'class-variance-authority', JSON.stringify(issue?.packages));
  check('perintah perbaikan disusun (npm)', issue?.fixCommand === 'npm install class-variance-authority', String(issue?.fixCommand));
  check('detail memuat baris penyebab', /Can't resolve/.test(issue?.detail ?? ''), issue?.detail);
  check('ringkasan menyebut paket & perbaikan', /class-variance-authority/.test(summarizeIssue(issue) ?? '') && /npm install/.test(summarizeIssue(issue) ?? ''));

  const compileOnly = detectPreviewIssue({ status: 500, body: '<h1>Failed to compile</h1><pre>Error: Unexpected token }</pre>' });
  check('error kompilasi tanpa paket tetap terdeteksi', compileOnly?.kind === 'compile', String(compileOnly?.kind));
  check('tanpa paket: perintah perbaikan kosong', compileOnly?.fixCommand === null);

  check('halaman sehat tidak dianggap error', detectPreviewIssue({ status: 200, body: HEALTHY_PAGE }) === null);
  check('teks kosong tidak dianggap error', detectPreviewIssue({ status: 200, body: '' }) === null);
  // Halaman aplikasi yang kebetulan memuat kata-katanya (mis. dokumentasi).
  check(
    'kata "module not found" di halaman app biasa tidak menuduh',
    detectPreviewIssue({ status: 200, body: '<article>Cara mengatasi module not found di Node</article>' }) === null,
  );
  // Keluaran log dev server juga bisa jadi sumber diagnosa.
  const fromLog = detectPreviewIssue({ status: 500, log: "Module not found: Can't resolve 'zod'" });
  check('diagnosa juga dari log server', fromLog?.packages.join(',') === 'zod', JSON.stringify(fromLog?.packages));
  check('cuplikan detail dibatasi', issueDetail('x'.repeat(2000)).length <= 600);
}
{
  const page = detectPreviewIssue({ status: 500, body: NEXT_COMPILE_ERROR_PAGE, packageManager: 'pnpm' });
  check('perintah mengikuti package manager (pnpm)', page?.fixCommand === 'pnpm add class-variance-authority', String(page?.fixCommand));
  check('lockfile pnpm dikenali', packageManagerFromLockfile(['pnpm-lock.yaml']) === 'pnpm');
  check('lockfile yarn dikenali', packageManagerFromLockfile(['yarn.lock']) === 'yarn');
  check('lockfile bun dikenali', packageManagerFromLockfile(['bun.lockb']) === 'bun');
  check('default npm', packageManagerFromLockfile(['package-lock.json']) === 'npm');
  check('banyak paket sekaligus', installCommand('npm', ['a', 'b', 'a']) === 'npm install a b');
}

console.log('\n[3] kesiapan: halaman error BUKAN preview siap');
{
  const probe = evaluatePublicProbe(500, NEXT_COMPILE_ERROR_PAGE);
  check('server dianggap hidup (proxy tidak menolak)', probe.online === true);
  check('masalah halaman ikut terbaca dari probe publik', probe.issue?.kind === 'missing-package', JSON.stringify(probe.issue));

  const decision = decideServerReadiness({ localCode: '500', listenScope: 'all', publicProbe: probe });
  check('TIDAK dinyatakan siap', decision.ready === false);
  check('alasan menyebut paket yang hilang', /class-variance-authority/.test(decision.reason ?? ''), String(decision.reason));
  check('alasan memuat perintah perbaikan', /npm install class-variance-authority/.test(decision.reason ?? ''), String(decision.reason));
  check('masalah diteruskan ke pemanggil', decision.issue?.kind === 'missing-package');

  const healthy = decideServerReadiness({
    localCode: '200',
    listenScope: 'all',
    publicProbe: evaluatePublicProbe(200, HEALTHY_PAGE),
  });
  check('halaman sehat tetap dinyatakan siap', healthy.ready === true);
  check('tanpa masalah: issue null', healthy.issue === null);

  // 404/500 dari aplikasi user sendiri (bukan halaman error kompilasi) tetap siap:
  // servernya memang hidup, halamannya yang bermasalah.
  const appError = decideServerReadiness({
    localCode: '404',
    listenScope: 'all',
    publicProbe: evaluatePublicProbe(404, '<html><body>404 - halaman tidak ditemukan</body></html>'),
  });
  check('404 aplikasi user tetap dianggap server hidup', appError.ready === true, String(appError.reason));
}

console.log('\n[4] pemulihan otomatis: jangan restart error kompilasi');
{
  const issue = detectPreviewIssue({ status: 500, body: NEXT_COMPILE_ERROR_PAGE });
  const plan = planPreviewRecovery({
    publicOnline: true,
    localCode: '500',
    listenScope: 'all',
    hasServerRecord: true,
    issue,
  });
  check('tidak menjalankan ulang server (bukan masalah proses)', plan.action === 'none', JSON.stringify(plan));
  check('alasan menjelaskan masalah halamannya', /class-variance-authority/.test(plan.reason ?? ''), String(plan.reason));

  const offline = planPreviewRecovery({ publicOnline: false, localCode: '000', listenScope: 'none', hasServerRecord: true });
  check('tanpa masalah: perilaku pemulihan lama tidak berubah (revive)', offline.action === 'revive');
}

/* ------------------------------------------------------------ sandbox tiruan */

class FakeSandbox {
  fs = new Map<string, string>();
  starts: string[] = [];
  commands_run: string[] = [];

  files = {
    read: async (path: string) => {
      const value = this.fs.get(path);
      if (value == null) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    write: async (path: string, content: string) => {
      this.fs.set(path, content);
      return { path };
    },
  };

  constructor(private lockfiles: string = '') {}

  get sandboxId() {
    return 'fake-sandbox-diagnostics';
  }

  getHost(port: number) {
    return `${port}-fake.e2b.dev`;
  }

  commands = {
    run: async (command: string, options: { background?: boolean } = {}) => {
      this.commands_run.push(command);
      if (options.background) {
        this.starts.push(command);
        return { pid: 4242, stdout: 'starting next dev...\n', stderr: '', exitCode: 0 };
      }
      if (command.includes('kill -0')) return { pid: 1, stdout: 'READY 500\n', stderr: '', exitCode: 0 };
      if (command.includes('CODE')) return { pid: 1, stdout: 'CODE 500\nSCAN ok\n0.0.0.0:3000\n', stderr: '', exitCode: 0 };
      if (command.includes('pnpm-lock.yaml')) return { pid: 1, stdout: this.lockfiles, stderr: '', exitCode: 0 };
      return { pid: 1, stdout: '', stderr: '', exitCode: 0 };
    },
    kill: async () => true,
  };

  asSandbox(): Sandbox {
    return this as unknown as Sandbox;
  }
}

console.log('\n[5] start_server melaporkan halaman error + perintah perbaikan');
{
  const fake = new FakeSandbox();
  const res = await startServer(fake.asSandbox(), 'npm run dev', 3000, {
    probePublic: async () => evaluatePublicProbe(500, NEXT_COMPILE_ERROR_PAGE),
  });

  check('start_server TIDAK menyatakan siap', res.ready === false);
  check('alasan menyebut paket yang hilang', /class-variance-authority/.test(res.reason ?? ''), String(res.reason));
  check('perintah perbaikan disertakan', res.issue?.fixCommand === 'npm install class-variance-authority', String(res.issue?.fixCommand));
  check('server tetap dijalankan (agent perlu log-nya)', fake.starts.length === 1, JSON.stringify(fake.starts));

  const withPnpm = await startServer(new FakeSandbox('pnpm-lock.yaml\n').asSandbox(), 'npm run dev', 3000, {
    probePublic: async () => evaluatePublicProbe(500, NEXT_COMPILE_ERROR_PAGE),
  });
  check('package manager dari lockfile dipakai', withPnpm.issue?.fixCommand === 'pnpm add class-variance-authority', String(withPnpm.issue?.fixCommand));

  const healthy = await startServer(new FakeSandbox().asSandbox(), 'npm run dev', 3000, {
    probePublic: async () => evaluatePublicProbe(200, HEALTHY_PAGE),
  });
  check('server sehat tetap siap', healthy.ready === true);
  check('server sehat tanpa issue', !healthy.issue);
}

console.log(`\nhasil: ${pass} ok, ${fail} gagal`);
if (fail) process.exit(1);
