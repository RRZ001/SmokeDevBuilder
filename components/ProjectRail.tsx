'use client';

import { useState } from 'react';
import { CloseIcon, PlusIcon, TrashIcon } from './icons';
import type { ProjectLite } from './types';

type Props = {
  projects: ProjectLite[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string, description: string) => Promise<void> | void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
  owner: string;
  model: string;
};

export default function ProjectRail({ projects, activeId, onSelect, onCreate, onDelete, onOpenSettings, owner, model }: Props) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onCreate(name.trim(), description.trim());
      setName('');
      setDescription('');
      setCreating(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="flex h-full w-full flex-col border-r border-white/[0.06] bg-ink-950 lg:w-64 lg:shrink-0">
      <div className="flex items-center gap-2 px-3 py-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-accent-500 to-accent-700 text-[13px] font-bold text-white shadow-soft">
          AC
        </span>
        <div className="min-w-0 leading-tight">
          <p className="truncate text-[13.5px] font-semibold text-white">AgentCloud</p>
          <p className="truncate text-[10.5px] text-ink-400">Cloud AI Coding Agent</p>
        </div>
      </div>

      <div className="flex items-center justify-between px-3 pb-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Proyek</span>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          title="Proyek baru"
          className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 text-ink-300 transition hover:border-accent-300/50 hover:text-white"
        >
          {creating ? <CloseIcon className="h-3.5 w-3.5" /> : <PlusIcon className="h-3.5 w-3.5" />}
        </button>
      </div>

      {creating && (
        <div className="mx-3 mb-2 space-y-1.5 rounded-xl border border-white/[0.07] bg-ink-900 p-2">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Nama proyek"
            className="w-full rounded-lg border border-white/10 bg-ink-950 px-2 py-1.5 text-[12.5px] text-ink-200 outline-none placeholder:text-ink-600"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Deskripsi singkat (opsional)"
            className="w-full rounded-lg border border-white/10 bg-ink-950 px-2 py-1.5 text-[12px] text-ink-200 outline-none placeholder:text-ink-600"
          />
          <button
            type="button"
            onClick={submit}
            disabled={busy || !name.trim()}
            className="w-full rounded-lg bg-gradient-to-br from-accent-500 to-accent-700 px-2 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40"
          >
            {busy ? 'Membuat…' : 'Buat proyek'}
          </button>
        </div>
      )}

      <nav className="flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {!projects.length && <p className="px-2 py-3 text-[12px] leading-relaxed text-ink-400">Belum ada proyek. Buat satu untuk mulai ngoding dengan agent.</p>}
        {projects.map((project) => {
          const active = project.id === activeId;
          return (
            <div
              key={project.id}
              className={`group flex items-center gap-2 rounded-xl px-2.5 py-2 transition ${
                active ? 'bg-accent-500/15 ring-1 ring-inset ring-accent-300/30' : 'hover:bg-white/[0.04]'
              }`}
            >
              <button type="button" onClick={() => onSelect(project.id)} className="min-w-0 flex-1 text-left">
                <span className="flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${project.sandbox_id ? 'bg-emerald-400' : 'bg-ink-600'}`} />
                  <span className={`truncate text-[12.5px] font-medium ${active ? 'text-white' : 'text-ink-200'}`}>{project.name}</span>
                </span>
                {project.description && <span className="mt-0.5 block truncate pl-3.5 text-[11px] text-ink-400">{project.description}</span>}
              </button>
              <button
                type="button"
                onClick={() => onDelete(project.id)}
                title="Hapus proyek beserta riwayat chat-nya"
                className="opacity-0 transition group-hover:opacity-100"
              >
                <TrashIcon className="h-3.5 w-3.5 text-ink-400 hover:text-rose-300" />
              </button>
            </div>
          );
        })}
      </nav>

      <div className="space-y-1 border-t border-white/[0.06] px-3 py-3">
        <p className="truncate text-[11px] text-ink-400" title={model}>
          Model: <span className="text-ink-200">{model}</span>
        </p>
        <p className="truncate text-[10.5px] text-ink-600" title={owner}>
          Sesi: {owner.slice(0, 8)}…
        </p>
        <button
          type="button"
          onClick={onOpenSettings}
          className="mt-1 w-full rounded-lg border border-white/10 px-2 py-1.5 text-[11.5px] text-ink-200 transition hover:border-accent-300/50 hover:text-white"
        >
          Settings & Model
        </button>
      </div>
    </aside>
  );
}
