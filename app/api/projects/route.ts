import { fail, errorResponse, ok, readJson } from '@/lib/api';
import { getStore } from '@/lib/db';
import { owner } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const ownerId = await owner();
    const { store } = await getStore();
    return ok({ projects: await store.listProjects(ownerId) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ownerId = await owner();
    const body = await readJson<{ name?: string; description?: string }>(request);
    const name = (body.name || '').trim();
    if (!name) return fail('Nama proyek wajib diisi.', 400);
    const { store } = await getStore();
    const project = await store.createProject(ownerId, {
      name: name.slice(0, 80),
      description: (body.description || '').slice(0, 300),
    });
    return ok({ project }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
