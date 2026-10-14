import type { Sandbox } from '@e2b/code-interpreter';
import { ndjsonStream, readJson } from '@/lib/api';
import { buildDeployCommand, deploymentProtectionSettingsUrl } from '@/lib/deploy/vercel';
import { getStore } from '@/lib/db';
import { loadProject } from '@/lib/projects';
import { getSandbox, hasE2bKey } from '@/lib/sandbox/manager';
import { deployToVercel, detectAppDir, ensureVercel, resolvePath } from '@/lib/sandbox/tools';
import { SANDBOX_PROJECT_DIR } from '@/lib/config';
import { effectiveVercel, owner } from '@/lib/session';

export const dynamic = 'force-dynamic';
// Durasi deploy mengikuti batas fungsi hosting; prosesnya sendiri berjalan latar
// di sandbox, jadi request yang berakhir tidak membatalkan deploy.
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

type Body = {
  /** Sub-folder proyek yang dideploy (kosong = folder proyek utama). */
  cwd?: string;
  /** Nama proyek Vercel (default: nama proyek AgentCloud). */
  projectName?: string;
  prod?: boolean;
};

/** Deploy yang sedang berjalan per proyek: mencegah dua deploy bersamaan. */
const inFlight = new Map<string, Promise<{ url: string | null; state: string }>>();

/**
 * Deploy proyek ke Vercel dan kembalikan link permanennya.
 *
 * Dipicu TOMBOL "Deploy" di panel Preview (user memilih deploy hanya saat diminta)
 * maupun tool `deploy` milik agent. Alur:
 *   1. ambil token Vercel dari Settings (tidak pernah dikirim ke browser),
 *   2. pastikan sandbox + CLI Vercel siap,
 *   3. jalankan deploy sebagai proses LATAR dengan log ke file (tahan terhadap
 *      batas durasi fungsi hosting), lalu polling statusnya sambil streaming log,
 *   4. simpan link permanennya ke proyek (`deploy_url`) supaya muncul lagi
 *      setelah reload dan tetap terlihat walau sandbox dimatikan.
 */
export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const ownerId = await owner();
  const body = await readJson<Body>(request).catch(() => ({} as Body));

  const { store } = await getStore();
  const project = await loadProject(store, ownerId, id);
  const vercel = await effectiveVercel(store, ownerId);

  return ndjsonStream(async (send) => {
    send({ type: 'deploy_start', target: 'vercel' });

    if (!vercel.token) {
      send({
        type: 'deploy_error',
        message:
          'Token Vercel belum diisi. Buka Settings (ikon gerigi) lalu tempel token dari vercel.com/account/tokens ke kolom "Token deploy Vercel" — atau isi VERCEL_TOKEN sebagai variabel environment hosting.',
      });
      return;
    }
    if (!hasE2bKey()) {
      send({
        type: 'deploy_error',
        message:
          'Deploy butuh sandbox untuk mengirim file proyek ke Vercel, dan E2B_API_KEY belum diisi di environment aplikasi ini. Deploy dari deployment yang punya kunci E2B (mis. Vercel).',
      });
      return;
    }
    if (!project.sandbox_id) {
      send({
        type: 'deploy_error',
        message: 'Proyek ini belum punya sandbox. Minta agent membangun proyeknya dulu, lalu deploy.',
      });
      return;
    }

    // Cegah dua deploy bersamaan untuk proyek yang sama (tombol diklik dua kali /
    // tombol + perintah agent di saat yang sama).
    if (inFlight.has(id)) {
      send({ type: 'log', value: 'Deploy untuk proyek ini sedang berjalan — menunggu hasilnya…' });
      const running = await inFlight.get(id)!;
      if (running.url) {
        send({ type: 'deploy_url', url: running.url });
      } else {
        send({ type: 'deploy_error', message: 'Deploy sebelumnya belum menghasilkan link. Coba lagi.' });
      }
      return;
    }

    const projectName = (body.projectName || project.name || 'agentcloud-app').trim();
    const task = (async () => {
      const handle = await getSandbox(project.sandbox_id, { create: false });
      const sandbox: Sandbox = handle.sandbox;

      send({ type: 'log', value: 'Memastikan Vercel CLI tersedia di sandbox…' });
      const cli = await ensureVercel(sandbox, (text) => send({ type: 'log', value: text }));
      if (!cli.ok) {
        send({ type: 'deploy_error', message: cli.message });
        return { url: null, state: 'failed' };
      }

      /**
       * Folder aplikasi. Tombol Deploy tidak tahu di mana aplikasinya dibuat —
       * dan aplikasi sering berada di SUB-FOLDER (`/home/user/project/kasir`).
       * Mengirim folder akar proyek ke Vercel menghasilkan "situs kosong" yang
       * menjawab 404 ("The page could not be found") di SEMUA alamat, padahal
       * CLI melaporkan sukses — inilah bentuk nyata keluhan "link permanennya
       * error". Jadi foldernya dideteksi dulu (bukti dari catatan dev server +
       * pemindaian package.json/index.html).
       */
      let deployCwd = body.cwd ? resolvePath(body.cwd) : SANDBOX_PROJECT_DIR;
      if (!body.cwd) {
        const detected = await detectAppDir(sandbox, SANDBOX_PROJECT_DIR);
        if (detected) {
          deployCwd = detected.dir;
          send({ type: 'log', value: `[deploy] folder aplikasi: ${detected.dir} — ${detected.note}` });
        } else {
          send({
            type: 'log',
            value:
              '[deploy] PERINGATAN: tidak ditemukan package.json/index.html di folder proyek maupun sub-foldernya. ' +
              'Deploy akan mengirim folder proyek apa adanya dan kemungkinan menghasilkan situs kosong (404 di semua alamat).',
          });
        }
      }

      send({
        type: 'log',
        value: `Menautkan proyek "${projectName}" lalu menjalankan: ${buildDeployCommand({ prod: body.prod !== false, scope: vercel.scope })}`,
      });
      const outcome = await deployToVercel(sandbox, {
        token: vercel.token,
        scope: vercel.scope,
        cwd: deployCwd,
        projectName,
        waitMs: 170_000,
        onOutput: (text) => send({ type: 'log', value: text }),
      });

      if (outcome.state === 'done' && outcome.url) {
        await store.updateProject(ownerId, id, { deploy_url: outcome.url, deploy_at: new Date().toISOString() });
        send({ type: 'deploy_url', url: outcome.url, deployAt: new Date().toISOString() });
        // Link yang terkunci Deployment Protection terlihat "sukses" di log,
        // padahal pengunjung hanya melihat halaman login/404 Vercel. Beri tahu
        // user terang-terangan + sediakan tombol mematikannya di panel Preview.
        if (outcome.protected) {
          send({
            type: 'deploy_protected',
            url: outcome.url,
            projectName,
            message: outcome.protectionNote ?? null,
            settingsUrl: deploymentProtectionSettingsUrl({ projectName, scope: vercel.scope }),
          });
        } else if (outcome.warningNote) {
          // Deployment "sukses" tapi tidak menyajikan halaman (404 di semua
          // alamat) — jangan biarkan user mengira linknya siap dibagikan.
          send({ type: 'deploy_warning', url: outcome.url, message: outcome.warningNote, kind: outcome.link?.kind ?? null });
        }
      } else if (outcome.timedOut) {
        send({
          type: 'deploy_pending',
          message:
            'Deploy masih berjalan di Vercel. Pemantauan dilanjutkan otomatis — prosesnya tidak dibatalkan dan tidak diulang dari awal.',
          retryable: true,
        });
      } else {
        // Kalau log build Vercel menunjukkan penyebab yang bisa ditindak (mis.
        // paket belum ada di package.json), sertakan perintah perbaikannya.
        const fix = outcome.issue?.fixCommand ? ` Jalankan \`${outcome.issue.fixCommand}\`, lalu coba Deploy lagi.` : '';
        send({ type: 'deploy_error', message: `${outcome.error ?? 'Deploy gagal.'}${fix}` });
      }
      return { url: outcome.url, state: outcome.state };
    })();

    inFlight.set(id, task);
    try {
      await task;
    } catch (err) {
      send({
        type: 'deploy_error',
        message: `Deploy gagal: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      inFlight.delete(id);
    }

    send({ type: 'done' });
  }, request.signal);
}
