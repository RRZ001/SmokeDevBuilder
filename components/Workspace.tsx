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
  const [preview, setPreview] = useState<PreviewState>({
    url: null,
    port: 3000,
    status: '000',
    online: false,
    loading: false,
    reason: null,
  });

  const abortRef = useRef<AbortController | null>(null);
  /** Salinan terbaru refreshPreview untuk dipakai di dalam handler stream. */
  const refreshPreviewRef = useRef<((projectId?: string, silent?: boolean) => Promise<void>) | null>(null);
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
        const data = await apiJson<{ url: string; port: number; status: string; online: boolean }>(
          `/api/projects/${id}/sandbox/preview`,
        );
        setPreview((p) => ({ ...p, url: data.url, port: data.port, status: data.status, online: data.online, loading: false, reason: null }));
      } catch (err) {
        setPreview((p) => ({
          ...p,
          loading: false,
          online: false,
          status: '000',
          reason: err instanceof Error ? err.message : String(err),
        }));
      }
    },
    [activeId, capabilities.e2bFromEnv],
  );

  useEffect(() => {
    refreshPreviewRef.current = refreshPreview;
  }, [refreshPreview]);

  /**
   * Server dev sering baru listen beberapa detik setelah agent melaporkan URL-nya
   * (npm install, kompilasi Next.js, dsb). Daripada user menekan "Cek status"
   * berulang kali, pantau otomatis sampai server merespons (maks ~36 detik).
   */
  useEffect(() => {
    if (!activeId || !preview.url || preview.online || !capabilities.e2bFromEnv) return;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      void refreshPreviewRef.current?.(activeId, true);
      if (attempts >= 9) clearInterval(timer);
    }, 4_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, preview.url, preview.online, capabilities.e2bFromEnv]);

  useEffect(() => {
    if (!activeId) return;
    setTerminalLines([]);
    setOpenFile(null);
    setOpenFilePath(null);
    setLive(null);
    const project = projects.find((p) => p.id === activeId);
    setSandboxId(project?.sandbox_id ?? null);
    setPreview((p) => ({ ...p, port: project?.preview_port ?? p.port, online: false, url: null, status: '000' }));
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
              setPreview((p) => ({ ...p, url: String(event.url), port, online: false, loading: true, reason: null }));
              void apiJson(`/api/projects/${activeId}/sandbox/preview`, {
                method: 'POST',
                body: JSON.stringify({ port }),
              }).catch(() => undefined);
              void refreshPreviewRef.current?.(activeId, true);
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
            onSetPort={setPreviewPort}
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
