import { errorResponse, fail, ok, readJson } from '@/lib/api';
import { DEFAULT_PREVIEW_PORT } from '@/lib/config';
import { getStore } from '@/lib/db';
import { loadProject } from '@/lib/projects';
import { getSandbox, hasE2bKey, previewUrl } from '@/lib/sandbox/manager';
import {
  MAX_WAIT_MS,
  planPreviewRecovery,
  type PreviewStatus,
  type PublicProbe,
} from '@/lib/sandbox/preview-status';
import {
  listServers,
  markServerReady,
  probeLocalPort,
  probePublicUrl,
  readServerRegistry,
  reviveServer,
} from '@/lib/sandbox/tools';
import { owner } from '@/lib/session';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Pembatas agar pemulihan otomatis tidak menumpuk: panel Preview melakukan
 * polling tiap beberapa detik, sementara menjalankan ulang dev server butuh
 * puluhan detik. Tanpa pembatas, beberapa request bisa menyalakan beberapa server
 * sekaligus di port yang sama.
 *
 * Catatan: pembatas ini hanya berlaku di dalam satu proses. Karena itu lapisan
 * kedua ada di dalam sandbox (catatan `startedAt`/`readyAt` di registry server,
 * lihat STARTUP_GRACE_MS) supaya instance serverless yang berbeda pun tidak
 * saling mematikan server.
 */
const REVIVE_COOLDOWN_MS = 30_000;
const reviveThrottle = new Map<string, number>();
const reviveInFlight = new Map<string, Promise<unknown>>();

async function withReviveLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const running = reviveInFlight.get(key);
  if (running) return running as Promise<T>;
  const task = fn().finally(() => reviveInFlight.delete(key));
  reviveInFlight.set(key, task);
  return task;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Tunggu URL publik sampai melayani aplikasi, dengan anggaran waktu terbatas.
 *
 * Ini yang membuat preview "menyembuhkan diri" dalam satu request: setelah server
 * dijalankan, atau saat server sedang menyala, panel tidak perlu diklik ulang
 * berkali-kali oleh user.
 */
async function waitForOnline(url: string, budgetMs: number): Promise<PublicProbe> {
  const deadline = Date.now() + Math.max(0, Math.min(budgetMs, MAX_WAIT_MS));
  let last = await probePublicUrl(url);
  while (!last.online && Date.now() < deadline) {
    await sleep(2_500);
    last = await probePublicUrl(url);
  }
  return last;
}

type Sandbox = Awaited<ReturnType<typeof getSandbox>>['sandbox'];

/**
 * Status preview + (opsional) pemulihan otomatis.
 *
 * Pemulihan inilah yang membuat preview tetap bisa dipakai setelah sandbox
 * di-pause lama (proses dev server hilang saat bangun) atau cold-boot: perintah
 * server terakhir yang tercatat di sandbox dijalankan ulang, lalu statusnya
 * diukur lagi. Server yang BARU dijalankan justru ditunggu (bukan dijalankan
 * ulang) lewat masa tenggang — lihat planPreviewRecovery().
 */
async function inspect(sandbox: Sandbox, port: number, allowRevive: boolean): Promise<PreviewStatus> {
  const url = previewUrl(sandbox, port);
  const key = `${sandbox.sandboxId}:${port}`;

  let local = await probeLocalPort(sandbox, port);
  let publicProbe = await probePublicUrl(url);

  const records = await readServerRegistry(sandbox);
  const record = records.find((r) => r.port === port);
  const plan = planPreviewRecovery({
    publicOnline: publicProbe.online,
    localCode: local.code,
    listenScope: local.scope,
    hasServerRecord: Boolean(record),
    sinceLaunchMs: record ? Date.now() - record.startedAt : null,
    sinceReadyMs: record?.readyAt ? Date.now() - record.readyAt : null,
  });

  let restarted = false;
  let startedCommand: string | null = null;
  let pending = false;
  let reason = plan.reason;

  if (allowRevive && plan.action === 'revive') {
    const last = reviveThrottle.get(key) ?? 0;
    if (Date.now() - last >= REVIVE_COOLDOWN_MS) {
      reviveThrottle.set(key, Date.now());
      const outcome = await withReviveLock(key, () => reviveServer(sandbox, port));
      if (outcome.attempted) {
        restarted = true;
        startedCommand = outcome.command;
        local = await probeLocalPort(sandbox, port);
        publicProbe = await probePublicUrl(url);
        reason = publicProbe.online ? null : (outcome.reason ?? plan.reason);
        if (!publicProbe.online) {
          // Server baru saja dijalankan: beri waktu sebentar di request yang sama
          // (sisanya ditangani polling berikutnya).
          const settled = await waitForOnline(url, 15_000);
          if (settled.online) {
            publicProbe = settled;
            reason = null;
          }
        }
      }
    } else {
      pending = true;
      reason = 'Dev server sedang dijalankan ulang…';
    }
  } else if (allowRevive && plan.action === 'wait') {
    pending = true;
    const settled = await waitForOnline(url, plan.waitMs ?? 10_000);
    if (settled.online) {
      publicProbe = settled;
      reason = null;
      pending = false;
    } else {
      local = await probeLocalPort(sandbox, port);
      reason = plan.reason;
    }
  }

  // Catat peluncuran ini sudah terbukti siap: pemulihan berikutnya (kalau
  // sandbox di-pause dan prosesnya hilang) boleh langsung menjalankan ulang,
  // tanpa menunggu masa tenggang.
  if (publicProbe.online) await markServerReady(sandbox, port);

  return {
    url,
    port,
    status: publicProbe.status,
    online: publicProbe.online,
    localStatus: local.code,
    listenScope: local.scope,
    proxyError: publicProbe.proxyError,
    restarted,
    startedCommand,
    reason,
    pending,
  };
}

/** Ambil URL preview + status server (sekaligus memulihkan server yang mati). */
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
    const status = await inspect(handle.sandbox, port, true);

    return ok({ ...status, servers: listServers(project.sandbox_id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST { port }                        -> set port preview proyek.
 * POST { action: 'restart', port? }    -> jalankan ulang server preview
 *                                         (tombol "Jalankan ulang server").
 */
export async function POST(request: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const ownerId = await owner();
    const body = await readJson<{ port?: number; action?: 'restart' }>(request);
    const { store } = await getStore();
    const project = await loadProject(store, ownerId, id);

    if (body.action !== 'restart') {
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return fail('Port harus antara 1024 dan 65535.', 400);
      const updated = await store.updateProject(ownerId, id, { preview_port: port });
      return ok({ project: updated });
    }

    if (!hasE2bKey()) {
      return fail('E2B_API_KEY belum diisi di environment aplikasi ini, jadi live preview tidak tersedia.', 400);
    }
    if (!project.sandbox_id) return fail('Sandbox belum dibuat untuk proyek ini.', 400);

    const port = Number(body.port) || project.preview_port || DEFAULT_PREVIEW_PORT;
    const handle = await getSandbox(project.sandbox_id, { create: false });
    const status = await inspect(handle.sandbox, port, true);
    return ok({ ...status, servers: listServers(project.sandbox_id) });
  } catch (err) {
    return errorResponse(err);
  }
}
