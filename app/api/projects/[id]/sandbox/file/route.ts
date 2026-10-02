import { errorResponse, fail, ok, readJson } from '@/lib/api';
import { getStore } from '@/lib/db';
import { loadProject } from '@/lib/projects';
import { getSandbox, hasE2bKey } from '@/lib/sandbox/manager';
import { readProjectFile, writeProjectFile } from '@/lib/sandbox/tools';
import { describeFileStoreError } from '@/lib/project-files';
import { owner } from '@/lib/session';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Baca isi satu file dari sandbox: GET /sandbox/file?path=src/app.js */
export async function GET(request: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const ownerId = await owner();
    const { store } = await getStore();
    const project = await loadProject(store, ownerId, id);

    if (!hasE2bKey()) return fail('E2B_API_KEY belum diisi.', 400);
    if (!project.sandbox_id) return fail('Sandbox belum dibuat untuk proyek ini.', 400);

    const path = new URL(request.url).searchParams.get('path') || '';
    if (!path) return fail('Parameter `path` wajib diisi.', 400);

    const handle = await getSandbox(project.sandbox_id, { create: false });
    const file = await readProjectFile(handle.sandbox, path);
    return ok({ file });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Simpan perubahan file dari editor: PUT { path, content } */
export async function PUT(request: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const ownerId = await owner();
    const body = await readJson<{ path?: string; content?: string }>(request);
    const { store } = await getStore();
    const project = await loadProject(store, ownerId, id);

    if (!hasE2bKey()) return fail('E2B_API_KEY belum diisi.', 400);
    if (!project.sandbox_id) return fail('Sandbox belum dibuat untuk proyek ini.', 400);

    const path = (body.path || '').trim();
    if (!path) return fail('Parameter `path` wajib diisi.', 400);

    const handle = await getSandbox(project.sandbox_id, { create: false });
    const saved = await writeProjectFile(handle.sandbox, path, body.content ?? '');

    // Simpan juga ke database supaya perubahan manual dari editor ikut bertahan.
    try {
      await store.upsertFiles(ownerId, id, [
        { path: saved.path, content: body.content ?? '', size: saved.bytes, mtime: Date.now() / 1000 },
      ]);
    } catch (err) {
      return ok({ file: saved, warning: describeFileStoreError(err) });
    }
    return ok({ file: saved });
  } catch (err) {
    return errorResponse(err);
  }
}
