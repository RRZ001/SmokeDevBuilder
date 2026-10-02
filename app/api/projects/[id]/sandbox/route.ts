import { errorResponse, fail, ndjsonStream, ok, readJson } from '@/lib/api';
import { DEFAULT_PREVIEW_PORT } from '@/lib/config';
import { getStore } from '@/lib/db';
import { loadProject } from '@/lib/projects';
import { restoreProjectFiles, snapshotProjectFiles, summarizeSnapshot } from '@/lib/project-files';
import { createSandbox, ensureRuntime, getSandbox, killSandbox, previewUrl } from '@/lib/sandbox/manager';
import { listServers, stopServer } from '@/lib/sandbox/tools';
import { owner } from '@/lib/session';

export const dynamic = 'force-dynamic';
// Catatan durasi: batas waktu fungsi diatur oleh platform hosting, bukan di sini.
// (Vercel mengabaikan nilai melebihi batas plan-nya; atur lewat `vercel.json`
// -> {"functions": {"<path>": {"maxDuration": 60}}} sesuai plan kamu.)

type Ctx = { params: Promise<{ id: string }> };
type Body = { action?: 'start' | 'stop' | 'reset' | 'kill' };

export async function GET(_request: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const ownerId = await owner();
    const { store } = await getStore();
    const project = await loadProject(store, ownerId, id);
    const port = project.preview_port ?? DEFAULT_PREVIEW_PORT;
    return ok({
      sandboxId: project.sandbox_id,
      port,
      servers: project.sandbox_id ? listServers(project.sandbox_id) : [],
      previewUrl: null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Aksi lifecycle sandbox (stream NDJSON supaya progres bisa dilihat user):
 *  - start : hidupkan / hubungkan sandbox + pastikan Node.js ada
 *  - reset : buang sandbox lama, buat sandbox bersih
 *  - stop  : hentikan server yang jalan + matikan sandbox
 */
export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const ownerId = await owner();
  const body = await readJson<Body>(request);
  const action = body.action ?? 'start';

  const { store } = await getStore();
  const project = await store.getProject(ownerId, id);
  if (!project) return fail('Proyek tidak ditemukan.', 404);

  const port = project.preview_port ?? DEFAULT_PREVIEW_PORT;

  return ndjsonStream(async (send, signal) => {
    send({ type: 'status', message: `Aksi sandbox: ${action}` });

    if (action === 'stop') {
      if (!project.sandbox_id) {
        send({ type: 'status', message: 'Tidak ada sandbox aktif untuk proyek ini.' });
      } else {
        for (const server of listServers(project.sandbox_id)) {
          send({ type: 'log', value: `Menghentikan server port ${server.port} (pid ${server.pid})…` });
        }
        const handle = await getSandbox(project.sandbox_id, { create: false }).catch(() => null);
        if (handle) {
          for (const server of listServers(project.sandbox_id)) {
            await stopServer(handle.sandbox, server.port).catch(() => undefined);
          }
          // Simpan file proyek dulu dengan sengaja: setelah di-kill, sandbox dan
          // isinya hilang permanen.
          send({ type: 'status', message: 'Menyimpan file proyek sebelum sandbox dimatikan…' });
          const snapshot = await snapshotProjectFiles(store, ownerId, id, handle.sandbox);
          const summary = summarizeSnapshot(snapshot);
          if (summary) send({ type: snapshot.error ? 'error' : 'log', message: summary });
        }
        await killSandbox(project.sandbox_id);
        await store.updateProject(ownerId, id, { sandbox_id: null });
      }
      send({ type: 'done', sandboxId: null });
      return;
    }

    if (action === 'reset' && project.sandbox_id) {
      // Simpan file proyek lebih dulu supaya sandbox baru bisa dipulihkan dari sini.
      const previous = await getSandbox(project.sandbox_id, { create: false }).catch(() => null);
      if (previous) {
        send({ type: 'status', message: 'Menyimpan file proyek dari sandbox lama…' });
        const snapshot = await snapshotProjectFiles(store, ownerId, id, previous.sandbox);
        const summary = summarizeSnapshot(snapshot);
        if (summary) send({ type: snapshot.error ? 'error' : 'log', message: summary });
      }
      await killSandbox(project.sandbox_id);
      await store.updateProject(ownerId, id, { sandbox_id: null });
      send({ type: 'log', value: 'Sandbox lama dimatikan. Membuat sandbox baru…' });
    }

    const handle =
      action === 'reset' || !project.sandbox_id
        ? await createSandbox()
        : await getSandbox(project.sandbox_id, { create: true });

    if (handle.sandboxId !== project.sandbox_id) {
      await store.updateProject(ownerId, id, { sandbox_id: handle.sandboxId });
    }
    send({ type: 'sandbox', sandboxId: handle.sandboxId, status: 'ready' });

    send({ type: 'status', message: 'Menyiapkan runtime (Node.js & npm)…' });
    const log = await ensureRuntime(handle.sandbox, (text) => send({ type: 'log', value: text }));
    if (log) send({ type: 'log', value: log });

    // Pulihkan file proyek dari database (kalau sandbox ini baru/bersih).
    if (handle.created || handle.recovered) {
      send({ type: 'status', message: 'Memulihkan file proyek dari database…' });
      const restore = await restoreProjectFiles(store, ownerId, id, handle.sandbox);
      if (restore.error) {
        send({ type: 'error', message: restore.error });
      } else if (restore.restored > 0) {
        send({
          type: 'log',
          value: `Dipulihkan ${restore.restored} dari ${restore.total} file proyek. Jalankan "npm install" sebelum menjalankan server (dependency tidak disimpan).`,
        });
      }
    }

    if (signal.aborted) return;
    send({ type: 'preview', url: previewUrl(handle.sandbox, port), port });
    send({ type: 'status', message: 'Sandbox siap dipakai.' });
    send({ type: 'done', sandboxId: handle.sandboxId });
  }, request.signal);
}
