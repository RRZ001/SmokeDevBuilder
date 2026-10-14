'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ChatPanel from './ChatPanel';
import CodePanel, { type PreviewState } from './CodePanel';
import ProjectRail from './ProjectRail';
import SettingsModal from './SettingsModal';
import type { TerminalLine } from './TerminalPanel';
import { GearIcon, MenuIcon } from './icons';
import { apiJson, setStoredOwner, streamNdjson } from '@/lib/client';
import { cn } from '@/lib/util';
import {
  toUiBlocks,
  type BootstrapResponse,
  type FileEntry,
  type ProjectLite,
  type UiBlock,
  type UiMessage,
  type UiToolBlock,
} from './types';

type MobileView = 'code' | 'chat';
type Tab = 'editor' | 'terminal' | 'preview';

const DEFAULT_SETTINGS: BootstrapResponse['settings'] = {
  model: 'anthropic/claude-sonnet-4.5',
  hasKey: false,
  keySource: 'none',
  keyPreview: '',
  updatedAt: null,
  vercel: { hasToken: false, tokenPreview: '', tokenSource: 'none', scope: '' },
};

const DEFAULT_CAPS: BootstrapResponse['capabilities'] = {
  openrouterFromEnv: false,
  e2bFromEnv: false,
  supabaseConfigured: false,
  supabaseRole: 'none',
  sandboxDir: '/home/user/project',
  defaultPreviewPort: 3000,
  storage: {
    configured: 'sqlite',
    active: 'sqlite',
    supabaseConfigured: false,
    supabaseRole: 'none',
    supabaseError: null,
  },
};

export default function Workspace() {
  const [booted, setBooted] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [owner, setOwner] = useState('');
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [capabilities, setCapabilities] = useState(DEFAULT_CAPS);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [live, setLive] = useState<UiBlock[] | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [mode, setMode] = useState<'agent' | 'chat'>('chat');
  const [autoDebug, setAutoDebug] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileView, setMobileView] = useState<MobileView>('code');
  const [tab, setTab] = useState<Tab>('editor');

  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesReason, setFilesReason] = useState<string | null>(null);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<{ path: string; content: string } | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileSaving, setFileSaving] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([]);
  const [terminalRunning, setTerminalRunning] = useState(false);
  const [sandboxBusy, setSandboxBusy] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployNote, setDeployNote] = useState<string | null>(null);
  const [disablingProtection, setDisablingProtection] = useState(false);
  /**
   * Masalah link deploy selain proteksi — paling sering: deployment dibuat tapi
   * tidak menyajikan halaman apa pun (404 di SEMUA alamat), biasanya karena
   * folder yang dikirim ke Vercel bukan folder aplikasi.
   */
  const [deployWarning, setDeployWarning] = useState<string | null>(null);
  /**
   * Status Deployment Protection link deploy aktif: link hidup tapi pengunjung
   * lain hanya melihat login/404 Vercel. Diperiksa saat proyek dibuka (panel
   * Preview) dan saat deploy selesai, supaya user tidak mengira linknya siap
   * dibagikan.
   */
  const [protection, setProtection] = useState<{ protected: boolean; note: string | null; settingsUrl: string | null }>({
    protected: false,
    note: null,
    settingsUrl: null,
  });
  const [preview, setPreview] = useState<PreviewState>({
    url: null,
    port: 3000,
    status: '000',
    online: false,
    loading: false,
    reason: null,
    pending: false,
    issue: null,
  });

  const abortRef = useRef<AbortController | null>(null);
  /** Salinan terbaru refreshPreview untuk dipakai di dalam handler stream. */
  const refreshPreviewRef = useRef<((projectId?: string, silent?: boolean) => Promise<void>) | null>(null);
  /**
   * Status online terbaru untuk timer polling (tanpa ref, menaruh `preview.online`
   * di dependency efek akan me-reset timer setiap kali statusnya berubah).
   */
  const previewOnlineRef = useRef(false);
  const lineId = useRef(0);
  const autoCreated = useRef(false);

  const activeProject = useMemo(() => projects.find((p) => p.id === activeId) ?? null, [projects, activeId]);

  /**
   * Total pemakaian token & perkiraan biaya sesi ini. Dihitung dari blok usage
   * yang tersimpan bersama pesan, jadi angkanya tetap benar setelah reload.
   */
  const sessionUsage = useMemo(() => {
    const total = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0, hasCost: false };
    const scan = (blocks: UiBlock[] | null) => {
      for (const block of blocks ?? []) {
        if (block.type !== 'usage') continue;
        total.promptTokens += block.promptTokens;
        total.completionTokens += block.completionTokens;
        total.cachedTokens += block.cachedTokens ?? 0;
        if (typeof block.costUsd === 'number') {
          total.costUsd += block.costUsd;
          total.hasCost = true;
        }
      }
    };
    messages.forEach((message) => scan(message.blocks));
    scan(live);
    return total;
  }, [messages, live]);

  const pushLine = useCallback((kind: TerminalLine['kind'], text: string) => {
    if (!text) return;
    lineId.current += 1;
    setTerminalLines((prev) => [...prev.slice(-400), { id: `l${lineId.current}`, kind, text }]);
  }, []);

  /* ------------------------------------------------------------------ boot */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiJson<BootstrapResponse>('/api/bootstrap');
        if (cancelled) return;
        setStoredOwner(data.owner);
        setOwner(data.owner);
        setSettings(data.settings);
        setCapabilities(data.capabilities);
        setPreview((p) => ({ ...p, port: data.capabilities.defaultPreviewPort }));
        setProjects(data.projects);
        if (data.projects.length) {
          setActiveId(data.projects[0].id);
        } else if (!autoCreated.current) {
          autoCreated.current = true;
          const created = await apiJson<{ project: ProjectLite }>('/api/projects', {
            method: 'POST',
            body: JSON.stringify({ name: 'Proyek pertama', description: 'Workspace default untuk agent' }),
          });
          if (!cancelled) {
            setProjects([created.project]);
            setActiveId(created.project.id);
          }
        }
        if (!data.settings.hasKey) setSettingsOpen(true);
      } catch (err) {
        if (!cancelled) setFatal(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setBooted(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* --------------------------------------------------- muat data per proyek */
  const loadMessages = useCallback(async (projectId: string) => {
    try {
      const data = await apiJson<{ messages: Array<{ id: string; role: UiMessage['role']; content: string; parts: UiBlock[] | null; created_at: string }> }>(
        `/api/projects/${projectId}/messages`,
      );
      setMessages(
        data.messages.map((m) => ({
          id: m.id,
          role: m.role,
          blocks: toUiBlocks(m.parts, m.content),
          created_at: m.created_at,
        })),
      );
    } catch (err) {
      pushLine('error', err instanceof Error ? err.message : String(err));
    }
  }, [pushLine]);

  const refreshFiles = useCallback(
    async (projectId?: string) => {
      const id = projectId ?? activeId;
      if (!id) return;
      setFilesLoading(true);
      try {
        const data = await apiJson<{ files: FileEntry[]; reason?: string }>(`/api/projects/${id}/sandbox/files`);
        setFiles(data.files ?? []);
        setFilesReason(data.reason ?? null);
      } catch (err) {
        setFiles([]);
        setFilesReason(err instanceof Error ? err.message : String(err));
      } finally {
        setFilesLoading(false);
      }
    },
    [activeId],
  );

  const refreshPreview = useCallback(
    async (projectId?: string, silent = false) => {
      const id = projectId ?? activeId;
      if (!id) return;
      // Tanpa E2B_API_KEY tidak ada sandbox yang bisa dicek - hindari request yang pasti gagal.
      if (!capabilities.e2bFromEnv) {
        setPreview((p) => ({
          ...p,
          loading: false,
          online: false,
          status: '000',
          reason: 'E2B_API_KEY belum diisi di environment aplikasi ini, jadi cloud sandbox & live preview belum tersedia (key hanya bisa dipasang lewat variabel environment hosting, bukan dari Settings).',
        }));
        return;
      }
      if (!silent) setPreview((p) => ({ ...p, loading: true }));
      try {
        const data = await apiJson<{
          url: string;
          port: number;
          status: string;
          online: boolean;
          listenScope?: PreviewState['listenScope'];
          restarted?: boolean;
          proxyError?: boolean;
          pending?: boolean;
          issue?: PreviewState['issue'];
          reason?: string | null;
        }>(`/api/projects/${id}/sandbox/preview`);
        setPreview((p) => ({
          ...p,
          url: data.url,
          port: data.port,
          status: data.status,
          online: data.online,
          loading: false,
          reason: data.reason ?? null,
          listenScope: data.listenScope ?? null,
          restarted: Boolean(data.restarted),
          proxyError: Boolean(data.proxyError),
          pending: Boolean(data.pending),
          issue: data.issue ?? null,
        }));
      } catch (err) {
        setPreview((p) => ({
          ...p,
          loading: false,
          online: false,
          status: '000',
          pending: false,
          issue: null,
          reason: err instanceof Error ? err.message : String(err),
        }));
      }
    },
    [activeId, capabilities.e2bFromEnv],
  );

  useEffect(() => {
    refreshPreviewRef.current = refreshPreview;
  }, [refreshPreview]);

  useEffect(() => {
    previewOnlineRef.current = preview.online;
  }, [preview.online]);

  /**
   * Pantau & pulihkan preview secara otomatis selama tab Preview terlihat.
   *
   * Kenapa tidak berhenti setelah beberapa percobaan seperti dulu: dev server di
   * sandbox dingin butuh jauh lebih lama (unduh dependency + kompilasi) dan
   * sandbox yang di-pause membuat prosesnya hilang. Dulu polling berhenti setelah
   * ~36 detik, sehingga user-lah yang harus menekan "Jalankan ulang server" atau
   * meminta agent — persis keluhan "preview sering mati dan harus diminta dulu".
   *
   * Sekarang: cek segera saat tab dibuka, ulangi tiap 5 detik saat belum online
   * (server sedang disiapkan/dihidupkan), dan tiap 20 detik saat sudah online
   * (mendeteksi server yang mati saat user sedang melihatnya). Server yang mati
   * dihidupkan ulang di sisi server oleh route /sandbox/preview.
   */
  useEffect(() => {
    if (tab !== 'preview' || !activeId || !capabilities.e2bFromEnv) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delay: number) => {
      if (stopped) return;
      timer = setTimeout(run, delay);
    };

    const run = async () => {
      if (stopped) return;
      // Tab sedang tidak terlihat: jangan memanggil sandbox (hemat kuota E2B dan
      // tidak menghidupkan server yang tidak sedang dilihat).
      if (document.hidden) {
        schedule(10_000);
        return;
      }
      await refreshPreviewRef.current?.(activeId, true);
      schedule(previewOnlineRef.current ? 20_000 : 5_000);
    };

    schedule(250);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [tab, activeId, capabilities.e2bFromEnv]);

  /**
   * Kembali ke halaman/tab ini → periksa sekali lagi. Sandbox E2B auto-resume,
   * jadi begitu user kembali, preview biasanya sudah bisa dihidupkan ulang tanpa
   * perlu menunggu siklus polling.
   */
  useEffect(() => {
    if (tab !== 'preview' || !activeId || !capabilities.e2bFromEnv) return;
    const onFocus = () => {
      if (!document.hidden) void refreshPreviewRef.current?.(activeId, true);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [tab, activeId, capabilities.e2bFromEnv]);

  useEffect(() => {
    if (!activeId) return;
    setTerminalLines([]);
    setOpenFile(null);
    setOpenFilePath(null);
    setLive(null);
    const project = projects.find((p) => p.id === activeId);
    setSandboxId(project?.sandbox_id ?? null);
    setPreview((p) => ({ ...p, port: project?.preview_port ?? p.port, online: false, url: null, status: '000', pending: false, issue: null }));
    void loadMessages(activeId);
    void refreshFiles(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  /* --------------------------------------------------------------- kirim chat */
  const handleSend = useCallback(
    async (text: string) => {
      if (!activeId || running) return;
      const optimisticId = `local-${Date.now()}`;
      setMessages((prev) => [...prev, { id: optimisticId, role: 'user', blocks: [{ type: 'text', text }], created_at: new Date().toISOString() }]);
      setLive([]);
      setRunning(true);
      setStatus('Menghubungi model…');
      setMobileView('chat');

      const controller = new AbortController();
      abortRef.current = controller;

      const blocks: UiBlock[] = [];
      const toolIndex = new Map<string, number>();
      let saved = false;

      const flush = () => setLive([...blocks]);

      try {
        const stream = streamNdjson(
          '/api/chat',
          { projectId: activeId, message: text, autoDebug },
          controller.signal,
        );

        for await (const event of stream) {
          switch (event.type) {
            case 'message': {
              const saved0 = event.message as { id: string; created_at: string };
              setMessages((prev) => prev.map((m) => (m.id === optimisticId ? { ...m, id: saved0.id, created_at: saved0.created_at } : m)));
              break;
            }
            case 'model':
              setSettings((s) => ({ ...s, model: String(event.model) }));
              break;
            case 'mode':
              setMode(event.mode === 'agent' ? 'agent' : 'chat');
              break;
            case 'sandbox':
              setSandboxId(String(event.sandboxId));
              break;
            case 'notice': {
              // Peringatan/kesalahan dari server (mis. E2B gagal disiapkan).
              // Sebelumnya event ini tidak dirender sehingga user hanya melihat
              // pil "Mode diskusi" tanpa penjelasan apa pun.
              blocks.push({
                type: 'notice',
                level: (event.level === 'error' ? 'error' : event.level === 'info' ? 'info' : 'warn') as
                  | 'info'
                  | 'warn'
                  | 'error',
                text: String(event.message ?? ''),
              });
              flush();
              break;
            }
            case 'project': {
              const project = event.project as ProjectLite;
              setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, ...project } : p)));
              break;
            }
            case 'status':
              setStatus(String(event.message));
              break;
            case 'retry': {
              // OpenRouter membatasi permintaan sementara (mis. 429 admission
              // control) - aplikasi menunggu sesuai Retry-After lalu mencoba lagi.
              const secs = Math.max(1, Math.round(Number(event.waitMs) / 1000));
              setStatus(
                `OpenRouter membatasi permintaan sementara — mencoba lagi dalam ${secs} detik (percobaan ${event.attempt}/${event.maxAttempts})`,
              );
              break;
            }
            case 'log':
              pushLine('info', String(event.value));
              break;
            case 'text': {
              const last = blocks[blocks.length - 1];
              if (last && last.type === 'text') last.text += String(event.value);
              else blocks.push({ type: 'text', text: String(event.value) });
              flush();
              break;
            }
            case 'reasoning': {
              const last = blocks[blocks.length - 1];
              if (last && last.type === 'reasoning') last.text += String(event.value);
              else blocks.push({ type: 'reasoning', text: String(event.value) });
              flush();
              break;
            }
            case 'tool_start': {
              const id = String(event.id);
              const index = blocks.push({
                type: 'tool',
                id,
                name: String(event.name),
                args: (event.args ?? {}) as Record<string, unknown>,
                status: 'running',
              }) - 1;
              toolIndex.set(id, index);
              flush();
              break;
            }
            case 'tool_output': {
              const index = toolIndex.get(String(event.id));
              if (index != null) {
                const block = blocks[index] as UiToolBlock;
                block.liveOutput = `${block.liveOutput ?? ''}${String(event.value)}`;
                flush();
              }
              break;
            }
            case 'tool_result': {
              const index = toolIndex.get(String(event.id));
              if (index != null) {
                const block = blocks[index] as UiToolBlock;
                block.status = event.ok ? 'ok' : 'error';
                block.output = String(event.output ?? '');
                if (event.previewUrl) block.previewUrl = String(event.previewUrl);
                flush();
              }
              if (!event.ok) pushLine('error', `${String(event.name)} gagal\n${String(event.output ?? '').slice(0, 600)}`);
              break;
            }
            case 'preview': {
              const port = Number(event.port) || 3000;
              // JANGAN menganggap server sudah hidup: agent sering melaporkan URL
              // sebelum prosesnya benar-benar listen, dan menganggapnya online
              // membuat iframe menampilkan halaman error E2B ("Closed Port Error").
              // Set URL-nya saja, lalu biarkan pengecekan status yang menentukan.
              setPreview((p) => ({
                ...p,
                url: String(event.url),
                port,
                online: false,
                loading: true,
                reason: null,
                listenScope: null,
                restarted: false,
                proxyError: false,
                pending: true,
                issue: null,
              }));
              void apiJson(`/api/projects/${activeId}/sandbox/preview`, {
                method: 'POST',
                body: JSON.stringify({ port }),
              }).catch(() => undefined);
              void refreshPreviewRef.current?.(activeId, true);
              break;
            }
            case 'choices': {
              // Blok pilihan: tombol yang bisa langsung diklik user.
              // Karena ini bagian dari jawaban model pada giliran yang sama,
              // blok ini ikut tersimpan (route mengirimnya lewat event 'done').
              const questions = Array.isArray(event.questions) ? event.questions : [];
              if (questions.length) {
                blocks.push({ type: 'choices', questions } as UiBlock);
                flush();
              }
              break;
            }
            case 'plan': {
              // Daftar rencana yang dicentang seiring pekerjaan berjalan.
              const items = Array.isArray(event.items) ? event.items : [];
              if (items.length) {
                blocks.push({ type: 'plan', items } as UiBlock);
                flush();
              }
              break;
            }
            case 'image': {
              // Screenshot dari browser_check. Hanya tampil selama sesi ini —
              // sengaja TIDAK disimpan ke database karena ukurannya besar.
              blocks.push({
                type: 'image',
                dataUrl: String(event.dataUrl),
                caption: String(event.caption ?? ''),
              } as UiBlock);
              flush();
              break;
            }
            case 'usage': {
              // Pemakaian token per langkah: diperbarui di blok usage (satu per giliran).
              const value = event.value as { promptTokens?: number; completionTokens?: number; cachedTokens?: number; costUsd?: number };
              const existing = blocks.findIndex((b) => b.type === 'usage');
              const usageBlock = {
                type: 'usage' as const,
                promptTokens: Number(value?.promptTokens) || 0,
                completionTokens: Number(value?.completionTokens) || 0,
                cachedTokens: Number(value?.cachedTokens) || 0,
                costUsd: typeof value?.costUsd === 'number' ? value.costUsd : undefined,
              };
              if (existing >= 0) blocks[existing] = usageBlock;
              else blocks.push(usageBlock);
              flush();
              break;
            }
            case 'error': {
              blocks.push({ type: 'notice', level: 'error', text: String(event.message) });
              flush();
              break;
            }
            case 'saved': {
              const message = event.message as { id: string; created_at: string; parts: UiBlock[] | null; content: string };
              saved = true;
              setMessages((prev) => [
                ...prev,
                { id: message.id, role: 'assistant', blocks: toUiBlocks(message.parts, message.content), created_at: message.created_at },
              ]);
              setLive(null);
              break;
            }
            default:
              break;
          }
        }
      } catch (err) {
        const aborted = err instanceof DOMException && err.name === 'AbortError';
        if (aborted) blocks.push({ type: 'notice', level: 'info', text: 'Dihentikan oleh kamu.' });
        else blocks.push({ type: 'notice', level: 'error', text: err instanceof Error ? err.message : String(err) });
        flush();
      } finally {
        if (!saved) {
          if (blocks.length) {
            setMessages((prev) => [
              ...prev,
              { id: `assistant-${Date.now()}`, role: 'assistant', blocks, created_at: new Date().toISOString() },
            ]);
          }
          setLive(null);
        }
        setRunning(false);
        setStatus(null);
        abortRef.current = null;
        void refreshFiles(activeId);
        void refreshPreview(activeId, true);
      }
    },
    [activeId, running, autoDebug, pushLine, refreshFiles, refreshPreview],
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /* ---------------------------------------------------------- proyek CRUD */
  const createProject = useCallback(
    async (name: string, description: string) => {
      const data = await apiJson<{ project: ProjectLite }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name, description }),
      });
      setProjects((prev) => [data.project, ...prev]);
      setActiveId(data.project.id);
    },
    [],
  );

  const deleteProject = useCallback(
    async (id: string) => {
      if (!window.confirm('Hapus proyek ini beserta riwayat chat-nya? Sandbox-nya juga akan dimatikan.')) return;
      try {
        await apiJson(`/api/projects/${id}`, { method: 'DELETE' });
        setProjects((prev) => {
          const next = prev.filter((p) => p.id !== id);
          if (id === activeId) setActiveId(next[0]?.id ?? null);
          return next;
        });
      } catch (err) {
        pushLine('error', err instanceof Error ? err.message : String(err));
      }
    },
    [activeId, pushLine],
  );

  /* ------------------------------------------------------------ file & exec */
  const openFileHandler = useCallback(
    async (path: string) => {
      if (!activeId) return;
      setOpenFilePath(path);
      setFileLoading(true);
      setFileError(null);
      setTab('editor');
      try {
        const data = await apiJson<{ file: { path: string; content: string } }>(
          `/api/projects/${activeId}/sandbox/file?path=${encodeURIComponent(path)}`,
        );
        setOpenFile({ path: data.file.path, content: data.file.content });
      } catch (err) {
        setOpenFile(null);
        setFileError(err instanceof Error ? err.message : String(err));
      } finally {
        setFileLoading(false);
      }
    },
    [activeId],
  );

  const saveFile = useCallback(
    async (path: string, content: string) => {
      if (!activeId) return;
      setFileSaving(true);
      setFileError(null);
      try {
        await apiJson(`/api/projects/${activeId}/sandbox/file`, {
          method: 'PUT',
          body: JSON.stringify({ path, content }),
        });
        setOpenFile({ path, content });
      } catch (err) {
        setFileError(err instanceof Error ? err.message : String(err));
      } finally {
        setFileSaving(false);
      }
    },
    [activeId],
  );

  const runCommand = useCallback(
    async (command: string) => {
      if (!activeId || terminalRunning) return;
      setTerminalRunning(true);
      setTab('terminal');
      setMobileView('code');
      pushLine('command', command);
      try {
        for await (const event of streamNdjson(`/api/projects/${activeId}/sandbox/exec`, { command })) {
          if (event.type === 'output') pushLine('output', String(event.value));
          else if (event.type === 'status') pushLine('command', String(event.message).replace(/^\$\s*/, ''));
          else if (event.type === 'error') pushLine('error', String(event.message));
          else if (event.type === 'exit') pushLine('info', `— exit code ${String(event.code)} —`);
        }
      } catch (err) {
        pushLine('error', err instanceof Error ? err.message : String(err));
      } finally {
        setTerminalRunning(false);
        void refreshFiles(activeId);
        void refreshPreview(activeId, true);
      }
    },
    [activeId, terminalRunning, pushLine, refreshFiles, refreshPreview],
  );

  const sandboxAction = useCallback(
    async (action: 'start' | 'reset' | 'stop') => {
      if (!activeId || sandboxBusy) return;

      /**
       * "reset" dan "stop" sama-sama MEMATIKAN sandbox secara permanen, dan
       * seluruh file proyek di dalamnya ikut hilang (tidak bisa dipulihkan).
       * Tanpa konfirmasi, tombol berlabel "Sandbox baru" mudah ditekan tanpa
       * sadar bahwa kodenya akan hilang - ini sudah pernah menimpa pekerjaan user.
       */
      if (action === 'reset') {
        const ok = window.confirm(
          'Buat sandbox baru?\n\n' +
            'Sandbox lama akan dihapus. Kode proyek sudah tersimpan di database dan akan dipulihkan otomatis ' +
            'ke sandbox baru, TAPI dependency (node_modules) dan proses yang sedang jalan tidak ikut — ' +
            'jadi perlu "npm install" dan menjalankan server lagi.\n\n' +
            'Kalau hanya ingin melanjutkan pekerjaan yang ada, tutup saja dialog ini — sandbox otomatis di-pause ' +
            'saat idle dan bangun sendiri saat dipakai lagi.',
        );
        if (!ok) return;
      }
      if (action === 'stop') {
        const ok = window.confirm(
          'Hentikan sandbox?\n\n' +
            'Sandbox akan dihapus permanen. Kode proyek tersimpan di database (akan disimpan dulu sebelum dihapus), ' +
            'tapi dependency dan proses yang sedang jalan hilang.\n\n' +
            'Untuk sekadar berhenti bekerja, tidak perlu menekan ini — cukup tinggalkan saja, sandbox otomatis ' +
            'di-pause (tidak ditagih) dan isinya tetap utuh.',
        );
        if (!ok) return;
      }

      setSandboxBusy(true);
      setMobileView('code');
      setTab('terminal');
      pushLine('info', `— ${action} sandbox —`);
      try {
        for await (const event of streamNdjson(`/api/projects/${activeId}/sandbox`, { action })) {
          if (event.type === 'status') pushLine('info', String(event.message));
          else if (event.type === 'log') pushLine('output', String(event.value));
          else if (event.type === 'sandbox') {
            const id = String(event.sandboxId);
            setSandboxId(id);
            setProjects((prev) => prev.map((p) => (p.id === activeId ? { ...p, sandbox_id: id } : p)));
          } else if (event.type === 'preview') {
            setPreview((p) => ({ ...p, url: String(event.url), port: Number(event.port) || p.port, online: false, reason: null }));
          } else if (event.type === 'error') pushLine('error', String(event.message));
          else if (event.type === 'done') pushLine('info', '— selesai —');
        }
      } catch (err) {
        pushLine('error', err instanceof Error ? err.message : String(err));
      } finally {
        setSandboxBusy(false);
        void refreshFiles(activeId);
        void refreshPreview(activeId, true);
      }
    },
    [activeId, sandboxBusy, pushLine, refreshFiles, refreshPreview],
  );

  const setPreviewPort = useCallback(
    async (port: number) => {
      if (!activeId) return;
      setPreview((p) => ({ ...p, port }));
      try {
        await apiJson(`/api/projects/${activeId}/sandbox/preview`, { method: 'POST', body: JSON.stringify({ port }) });
      } catch {
        /* port hanya preferensi */
      }
      void refreshPreview(activeId);
    },
    [activeId, refreshPreview],
  );

  /**
   * Jalankan ulang dev server di sandbox (perintah terakhir yang dipakai agent).
   * Dipakai tombol "Jalankan ulang server" saat preview tidak merespons - mis.
   * setelah sandbox bangun dari pause sehingga proses dev server-nya hilang.
   */
  const restartPreview = useCallback(async () => {
    if (!activeId) return;
    setPreview((p) => ({ ...p, loading: true }));
    try {
      const data = await apiJson<{
        url: string;
        port: number;
        status: string;
        online: boolean;
        listenScope?: PreviewState['listenScope'];
        restarted?: boolean;
        proxyError?: boolean;
        pending?: boolean;
        issue?: PreviewState['issue'];
        reason?: string | null;
        startedCommand?: string | null;
      }>(`/api/projects/${activeId}/sandbox/preview`, {
        method: 'POST',
        body: JSON.stringify({ action: 'restart', port: preview.port }),
      });
      setPreview((p) => ({
        ...p,
        url: data.url,
        port: data.port,
        status: data.status,
        online: data.online,
        loading: false,
        reason: data.reason ?? null,
        listenScope: data.listenScope ?? null,
        restarted: Boolean(data.restarted),
        proxyError: Boolean(data.proxyError),
        pending: Boolean(data.pending),
        issue: data.issue ?? null,
      }));
      pushLine(
        data.online ? 'info' : 'error',
        data.online
          ? `Dev server dijalankan ulang: ${data.startedCommand ?? '(perintah tersimpan)'}`
          : `Gagal menjalankan ulang dev server.\n${data.reason ?? 'Tidak ada perintah server yang tersimpan — minta agent menjalankan start_server.'}`,
      );
    } catch (err) {
      setPreview((p) => ({ ...p, loading: false }));
      pushLine('error', `Gagal menjalankan ulang dev server: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [activeId, preview.port, pushLine]);

  /**
   * Deploy proyek ke akun Vercel user → link PERMANEN yang tetap hidup walaupun
   * sandbox dimatikan (user memilih: deploy hanya saat diminta).
   *
   * Log deploy di-stream ke tab Terminal supaya prosesnya terlihat, dan link
   * hasilnya disimpan di proyek (bertahan setelah reload).
   */
  const deployProject = useCallback(async () => {
    if (!activeId || deploying) return;
    setDeploying(true);
    setDeployNote('Menjalankan deploy…');
    setMobileView('code');
    setTab('terminal');
    pushLine('info', '— deploy ke Vercel —');
    /**
     * Deploy bisa lebih lama daripada batas durasi satu request, jadi server
     * membalas `deploy_pending` dan prosesnya tetap berjalan DI SANDBOX. Di sini
     * pemantauan dilanjutkan otomatis (bukan menyuruh user menekan tombol lagi),
     * dan server mengenali permintaan lanjutan lewat PID proses yang masih hidup —
     * jadi tidak ada deployment kedua yang sia-sia.
     */
    const MAX_ATTEMPTS = 3;
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        let pending = false;
        for await (const event of streamNdjson(`/api/projects/${activeId}/deploy`, {
          cwd: undefined,
          projectName: activeProject?.name,
        })) {
          if (event.type === 'log') {
            const value = String(event.value ?? '').trim();
            if (value) pushLine('output', value);
          } else if (event.type === 'deploy_url') {
            const url = String(event.url);
            const at = String(event.deployAt ?? new Date().toISOString());
            setDeployNote(null);
            // Deploy baru = status proteksi diperiksa ulang; event
            // `deploy_protected` menyusul kalau ternyata masih terkunci.
            setProtection({ protected: false, note: null, settingsUrl: null });
            setDeployWarning(null);
            setProjects((prev) => prev.map((p) => (p.id === activeId ? { ...p, deploy_url: url, deploy_at: at } : p)));
            pushLine('info', `Selesai! Link permanen: ${url}`);
          } else if (event.type === 'deploy_protected') {
            // Link hidup tapi terkunci Vercel Authentication — tampilkan
            // peringatan + tombol "Matikan proteksi", jangan biarkan user
            // membagikan link yang cuma menampilkan halaman login Vercel.
            const note = event.message ? String(event.message) : null;
            setProtection({
              protected: true,
              note,
              settingsUrl: event.settingsUrl ? String(event.settingsUrl) : null,
            });
            setProjects((prev) => prev.map((p) => (p.id === activeId ? { ...p, deploy_url: String(event.url) } : p)));
            if (note) pushLine('error', note);
          } else if (event.type === 'deploy_warning') {
            const message = String(event.message ?? 'Link deploy belum menyajikan aplikasi.');
            setDeployWarning(message);
            pushLine('error', message);
          } else if (event.type === 'deploy_pending') {
            pending = true;
            const message = String(event.message ?? 'Deploy masih berjalan di Vercel.');
            setDeployNote(
              attempt < MAX_ATTEMPTS ? `${message} (percobaan ${attempt}/${MAX_ATTEMPTS})` : message,
            );
            pushLine('info', message);
          } else if (event.type === 'deploy_error') {
            const message = String(event.message ?? 'Deploy gagal.');
            setDeployNote(message);
            pushLine('error', message);
          } else if (event.type === 'error') {
            pushLine('error', String(event.message));
          }
        }
        if (!pending) break;
        if (attempt === MAX_ATTEMPTS) break;
        await new Promise((resolve) => setTimeout(resolve, 8_000));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDeployNote(message);
      pushLine('error', `Deploy gagal: ${message}`);
    } finally {
      setDeploying(false);
    }
  }, [activeId, activeProject?.name, deploying, pushLine]);

  /**
   * Periksa status Deployment Protection link deploy proyek aktif (dari server;
   * token Vercel tidak pernah ke browser). Dipanggil saat proyek dibuka supaya
   * peringatan "link masih terkunci" tetap muncul setelah reload.
   */
  useEffect(() => {
    if (!activeId || !activeProject?.deploy_url) {
      setProtection({ protected: false, note: null, settingsUrl: null });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const state = await apiJson<{
          protected?: boolean;
          note?: string | null;
          settingsUrl?: string | null;
        }>(`/api/projects/${activeId}/deploy/protection`);
        if (cancelled) return;
        setProtection({
          protected: Boolean(state.protected),
          note: state.note ?? null,
          settingsUrl: state.settingsUrl ?? null,
        });
      } catch {
        // Status proteksi bersifat informasi — kegagalan pemeriksaan tidak boleh
        // mengganggu workspace (biarkan tanpa peringatan).
        if (!cancelled) setProtection({ protected: false, note: null, settingsUrl: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId, activeProject?.deploy_url]);

  /** Tombol "Matikan proteksi" — lewat API Vercel memakai token di Settings. */
  const disableDeployProtection = useCallback(async () => {
    if (!activeId || disablingProtection) return;
    setDisablingProtection(true);
    setDeployNote('Mematikan Deployment Protection…');
    try {
      const result = await apiJson<{
        ok?: boolean;
        message?: string;
        state?: { protected?: boolean; note?: string | null; settingsUrl?: string | null };
      }>(`/api/projects/${activeId}/deploy/protection`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectName: activeProject?.name }),
      });
      const next = result.state;
      setProtection({
        protected: Boolean(next?.protected),
        note: next?.note ?? null,
        settingsUrl: next?.settingsUrl ?? null,
      });
      const message = result.message ?? (result.ok ? 'Proteksi dimatikan.' : 'Gagal mematikan proteksi.');
      setDeployNote(result.ok ? null : message);
      pushLine(result.ok ? 'info' : 'error', message);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDeployNote(message);
      pushLine('error', message);
    } finally {
      setDisablingProtection(false);
    }
  }, [activeId, activeProject?.name, disablingProtection, pushLine]);

  const storageLabel = useMemo(() => {
    const storage = capabilities.storage;
    if (!storage.supabaseConfigured) return capabilities.storageEphemeral ? 'Sementara' : 'SQLite';
    return storage.active === 'supabase' ? 'Supabase' : 'SQLite (fallback)';
  }, [capabilities.storage, capabilities.storageEphemeral]);

  /**
   * Hosting serverless (Vercel/Lambda) tidak punya disk persisten: tanpa Supabase
   * riwayat chat & proyek hilang setiap kali instance berganti/reload.
   */
  /** Peringatan khusus penyimpanan file proyek (mis. tabel ac_files belum ada). */
  const filesNotice = useMemo(() => {
    const warning = capabilities.filesPersistenceWarning;
    if (!warning) return null;
    return `Penyimpanan file proyek tidak aktif: ${warning}`;
  }, [capabilities.filesPersistenceWarning]);

  const storageNotice = useMemo(() => {
    if (!capabilities.storageEphemeral) return null;
    return 'Penyimpanan sementara: hosting serverless (mis. Vercel) tidak menyimpan data ke disk, jadi riwayat chat & daftar proyek akan hilang setelah reload atau tidak aktif. Hubungkan Supabase (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY di Environment Variables) agar data permanen.';
  }, [capabilities.storageEphemeral]);

  if (!booted) {
    return (
      <div className="flex h-screen items-center justify-center bg-ink-950">
        <div className="flex items-center gap-3 text-ink-300">
          <span className="flex gap-1">
            <i className="h-2 w-2 rounded-full bg-accent-500 animate-pulse-dot" />
            <i className="h-2 w-2 rounded-full bg-accent-500 animate-pulse-dot [animation-delay:150ms]" />
            <i className="h-2 w-2 rounded-full bg-accent-500 animate-pulse-dot [animation-delay:300ms]" />
          </span>
          Menyiapkan workspace…
        </div>
      </div>
    );
  }

  if (fatal) {
    return (
      <div className="flex h-screen items-center justify-center bg-ink-950 p-6">
        <div className="max-w-md rounded-2xl border border-rose-400/30 bg-rose-400/10 p-5 text-[13px] text-rose-200">
          <p className="font-semibold">Gagal memuat workspace</p>
          <p className="mt-1 break-words">{fatal}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-3 rounded-lg border border-white/20 px-3 py-1.5 text-[12.5px] text-white hover:bg-white/10"
          >
            Muat ulang
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-ink-950">
      {/* top bar khusus layar kecil */}
      <header className="flex items-center gap-2 border-b border-white/[0.06] bg-ink-900 px-3 py-2 lg:hidden">
        <MenuIcon className="h-4 w-4 text-ink-400" />
        <select
          value={activeId ?? ''}
          onChange={(e) => setActiveId(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-ink-950 px-2 py-1.5 text-[12.5px] text-ink-200 outline-none"
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <div className="flex items-center rounded-lg border border-white/10 p-0.5">
          {(['code', 'chat'] as MobileView[]).map((view) => (
            <button
              key={view}
              type="button"
              onClick={() => setMobileView(view)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12px] font-medium transition',
                mobileView === view ? 'bg-white/[0.1] text-white' : 'text-ink-400',
              )}
            >
              {view === 'code' ? 'Kode' : 'Chat'}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-ink-300"
        >
          <GearIcon className="h-4 w-4" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="hidden h-full lg:flex">
          <ProjectRail
            projects={projects}
            activeId={activeId}
            onSelect={setActiveId}
            onCreate={createProject}
            onDelete={deleteProject}
            onOpenSettings={() => setSettingsOpen(true)}
            owner={owner}
            model={settings.model}
          />
        </div>

        <div className={cn('h-full min-h-0 flex-1', mobileView === 'code' ? 'flex' : 'hidden', 'lg:flex')}>
          <CodePanel
            projectName={activeProject?.name ?? 'Tanpa proyek'}
            sandboxId={sandboxId}
            sandboxBusy={sandboxBusy}
            e2bReady={capabilities.e2bFromEnv}
            onSandboxAction={sandboxAction}
            files={files}
            filesLoading={filesLoading}
            filesReason={filesReason}
            onRefreshFiles={() => void refreshFiles()}
            openFile={openFile}
            fileLoading={fileLoading}
            fileSaving={fileSaving}
            fileError={fileError ?? (openFilePath && !openFile ? 'File gagal dimuat.' : null)}
            onOpenFile={openFileHandler}
            onSaveFile={saveFile}
            onCloseFile={() => {
              setOpenFile(null);
              setOpenFilePath(null);
            }}
            terminalLines={terminalLines}
            terminalRunning={terminalRunning}
            onRunCommand={runCommand}
            preview={preview}
            onRefreshPreview={() => void refreshPreview()}
            onRestartPreview={() => void restartPreview()}
            onSetPort={setPreviewPort}
            onAskFixPreview={(message) => void handleSend(message)}
            deployUrl={activeProject?.deploy_url ?? null}
            deployAt={activeProject?.deploy_at ?? null}
            deployAvailable={Boolean(settings.vercel?.hasToken)}
            deploying={deploying}
            deployNote={deployNote}
            onDeploy={() => void deployProject()}
            deployProtected={protection.protected}
            deployProtectionNote={protection.note}
            deploySettingsUrl={protection.settingsUrl}
            disablingProtection={disablingProtection}
            deployWarning={deployWarning}
            onDisableProtection={() => void disableDeployProtection()}
            activeTab={tab}
            onTabChange={setTab}
          />
        </div>

        <div className={cn('h-full min-h-0 w-full lg:w-auto lg:shrink-0', mobileView === 'chat' ? 'block' : 'hidden', 'lg:block')}>
          <ChatPanel
            messages={messages}
            live={live}
            running={running}
            status={status}
            model={settings.model}
            mode={mode}
            autoDebug={autoDebug}
            hasKey={settings.hasKey}
            sandboxId={sandboxId}
            storageLabel={storageLabel}
            storageNotice={storageNotice ?? filesNotice}
            sessionUsage={sessionUsage}
            onToggleAutoDebug={setAutoDebug}
            onSend={handleSend}
            onStop={handleStop}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </div>
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        capabilities={capabilities}
        onSaved={(next) => setSettings(next)}
      />
    </div>
  );
}
