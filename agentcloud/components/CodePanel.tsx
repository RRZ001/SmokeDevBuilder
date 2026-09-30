'use client';

import { useState } from 'react';
import CodeViewer, { type OpenFile } from './CodeViewer';
import FileTree from './FileTree';
import PreviewPanel from './PreviewPanel';
import TerminalPanel, { type TerminalLine } from './TerminalPanel';
import { CloudIcon, CodeIcon, PlayIcon, RefreshIcon, StopIcon, TerminalIcon } from './icons';
import type { FileEntry } from './types';

type Tab = 'editor' | 'terminal' | 'preview';

export type PreviewState = {
  url: string | null;
  port: number;
  status: string;
  online: boolean;
  loading: boolean;
  reason: string | null;
};

type Props = {
  projectName: string;
  sandboxId: string | null;
  sandboxBusy: boolean;
  e2bReady: boolean;
  onSandboxAction: (action: 'start' | 'reset' | 'stop') => void;
  files: FileEntry[];
  filesLoading: boolean;
  filesReason: string | null;
  onRefreshFiles: () => void;
  openFile: OpenFile | null;
  fileLoading: boolean;
  fileSaving: boolean;
  fileError: string | null;
  onOpenFile: (path: string) => void;
  onSaveFile: (path: string, content: string) => void;
  onCloseFile: () => void;
  terminalLines: TerminalLine[];
  terminalRunning: boolean;
  onRunCommand: (command: string) => void;
  preview: PreviewState;
  onRefreshPreview: () => void;
  onSetPort: (port: number) => void;
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
};

export default function CodePanel(props: Props) {
  const { activeTab, onTabChange } = props;
  const [treeOpen, setTreeOpen] = useState(true);
  const sandboxReady = Boolean(props.sandboxId);

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col bg-ink-900">
      <header className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-3 py-2">
        <nav className="flex items-center gap-1 rounded-xl border border-white/[0.07] bg-ink-950/60 p-0.5">
          <TabButton active={activeTab === 'editor'} onClick={() => onTabChange('editor')} icon={<CodeIcon className="h-3.5 w-3.5" />}>
            Editor
          </TabButton>
          <TabButton active={activeTab === 'terminal'} onClick={() => onTabChange('terminal')} icon={<TerminalIcon className="h-3.5 w-3.5" />}>
            Terminal
          </TabButton>
          <TabButton active={activeTab === 'preview'} onClick={() => onTabChange('preview')} icon={<PlayIcon className="h-3.5 w-3.5" />}>
            Preview
          </TabButton>
        </nav>

        <span className="hidden max-w-[220px] truncate text-[12.5px] text-ink-300 md:block">{props.projectName}</span>

        <span className="ml-auto flex items-center gap-1.5">
          <span
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
              sandboxReady ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-white/10 bg-white/[0.04] text-ink-400'
            }`}
          >
            <CloudIcon className="h-3.5 w-3.5" />
            {sandboxReady ? `${props.sandboxId?.slice(0, 8)}…` : 'sandbox mati'}
          </span>

          {props.e2bReady ? (
            <>
              {!sandboxReady && (
                <SandboxButton onClick={() => props.onSandboxAction('start')} busy={props.sandboxBusy} icon={<PlayIcon className="h-3.5 w-3.5" />}>
                  Mulai sandbox
                </SandboxButton>
              )}
              {sandboxReady && (
                <SandboxButton onClick={() => props.onSandboxAction('reset')} busy={props.sandboxBusy} icon={<RefreshIcon className="h-3.5 w-3.5" />}>
                  Sandbox baru
                </SandboxButton>
              )}
              {sandboxReady && (
                <SandboxButton onClick={() => props.onSandboxAction('stop')} busy={props.sandboxBusy} icon={<StopIcon className="h-3.5 w-3.5" />}>
                  Stop
                </SandboxButton>
              )}
            </>
          ) : (
            <span className="rounded-lg border border-amber-300/30 bg-amber-300/10 px-2.5 py-1 text-[11px] text-amber-300">
              Isi E2B_API_KEY di Settings
            </span>
          )}
        </span>
      </header>

      {activeTab === 'editor' && (
        <div className="flex min-h-0 flex-1">
          <aside
            className={`${treeOpen ? 'w-56' : 'w-0'} shrink-0 overflow-hidden border-r border-white/[0.06] bg-ink-850 transition-all`}
          >
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Proyek</span>
              <button
                type="button"
                onClick={props.onRefreshFiles}
                title="Muat ulang daftar file"
                className="flex h-6 w-6 items-center justify-center rounded text-ink-400 hover:text-white"
              >
                <RefreshIcon className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="h-[calc(100%-2.5rem)] overflow-auto">
              <FileTree
                files={props.files}
                openPath={props.openFile?.path}
                onOpen={props.onOpenFile}
                loading={props.filesLoading}
                reason={props.filesReason}
              />
            </div>
          </aside>

          <button
            type="button"
            onClick={() => setTreeOpen((v) => !v)}
            title={treeOpen ? 'Sembunyikan daftar file' : 'Tampilkan daftar file'}
            className="w-2 shrink-0 cursor-pointer bg-ink-800 transition hover:bg-accent-500/40"
          />

          <div className="min-w-0 flex-1">
            <CodeViewer
              file={props.openFile}
              loading={props.fileLoading}
              saving={props.fileSaving}
              error={props.fileError}
              onSave={props.onSaveFile}
              onReload={() => props.openFile && props.onOpenFile(props.openFile.path)}
              onClose={props.onCloseFile}
            />
          </div>
        </div>
      )}

      {activeTab === 'terminal' && (
        <TerminalPanel
          lines={props.terminalLines}
          running={props.terminalRunning}
          disabled={!sandboxReady}
          disabledReason={props.e2bReady ? 'Jalankan sandbox dulu (tombol "Mulai sandbox" di atas).' : 'E2B_API_KEY belum diisi.'}
          onRun={props.onRunCommand}
        />
      )}

      {activeTab === 'preview' && (
        <PreviewPanel
          url={props.preview.url}
          port={props.preview.port}
          status={props.preview.status}
          online={props.preview.online}
          loading={props.preview.loading}
          canPreview={sandboxReady}
          reason={props.preview.reason}
          onRefresh={props.onRefreshPreview}
          onSetPort={props.onSetPort}
        />
      )}
    </section>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-[12.5px] font-medium transition ${
        active ? 'bg-white/[0.08] text-white shadow-inner' : 'text-ink-400 hover:text-ink-200'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function SandboxButton({
  onClick,
  busy,
  icon,
  children,
}: {
  onClick: () => void;
  busy: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex h-7 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-[11.5px] font-medium text-ink-200 transition hover:border-accent-300/50 hover:text-white disabled:opacity-40"
    >
      {icon}
      {busy ? 'Proses…' : children}
    </button>
  );
}
