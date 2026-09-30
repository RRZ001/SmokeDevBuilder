import type { Sandbox } from '@e2b/code-interpreter';
import { ndjsonStream, readJson } from '@/lib/api';
import { buildHistory } from '@/lib/agent/history';
import { runAgent, type AgentEvent } from '@/lib/agent/loop';
import type { AgentMode } from '@/lib/agent/prompt';
import { getStore } from '@/lib/db';
import type { Block } from '@/lib/db/types';
import { ensureRuntime, getSandbox, hasE2bKey } from '@/lib/sandbox/manager';
import { effectiveApiKey, effectiveModel, owner } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Body = { projectId?: string; message?: string; autoDebug?: boolean };

/**
 * Endpoint utama agent - mengembalikan stream NDJSON berisi event:
 * message | model | status | text | reasoning | tool_start | tool_output |
 * tool_result | preview | usage | error | saved | done
 */
export async function POST(request: Request) {
  const ownerId = await owner();
  const body = await readJson<Body>(request);
  const projectId = (body.projectId || '').trim();
  const userText = (body.message || '').trim();
  const autoDebug = body.autoDebug !== false;

  if (!projectId || !userText) {
    return Response.json({ error: 'projectId dan message wajib diisi.' }, { status: 400 });
  }

  const { store } = await getStore();
  const project = await store.getProject(ownerId, projectId);
  if (!project) {
    return Response.json({ error: 'Proyek tidak ditemukan.' }, { status: 404 });
  }

  const settings = await store.getSettings(ownerId);
  const apiKey = effectiveApiKey(settings);
  const model = effectiveModel(settings);

  // Riwayat diambil SEBELUM menyimpan pesan user supaya tidak duplikat.
  const history = buildHistory(await store.listMessages(ownerId, projectId));
  const userMessage = await store.addMessage({
    project_id: projectId,
    owner_id: ownerId,
    role: 'user',
    content: userText,
  });

  return ndjsonStream(async (send, signal) => {
    send({ type: 'message', message: userMessage });
    send({ type: 'model', model });

    if (!apiKey) {
      const message =
        'OpenRouter API key belum diisi. Buka Settings (ikon gerigi di kanan atas) lalu tempelkan API key dari openrouter.ai/keys.';
      send({ type: 'error', message });
      const blocks: Block[] = [{ type: 'notice', level: 'error', text: message }];
      const saved = await store.addMessage({
        project_id: projectId,
        owner_id: ownerId,
        role: 'assistant',
        content: message,
        parts: blocks,
      });
      send({ type: 'saved', message: saved });
      send({ type: 'done', blocks, content: message });
      return;
    }

    let mode: AgentMode = 'chat';
    let sandboxId = project.sandbox_id;
    let toolCtx: { sandbox: Sandbox; sandboxId: string } | null = null;

    if (!hasE2bKey()) {
      send({
        type: 'notice',
        level: 'warn',
        message:
          'E2B_API_KEY belum diisi, jadi agent berjalan dalam mode diskusi (belum bisa mengeksekusi kode). Isi key E2B di Settings untuk mengaktifkan eksekusi penuh di cloud sandbox.',
      });
    } else {
      try {
        send({ type: 'status', message: 'Menyiapkan cloud sandbox E2B…' });
        const handle = await getSandbox(sandboxId, { create: true });
        sandboxId = handle.sandboxId;
        if (project.sandbox_id !== sandboxId) {
          await store.updateProject(ownerId, projectId, { sandbox_id: sandboxId });
          send({ type: 'project', project: { ...project, sandbox_id: sandboxId } });
        }
        send({ type: 'sandbox', sandboxId, status: 'ready' });

        send({ type: 'status', message: 'Memastikan Node.js & npm tersedia di sandbox…' });
        const runtimeLog = await ensureRuntime(handle.sandbox);
        if (runtimeLog) send({ type: 'log', value: runtimeLog });

        toolCtx = { sandbox: handle.sandbox, sandboxId };
        mode = 'agent';
      } catch (err) {
        const message = `Sandbox E2B tidak bisa disiapkan: ${err instanceof Error ? err.message : String(err)}`;
        send({ type: 'notice', level: 'warn', message: `${message} Agent lanjut dalam mode diskusi.` });
        mode = 'chat';
      }
    }

    send({ type: 'mode', mode });

    const blocks: Block[] = [];
    let finalText = '';

    const generator = runAgent({ apiKey, model, history, userText, toolCtx, autoDebug, signal, mode });
    for await (const event of generator as AsyncGenerator<AgentEvent>) {
      if (event.type === 'done') {
        blocks.push(...event.blocks);
        finalText = event.content;
      }
      send(event);
    }

    const saved = await store.addMessage({
      project_id: projectId,
      owner_id: ownerId,
      role: 'assistant',
      content: finalText,
      parts: blocks,
    });
    send({ type: 'saved', message: saved });
  }, request.signal);
}
