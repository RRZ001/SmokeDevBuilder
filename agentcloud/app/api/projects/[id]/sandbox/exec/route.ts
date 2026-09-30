import { fail, ndjsonStream, readJson } from '@/lib/api';
import { getStore } from '@/lib/db';
import { loadProject } from '@/lib/projects';
import { getSandbox, hasE2bKey } from '@/lib/sandbox/manager';
import { runCommand } from '@/lib/sandbox/tools';
import { owner } from '@/lib/session';

export const dynamic = 'force-dynamic';
// Catatan durasi: batas waktu fungsi diatur oleh platform hosting, bukan di sini.
// (Vercel mengabaikan nilai melebihi batas plan-nya; atur lewat `vercel.json`
// -> {"functions": {"<path>": {"maxDuration": 60}}} sesuai plan kamu.)

type Ctx = { params: Promise<{ id: string }> };

/**
 * Terminal manual: user menjalankan perintah sendiri di sandbox.
 * POST { command, cwd? } -> stream NDJSON { output | exit | error | done }
 */
export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const ownerId = await owner();
  const body = await readJson<{ command?: string; cwd?: string }>(request);
  const command = (body.command || '').trim();

  if (!command) return fail('Parameter `command` wajib diisi.', 400);
  if (!hasE2bKey()) return fail('E2B_API_KEY belum diisi - terminal sandbox tidak tersedia.', 400);

  const { store } = await getStore();
  const project = await store.getProject(ownerId, id);
  if (!project) return fail('Proyek tidak ditemukan.', 404);
  if (!project.sandbox_id) return fail('Sandbox belum dibuat. Jalankan "Mulai sandbox" terlebih dahulu.', 400);

  return ndjsonStream(async (send) => {
    send({ type: 'status', message: `$ ${command}` });
    const handle = await getSandbox(project.sandbox_id, { create: false });
    const result = await runCommand(handle.sandbox, command, {
      cwd: body.cwd,
      timeoutMs: 300_000,
      onOutput: (chunk) => send({ type: 'output', value: chunk }),
    });
    send({ type: 'exit', code: result.exitCode, ok: result.ok });
    if (!result.ok && result.stderr) send({ type: 'error', message: result.stderr.slice(0, 2_000) });
    send({ type: 'done' });
  }, request.signal);
}
