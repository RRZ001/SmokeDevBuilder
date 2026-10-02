import { errorResponse, fail, ok, readJson } from '@/lib/api';
import { DEFAULT_PREVIEW_PORT } from '@/lib/config';
import { getStore } from '@/lib/db';
import { loadProject } from '@/lib/projects';
import { getSandbox, hasE2bKey, previewUrl } from '@/lib/sandbox/manager';
import { listServers, runCommand } from '@/lib/sandbox/tools';
import { owner } from '@/lib/session';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Ambil URL preview + status HTTP server di sandbox. */
export async function GET(request: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const ownerId = await owner();
    const { store } = await getStore();
    const project = await loadProject(store, ownerId, id);

    if (!hasE2bKey()) {
      return fail('E2B_API_KEY belum diisi di environment aplikasi ini, jadi live preview tidak tersedia.', 400);
    }
    if (!project.sandbox_id) return fail('Sandbox belum dibuat untuk proyek ini.', 400);

    const url = new URL(request.url);
    const port = Number(url.searchParams.get('port')) || project.preview_port || DEFAULT_PREVIEW_PORT;

    const handle = await getSandbox(project.sandbox_id, { create: false });
    const probe = await runCommand(
      handle.sandbox,
      `code=$(curl -s -o /dev/null -m 4 -w "%{http_code}" http://127.0.0.1:${port}/ 2>/dev/null || echo 000); echo "$code"`,
      { cwd: '/', timeoutMs: 20_000 },
    );
    const status = probe.stdout.trim().split('\n').pop() || '000';

    return ok({
      url: previewUrl(handle.sandbox, port),
      port,
      status,
      online: status !== '000',
      servers: listServers(project.sandbox_id),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Set / mengubah port preview yang dipakai proyek ini. */
export async function POST(request: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const ownerId = await owner();
    const body = await readJson<{ port?: number }>(request);
    const { store } = await getStore();
    await loadProject(store, ownerId, id);

    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return fail('Port harus antara 1024 dan 65535.', 400);

    const project = await store.updateProject(ownerId, id, { preview_port: port });
    return ok({ project });
  } catch (err) {
    return errorResponse(err);
  }
}
