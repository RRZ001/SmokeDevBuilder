'use client';

import { useEffect, useMemo, useState } from 'react';
import hljs from 'highlight.js/lib/common';
import { CloseIcon, RefreshIcon, SaveIcon } from './icons';
import { languageFromPath } from '@/lib/util';

export type OpenFile = { path: string; content: string };

type Props = {
  file: OpenFile | null;
  loading?: boolean;
  saving?: boolean;
  error?: string | null;
  onSave: (path: string, content: string) => void;
  onReload: () => void;
  onClose: () => void;
};

export default function CodeViewer({ file, loading, saving, error, onSave, onReload, onClose }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    setEditing(false);
    setDraft(file?.content ?? '');
  }, [file?.path, file?.content]);

  const highlighted = useMemo(() => {
    if (!file) return '';
    const language = languageFromPath(file.path);
    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(file.content, { language, ignoreIllegals: true }).value;
      }
      return hljs.highlightAuto(file.content).value;
    } catch {
      return escapeHtml(file.content);
    }
  }, [file]);

  if (!file) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-[13px] text-ink-300">Pilih file di kiri untuk melihat kodenya.</p>
        <p className="max-w-sm text-[12px] leading-relaxed text-ink-400">
          File ditulis oleh agent langsung di dalam cloud sandbox E2B. Kamu juga bisa mengedit & menyimpan perubahan di
          sini, lalu meminta agent menjalankan atau mengujinya.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2">
        <span className="truncate font-mono text-[12px] text-ink-200">{file.path}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {error && <span className="text-[11px] text-rose-300">{error}</span>}
          <button
            type="button"
            onClick={onReload}
            title="Muat ulang dari sandbox"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-white/10 text-ink-300 hover:text-white"
          >
            <RefreshIcon className="h-3.5 w-3.5" />
          </button>
          {editing ? (
            <>
              <button
                type="button"
                disabled={saving}
                onClick={() => onSave(file.path, draft)}
                className="flex h-7 items-center gap-1.5 rounded-md bg-accent-500 px-2.5 text-[11.5px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
              >
                <SaveIcon className="h-3.5 w-3.5" /> {saving ? 'Menyimpan…' : 'Simpan'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setDraft(file.content);
                }}
                className="h-7 rounded-md border border-white/10 px-2.5 text-[11.5px] text-ink-300 hover:text-white"
              >
                Batal
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="h-7 rounded-md border border-white/10 px-2.5 text-[11.5px] text-ink-300 hover:text-white"
            >
              Edit
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Tutup"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-white/10 text-ink-300 hover:text-white"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>

      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="flex-1 resize-none bg-ink-950 p-4 font-mono text-[12.5px] leading-relaxed text-ink-200 outline-none"
        />
      ) : loading ? (
        <p className="p-4 text-[12.5px] text-ink-400">Memuat file…</p>
      ) : (
        <div className="flex-1 overflow-auto">
          <div className="flex min-h-full">
            <pre
              aria-hidden="true"
              className="select-none border-r border-white/[0.06] px-3 py-4 text-right font-mono text-[12.5px] leading-relaxed text-ink-600"
            >
              {file.content.split('\n').map((_, i) => `${i + 1}`).join('\n')}
            </pre>
            <pre className="flex-1 px-4 py-4 font-mono text-[12.5px] leading-relaxed">
              <code className="hljs !bg-transparent" dangerouslySetInnerHTML={{ __html: highlighted }} />
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
