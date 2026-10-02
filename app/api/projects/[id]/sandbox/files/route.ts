import { errorResponse, ok } from '@/lib/api';
import { getStore } from '@/lib/db';
import { loadProject } from '@/lib/projects';
import { getSandbox, hasE2bKey } from '@/lib/sandbox/manager';
import { listProjectFiles } from '@/lib/sandbox/tools';
import { owner } from '@/lib/session';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Daftar file proyek di sandbox (dipakai untuk file tree di panel editor). */
export async function GET(request: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const ownerId = await owner();
    const { store } = await getStore();
    const project = await loadProject(store, ownerId, id);

    if (!hasE2bKey()) {
      return ok({
        files: [],
        sandboxId: null,
        reason: 'E2B_API_KEY belum diisi di environment aplikasi ini, jadi daftar file di sandbox tidak tersedia.',
      });
    }
    if (!project.sandbox_id) return ok({ files: [], sandboxId: null, reason: 'Sandbox belum dibuat untuk proyek ini.' });

    const url = new URL(request.url);
    const subPath = url.searchParams.get('path') || undefined;

    const handle = await getSandbox(project.sandbox_id, { create: false });
    const files = await listProjectFiles(handle.sandbox, subPath);
    return ok({ files, sandboxId: handle.sandboxId });
  } catch (err) {
    return errorResponse(err);
  }
}
