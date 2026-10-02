'use client';

import { useEffect, useRef, useState } from 'react';
import { PlayIcon, TerminalIcon } from './icons';

export type TerminalLine = { id: string; kind: 'command' | 'output' | 'error' | 'info'; text: string };

const QUICK = ['npm install', 'npm run dev -- --host 0.0.0.0 --port 3000', 'ls -la', 'cat package.json', 'node -v'];

type Props = {
  lines: TerminalLine[];
  running: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
  onRun: (command: string) => void;
};

export default function TerminalPanel({ lines, running, disabled, disabledReason, onRun }: Props) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const submit = () => {
    const command = draft.trim();
    if (!command || running || disabled) return;
    setDraft('');
    onRun(command);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-auto bg-ink-950 px-4 py-3 font-mono text-[12.5px] leading-relaxed">
        {!lines.length && (
          <p className="text-ink-400">
            Terminal sandbox siap. Semua perintah dijalankan di VM Linux E2B, bukan di server aplikasi ini.
          </p>
        )}
        {lines.map((line) => (
          <pre
            key={line.id}
            className={`whitespace-pre-wrap break-words ${
              line.kind === 'command'
                ? 'mt-2 text-accent-300'
                : line.kind === 'error'
                  ? 'text-rose-300'
                  : line.kind === 'info'
                    ? 'text-ink-400'
                    : 'text-ink-200'
            }`}
          >
            {line.kind === 'command' ? `$ ${line.text}` : line.text}
          </pre>
        ))}
        {disabled && <p className="mt-3 text-amber-300">{disabledReason ?? 'Sandbox belum siap.'}</p>}
      </div>

      <div className="border-t border-white/[0.06] px-3 py-2.5">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {QUICK.map((command) => (
            <button
              key={command}
              type="button"
              disabled={disabled || running}
              onClick={() => onRun(command)}
              className="rounded-md border border-white/10 px-2 py-1 font-mono text-[11px] text-ink-300 transition hover:border-accent-300/50 hover:text-white disabled:opacity-40"
            >
              {command}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-ink-900 px-2 py-1.5">
          <TerminalIcon className="h-4 w-4 text-ink-400" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            disabled={disabled}
            placeholder={disabled ? 'Sandbox belum aktif…' : 'Jalankan perintah di sandbox…'}
            className="flex-1 bg-transparent font-mono text-[12.5px] text-ink-200 outline-none placeholder:text-ink-600 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={submit}
            disabled={running || disabled || !draft.trim()}
            className="flex h-7 items-center gap-1.5 rounded-md bg-accent-500 px-2.5 text-[11.5px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
          >
            <PlayIcon className="h-3.5 w-3.5" /> {running ? 'Jalan…' : 'Jalankan'}
          </button>
        </div>
      </div>
    </div>
  );
}
