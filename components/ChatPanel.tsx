'use client';

import { useEffect, useRef, useState } from 'react';
import MessageItem from './MessageItem';
import { GearIcon, SendIcon, SparkIcon, StopIcon, WarnIcon } from './icons';
import type { UiBlock, UiMessage } from './types';

const EXAMPLES = [
  'Buatkan landing page produk dengan Tailwind yang mobile-friendly, lalu jalankan preview-nya.',
  'Buat REST API Express dengan endpoint CRUD sederhana + uji pakai curl.',
  'Buatkan game snake pakai HTML + canvas, jalankan di port 3000.',
  'Cek isi folder proyek, lalu jelaskan struktur yang ada sekarang.',
];

type Props = {
  messages: UiMessage[];
  live: UiBlock[] | null;
  running: boolean;
  status: string | null;
  model: string;
  mode: 'agent' | 'chat';
  autoDebug: boolean;
  hasKey: boolean;
  sandboxId: string | null;
  storageLabel: string;
  storageNotice: string | null;
  sessionUsage: { promptTokens: number; completionTokens: number; cachedTokens: number; costUsd: number; hasCost: boolean };
  onToggleAutoDebug: (value: boolean) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onOpenSettings: () => void;
};

export default function ChatPanel({
  messages,
  live,
  running,
  status,
  model,
  mode,
  autoDebug,
  hasKey,
  sandboxId,
  storageLabel,
  storageNotice,
  sessionUsage,
  onToggleAutoDebug,
  onSend,
  onStop,
  onOpenSettings,
}: Props) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, live]);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(180, el.scrollHeight)}px`;
  }, [draft]);

  const submit = () => {
    const text = draft.trim();
    if (!text || running) return;
    setDraft('');
    onSend(text);
  };

  return (
    <section className="relative flex h-full w-full flex-col bg-gradient-to-b from-paper via-paper to-accent-50/70 lg:w-[452px] lg:shrink-0">
      {/* glow dekoratif */}
      <div className="pointer-events-none absolute -top-24 right-[-20%] h-72 w-72 rounded-full bg-accent-300/25 blur-3xl" />
      <div className="pointer-events-none absolute bottom-[-15%] left-[-25%] h-72 w-72 rounded-full bg-fuchsia-300/20 blur-3xl" />

      <header className="relative z-10 flex flex-wrap items-center gap-2 border-b border-black/[0.06] px-4 py-3 backdrop-blur">
        <div className="mr-auto flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-accent-500 to-accent-700 text-white shadow-soft">
            <SparkIcon className="h-4 w-4" />
          </span>
          <div className="leading-tight">
            <p className="text-[13.5px] font-semibold text-[#1F1B3A]">Agent Chat</p>
            <p className="text-[11px] text-muted">
              {model}
              {model.includes('r1') ? ' · reasoning' : ''}
            </p>
          </div>
        </div>

        <StatusPill
          tone={mode === 'agent' ? 'good' : 'warn'}
          label={mode === 'agent' ? 'Sandbox aktif' : 'Mode diskusi'}
          title={mode === 'agent' ? `Sandbox: ${sandboxId ?? '-'}` : 'E2B_API_KEY belum diisi'}
        />
        <StatusPill tone="neutral" label={storageLabel} title="Penyimpanan riwayat chat & proyek" />
        {(sessionUsage.promptTokens > 0 || sessionUsage.completionTokens > 0) && (
          <StatusPill
            tone="neutral"
            label={usageLabel(sessionUsage)}
            title={`Pemakaian sesi ini: ${sessionUsage.promptTokens.toLocaleString('id-ID')} token masuk` +
              (sessionUsage.cachedTokens ? ` (${sessionUsage.cachedTokens.toLocaleString('id-ID')} dari cache)` : '') +
              `, ${sessionUsage.completionTokens.toLocaleString('id-ID')} token keluar` +
              (sessionUsage.hasCost ? `, ≈ $${sessionUsage.costUsd.toFixed(4)}` : '')}
          />
        )}
        <button
          type="button"
          onClick={onOpenSettings}
          title="Settings"
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/[0.07] bg-white/70 text-muted transition hover:text-accent-600"
        >
          <GearIcon className="h-4 w-4" />
        </button>
      </header>

      {!hasKey && (
        <button
          type="button"
          onClick={onOpenSettings}
          className="relative z-10 mx-4 mt-3 flex items-start gap-2 rounded-xl border border-amber-300/70 bg-amber-50/90 px-3 py-2 text-left text-[12.5px] text-amber-800 shadow-soft"
        >
          <WarnIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong className="font-semibold">OpenRouter API key belum diisi.</strong> Buka Settings untuk menempelkan key,
            memilih model, dan mengaktifkan eksekusi di cloud sandbox.
          </span>
        </button>
      )}

      {storageNotice && (
        <div className="relative z-10 mx-4 mt-3 flex items-start gap-2 rounded-xl border border-amber-300/70 bg-amber-50/90 px-3 py-2 text-left text-[12.5px] text-amber-800 shadow-soft">
          <WarnIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{storageNotice}</span>
        </div>
      )}

      <div ref={scrollRef} className="light-scroll relative z-10 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {!messages.length && !live && (
          <div className="rounded-2xl border border-white/70 bg-white/60 p-4 shadow-glass backdrop-blur-xl">
            <h2 className="text-[15px] font-semibold text-[#1F1B3A]">Mulai dari mana?</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
              Tulis instruksi seperti ke developer. Agent akan bertanya kalau ada yang ambigu, menulis file di cloud
              sandbox, menjalankan perintah, memperbaiki error sendiri, lalu menampilkan preview aplikasi.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  disabled={running}
                  onClick={() => onSend(example)}
                  className="rounded-xl border border-black/[0.06] bg-white/80 px-3 py-2 text-left text-[12.5px] text-[#1F1B3A] transition hover:border-accent-300 hover:bg-white disabled:opacity-50"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) => (
          <MessageItem key={message.id} message={message} />
        ))}

        {live && (
          <MessageItem
            message={{ id: 'live', role: 'assistant', blocks: live, created_at: new Date().toISOString() }}
          />
        )}

        {running && status && (
          <div className="flex items-center gap-2 pl-10 text-[12px] text-muted">
            <span className="flex gap-1">
              <i className="h-1.5 w-1.5 rounded-full bg-accent-500 animate-pulse-dot" />
              <i className="h-1.5 w-1.5 rounded-full bg-accent-500 animate-pulse-dot [animation-delay:150ms]" />
              <i className="h-1.5 w-1.5 rounded-full bg-accent-500 animate-pulse-dot [animation-delay:300ms]" />
            </span>
            {status}
          </div>
        )}
      </div>

      <footer className="relative z-10 border-t border-black/[0.06] bg-white/70 px-4 py-3 backdrop-blur-xl">
        <div className="rounded-2xl border border-white/80 bg-white/85 p-2 shadow-glass">
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="Contoh: buatkan todo app React + Tailwind, jalankan di port 3000…"
            className="max-h-[180px] w-full resize-none bg-transparent px-2 py-1.5 text-[14px] leading-relaxed text-[#1F1B3A] outline-none placeholder:text-muted/60"
          />
          <div className="flex items-center gap-2 px-1 pb-0.5">
            <button
              type="button"
              onClick={() => onToggleAutoDebug(!autoDebug)}
              title="Jika perintah gagal, error otomatis dikirim ke model untuk diperbaiki"
              className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11.5px] font-medium transition ${
                autoDebug
                  ? 'border-accent-300/70 bg-accent-50 text-accent-700'
                  : 'border-black/[0.07] bg-white text-muted'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${autoDebug ? 'bg-emerald-500' : 'bg-muted/50'}`} />
              Auto-debug
            </button>
            <span className="ml-auto text-[11px] text-muted/70">Enter kirim · Shift+Enter baris baru</span>
            {running ? (
              <button
                type="button"
                onClick={onStop}
                className="flex h-9 items-center gap-1.5 rounded-xl bg-ink-800 px-3 text-[12.5px] font-semibold text-white transition hover:bg-ink-700"
              >
                <StopIcon className="h-4 w-4" /> Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!draft.trim()}
                className="flex h-9 items-center gap-1.5 rounded-xl bg-gradient-to-br from-accent-500 to-accent-700 px-3.5 text-[12.5px] font-semibold text-white shadow-soft transition hover:brightness-110 disabled:opacity-40"
              >
                <SendIcon className="h-4 w-4" /> Kirim
              </button>
            )}
          </div>
        </div>
      </footer>
    </section>
  );
}

/** Label chip pemakaian: biaya bila tersedia, kalau tidak jumlah token. */
function usageLabel(usage: { promptTokens: number; completionTokens: number; costUsd: number; hasCost: boolean }): string {
  const tokens = usage.promptTokens + usage.completionTokens;
  const short = tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}jt` : tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}k` : String(tokens);
  return usage.hasCost ? `≈ $${usage.costUsd.toFixed(4)}` : `${short} token`;
}

function StatusPill({
  tone,
  label,
  title,
}: {
  tone: 'good' | 'warn' | 'neutral';
  label: string;
  title?: string;
}) {
  const styles =
    tone === 'good'
      ? 'border-emerald-300/60 bg-emerald-50 text-emerald-700'
      : tone === 'warn'
        ? 'border-amber-300/70 bg-amber-50 text-amber-800'
        : 'border-black/[0.07] bg-white/80 text-muted';
  return (
    <span
      title={title}
      className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium sm:flex ${styles}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          tone === 'good' ? 'bg-emerald-500' : tone === 'warn' ? 'bg-amber-500' : 'bg-muted/50'
        }`}
      />
      {label}
    </span>
  );
}
