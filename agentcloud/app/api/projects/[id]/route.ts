import { errorResponse, fail, ok, readJson } from '@/lib/api';
import { getStore } from '@/lib/db';
import { loadProject } from '@/lib/projects';
import { killSandbox } from '@/lib/sandbox/manager';
import { owner } from '@/lib/session';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const ownerId = await owner();
    const { store } = await getStore();
    return ok({ project: await loadProject(store, ownerId, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(request: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const ownerId = await owner();
    const body = await readJson<{ name?: string; description?: string; preview_port?: number | null }>(request);
    const { store } = await getStore();
    await loadProject(store, ownerId, id);

    const patch: Record<string, unknown> = {};
    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 80);
    if (typeof body.description === 'string') patch.description = body.description.slice(0, 300);
    if (body.preview_port === null || typeof body.preview_port === 'number') patch.preview_port = body.preview_port;

    const project = await store.updateProject(ownerId, id, patch);
    return ok({ project });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_request: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const ownerId = await owner();
    const { store } = await getStore();
    const project = await loadProject(store, ownerId, id);
    if (project.sandbox_id) await killSandbox(project.sandbox_id);
    await store.deleteProject(ownerId, id);
    return ok({ deleted: true });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(_request: Request, ctx: Ctx) {
  // Placeholder agar method tak terduga mengembalikan pesan jelas.
  void ctx;
  return fail('Gunakan PATCH untuk mengubah proyek atau DELETE untuk menghapus.', 405);
}
