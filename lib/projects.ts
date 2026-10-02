import type { Store } from '@/lib/db';
import type { Project } from '@/lib/db/types';

export async function loadProject(store: Store, ownerId: string, id: string): Promise<Project> {
  const project = await store.getProject(ownerId, id);
  if (!project) throw new Error('Proyek tidak ditemukan (atau bukan milik sesi ini).');
  return project;
}
