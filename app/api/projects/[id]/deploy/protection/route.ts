import { deploymentProtectionSettingsUrl, deployLinkNote, vercelAuthenticationNote } from '@/lib/deploy/vercel';
import { getStore } from '@/lib/db';
import { loadProject } from '@/lib/projects';
import { checkDeployLink, disableVercelProtection, fetchVercelProject } from '@/lib/sandbox/tools';
import { effectiveVercel, owner } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

type ProtectionState = {
  /** false = belum bisa diperiksa (mis. token Vercel belum diisi / belum pernah deploy). */
  checked: boolean;
  /** true = link deploy terkunci Deployment Protection (Vercel Authentication). */
  protected: boolean;
  /** true = link bisa dibuka pengunjung tanpa login. */
  public: boolean;
  url: string | null;
  /** Penjelasan + langkah perbaikan (siap ditampilkan). */
  note: string | null;
  /** Halaman pengaturan Deployment Protection proyek ini di Vercel. */
  settingsUrl: string | null;
  reason: string | null;
};

/**
 * Cache singkat per (proyek + link): pemeriksaan ini membuka link deploy dari
 * sisi server, dan panel Preview memanggilnya setiap proyek dibuka — tanpa cache,
 * berpindah-pindah proyek berarti memanggil Vercel berkali-kali tanpa guna.
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; payload: ProtectionState }>();

function publicState(): ProtectionState {
  return { checked: false, protected: false, public: false, url: null, note: null, settingsUrl: null, reason: null };
}

async function checkProtection(options: {
  token: string;
  scope: string;
  projectName: string;
  url: string | null;
}): Promise<ProtectionState> {
  const settingsUrl = deploymentProtectionSettingsUrl({ projectName: options.projectName, scope: options.scope });
  if (!options.url) {
    return { ...publicState(), settingsUrl };
  }
  const [info, link] = await Promise.all([
    fetchVercelProject({ token: options.token, scope: options.scope, projectName: options.projectName }),
    checkDeployLink(options.url),
  ]);
  const protectedFlag = link.restricted || Boolean(info?.protected);
  const note = protectedFlag
    ? link.restricted && link.kind === 'restricted'
      ? deployLinkNote(link, { projectName: options.projectName, scope: options.scope })
      : vercelAuthenticationNote({ projectName: options.projectName, scope: options.scope })
    : deployLinkNote(link, { projectName: options.projectName, scope: options.scope });
  return {
    checked: true,
    protected: protectedFlag,
    public: link.public && !protectedFlag,
    url: options.url,
    note,
    settingsUrl,
    reason: link.reason,
  };
}

/** Status proteksi link deploy proyek ini (dipakai panel Preview saat dibuka). */
export async function GET(_request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const ownerId = await owner();
  const { store } = await getStore();
  const project = await loadProject(store, ownerId, id);
  const vercel = await effectiveVercel(store, ownerId);
  if (!project) return Response.json(publicState(), { status: 404 });
  if (!vercel.token || !project.deploy_url) return Response.json(publicState());

  const projectName = (project.name || 'agentcloud-app').trim();
  const key = `${id}:${project.deploy_url}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Response.json(hit.payload);

  const payload = await checkProtection({
    token: vercel.token,
    scope: vercel.scope,
    projectName,
    url: project.deploy_url,
  });
  cache.set(key, { at: Date.now(), payload });
  return Response.json(payload);
}

/**
 * Matikan Vercel Authentication untuk proyek ini.
 *
 * Dipakai tombol **"Matikan proteksi"** di panel Preview: link deploy sudah
 * tampil tapi pengunjung hanya melihat halaman login/404 Vercel. Token diambil
 * server-side dan hanya dikirim sebagai header Authorization ke API Vercel —
 * tidak pernah dikembalikan ke browser. Mematikan Vercel Authentication juga
 * langsung membuka deployment yang SUDAH ada (tidak perlu deploy ulang).
 */
export async function POST(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const ownerId = await owner();
  const body = (await request.json().catch(() => ({}))) as { projectName?: string };

  const { store } = await getStore();
  const project = await loadProject(store, ownerId, id);
  const vercel = await effectiveVercel(store, ownerId);
  if (!project) return Response.json({ ok: false, message: 'Proyek tidak ditemukan.' }, { status: 404 });
  if (!vercel.token) {
    return Response.json(
      {
        ok: false,
        message:
          'Token Vercel belum diisi, jadi proteksi tidak bisa dimatikan dari sini. Buka Settings → "Token deploy Vercel".',
      },
      { status: 400 },
    );
  }

  const projectName = (body.projectName || project.name || 'agentcloud-app').trim();
  const result = await disableVercelProtection({ token: vercel.token, scope: vercel.scope, projectName });
  const state = await checkProtection({
    token: vercel.token,
    scope: vercel.scope,
    projectName,
    url: project.deploy_url ?? null,
  });
  cache.set(`${id}:${project.deploy_url ?? ''}`, { at: Date.now(), payload: state });

  return Response.json({
    ok: result.ok && !state.protected,
    message: result.ok
      ? state.public
        ? 'Proteksi dimatikan dan linknya sudah bisa dibuka publik.'
        : `${result.message} Link belum bisa diverifikasi publik — coba buka lagi sebentar.`
      : result.message,
    state,
  });
}
