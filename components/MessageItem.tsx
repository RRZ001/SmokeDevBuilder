'use client';

import { useState } from 'react';
import { matchChosenOption } from '@/lib/choice-select';
import Markdown from './Markdown';
import { BrainIcon, CheckIcon, ChevronIcon, DotIcon, ExternalIcon, TerminalIcon, WarnIcon } from './icons';
import type { UiBlock, UiChoicesBlock, UiImageBlock, UiMessage, UiToolBlock } from './types';

const TOOL_LABEL: Record<string, string> = {
  run_command: 'Terminal',
  write_file: 'Tulis file',
  read_file: 'Baca file',
  list_files: 'Daftar file',
  start_server: 'Jalankan server',
  browser_check: 'Cek tampilan di browser',
  stop_server: 'Hentikan server',
  get_preview_url: 'Cek preview',
};

function toolTarget(block: UiToolBlock): string {
  const args = block.args ?? {};
  if (block.name === 'run_command' || block.name === 'start_server') return String(args.command ?? '');
  if (typeof args.path === 'string') return args.path;
  if (typeof args.port === 'number') return `port ${args.port}`;
  return '';
}

function fmtTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

export default function MessageItem({
  message,
  onChoose,
  nextUserText,
  planSuperseded,
}: {
  message: UiMessage;
  /** Dipanggil saat user mengklik salah satu opsi (mengirimnya sebagai pesan). */
  onChoose?: (text: string) => void;
  /** Pesan user berikutnya - dipakai menandai pilihan yang sudah dijawab. */
  nextUserText?: string | null;
  /** true = sudah ada blok rencana yang lebih baru (kartu ini diringkas). */
  planSuperseded?: boolean;
}) {
  const isUser = message.role === 'user';
  return (
    <article className={`animate-fade-up ${isUser ? 'flex justify-end' : ''}`}>
      {isUser ? (
        <div className="max-w-[92%] rounded-2xl rounded-br-md bg-gradient-to-br from-accent-500 to-accent-700 px-4 py-2.5 text-[14.5px] leading-relaxed text-white shadow-soft">
          <p className="whitespace-pre-wrap break-words">{message.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')}</p>
          <div className="mt-1 text-[10.5px] text-white/70">{fmtTime(message.created_at)}</div>
        </div>
      ) : (
        <div className="flex gap-3">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent-500 to-accent-700 text-[11px] font-semibold text-white shadow-soft">
            AI
          </div>
          <div className="min-w-0 flex-1 space-y-2.5">
            {message.blocks.map((block, index) => (
              <BlockView
                key={`${message.id}-${index}`}
                block={block}
                onChoose={onChoose}
                nextUserText={nextUserText}
                planSuperseded={planSuperseded}
              />
            ))}
            <div className="text-[10.5px] text-muted/70">{fmtTime(message.created_at)}</div>
          </div>
        </div>
      )}
    </article>
  );
}

function BlockView({
  block,
  onChoose,
  nextUserText,
  planSuperseded,
}: {
  block: UiBlock;
  onChoose?: (text: string) => void;
  nextUserText?: string | null;
  planSuperseded?: boolean;
}) {
  if (block.type === 'text') {
    return block.text.trim() ? <Markdown>{block.text}</Markdown> : null;
  }
  if (block.type === 'reasoning') return <ReasoningView text={block.text} />;
  if (block.type === 'notice') return <NoticeView level={block.level} text={block.text} />;
  if (block.type === 'usage') return <UsageView block={block} />;
  if (block.type === 'choices') {
    return <ChoicesView block={block} onChoose={onChoose} nextUserText={nextUserText} />;
  }
  if (block.type === 'plan') {
    return <PlanView block={block} superseded={Boolean(planSuperseded)} />;
  }
  if (block.type === 'image') {
    return <ImageView block={block} />;
  }
  return <ToolView block={block} />;
}

/**
 * Rencana kerja agent sebagai daftar centang.
 *
 * Agent mengirim ulang blok `:::plan` dengan `[x]` saat langkahnya selesai, jadi
 * user bisa melihat progres tanpa membaca ulang seluruh percakapan. Rencana yang
 * sudah digantikan versi terbaru diringkas (bisa dibuka kembali dengan klik)
 * supaya chat lama tidak menumpuk kartu panjang.
 */
function PlanView({ block, superseded }: { block: { items: Array<{ text: string; done: boolean }> }; superseded: boolean }) {
  const [open, setOpen] = useState(!superseded);
  const total = block.items.length;
  const done = block.items.filter((item) => item.done).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const allDone = total > 0 && done === total;

  return (
    <div className="overflow-hidden rounded-xl border border-accent-500/20 bg-white/70 shadow-[0_6px_18px_-14px_rgba(31,27,58,0.4)] backdrop-blur">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className={`flex h-5 w-5 items-center justify-center rounded-md ${allDone ? 'bg-emerald-100 text-emerald-600' : 'bg-accent-100 text-accent-600'}`}>
          {allDone ? <CheckIcon className="h-3.5 w-3.5" /> : <DotIcon className="h-3 w-3 animate-pulse-dot" />}
        </span>
        <span className="text-[12.5px] font-semibold text-[#1F1B3A]">Rencana</span>
        <span className="rounded-full bg-black/[0.05] px-2 py-0.5 text-[11px] font-medium text-muted">
          {done}/{total} selesai
        </span>
        <span className="ml-auto flex items-center gap-2">
          <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-black/[0.07] sm:block">
            <span
              className={`block h-full rounded-full transition-all ${allDone ? 'bg-emerald-400' : 'bg-gradient-to-r from-accent-500 to-accent-700'}`}
              style={{ width: `${pct}%` }}
            />
          </span>
          <ChevronIcon className={`h-3.5 w-3.5 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>

      {open && (
        <ul className="space-y-1.5 border-t border-black/[0.06] px-3 py-2.5">
          {block.items.map((item, index) => (
            <li key={`${index}-${item.text}`} className="flex items-start gap-2 text-[12.5px] leading-relaxed">
              <span
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                  item.done ? 'border-emerald-400 bg-emerald-400 text-white' : 'border-black/15 bg-white'
                }`}
              >
                {item.done && <CheckIcon className="h-2.5 w-2.5" />}
              </span>
              <span className={item.done ? 'text-muted/70 line-through decoration-muted/40' : 'text-[#1F1B3A]'}>{item.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Screenshot yang diambil agent lewat browser_check: inilah "mata" agent.
 * Ditampilkan supaya user bisa menilai hal yang sama seperti yang dinilai agent.
 */
function ImageView({ block }: { block: UiImageBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <figure className="overflow-hidden rounded-xl border border-black/[0.07] bg-white/70 p-2 shadow-[0_6px_18px_-14px_rgba(31,27,58,0.4)] backdrop-blur">
      <button type="button" onClick={() => setOpen((v) => !v)} className="block w-full text-left">
        <img
          src={block.dataUrl}
          alt={block.caption || 'Screenshot halaman'}
          className={`w-full rounded-lg border border-black/[0.05] ${open ? '' : 'max-h-72 object-cover object-top'}`}
        />
      </button>
      <figcaption className="mt-1.5 flex items-center gap-2 px-1 text-[11px] text-muted">
        <span className="truncate">{block.caption || 'Screenshot halaman'}</span>
        <span className="ml-auto shrink-0 text-muted/70">{open ? 'klik untuk kecilkan' : 'klik untuk perbesar'}</span>
      </figcaption>
    </figure>
  );
}

/**
 * Pertanyaan pilihan yang bisa diklik. Setelah salah satu opsi dikirim (pesan
 * user berikutnya sama dengan opsinya), tombol dinonaktifkan dan pilihan itu
 * ditandai — status ini diturunkan dari riwayat, jadi tidak perlu menulis ulang
 * blok di database.
 */
function ChoicesView({
  block,
  onChoose,
  nextUserText,
}: {
  block: UiChoicesBlock;
  onChoose?: (text: string) => void;
  nextUserText?: string | null;
}) {
  const chosen = matchChosenOption(nextUserText ?? '', block.questions);
  const [pending, setPending] = useState<string | null>(null);
  const answered = chosen ?? pending;

  const pick = (option: string) => {
    if (answered || !onChoose) return;
    setPending(option);
    onChoose(option);
  };

  return (
    <div className="space-y-3 rounded-xl border border-accent-500/20 bg-accent-50/60 px-3 py-2.5">
      {block.questions.map((question) => (
        <div key={question.question} className="space-y-1.5">
          <p className="text-[12.5px] font-semibold text-[#1F1B3A]">{question.question}</p>
          <div className="flex flex-wrap gap-2">
            {question.options.map((option) => {
              const isPicked = answered === option;
              return (
                <button
                  key={option}
                  type="button"
                  disabled={Boolean(answered) || !onChoose}
                  onClick={() => pick(option)}
                  title={isPicked ? 'Sudah kamu pilih' : 'Klik untuk mengirim pilihan ini'}
                  className={`rounded-full border px-3 py-1.5 text-left text-[12px] font-medium transition ${
                    isPicked
                      ? 'border-accent-500 bg-gradient-to-br from-accent-500 to-accent-700 text-white shadow-soft'
                      : answered
                        ? 'border-black/[0.06] bg-white/50 text-muted/60'
                        : 'border-accent-300/70 bg-white text-accent-700 hover:border-accent-500 hover:bg-accent-50'
                  } disabled:cursor-default`}
                >
                  {option}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <p className="text-[11px] text-muted/80">
        {answered ? 'Pilihan terkirim — agent melanjutkan dengan opsi ini.' : 'Atau tulis jawabanmu sendiri di kolom chat.'}
      </p>
    </div>
  );
}

/** Baris kecil pemakaian token & biaya - supaya pemakaian model terlihat jelas. */
function UsageView({ block }: { block: { promptTokens: number; completionTokens: number; cachedTokens?: number; costUsd?: number } }) {
  const cached = block.cachedTokens ?? 0;
  const cachedPct = block.promptTokens > 0 ? Math.round((cached / block.promptTokens) * 100) : 0;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted/80">
      <span className="font-medium text-muted">Pemakaian</span>
      <span>{fmt(block.promptTokens)} token masuk</span>
      {cached > 0 && <span className="text-emerald-600">({cachedPct}% dari cache - hemat)</span>}
      <span>· {fmt(block.completionTokens)} token keluar</span>
      {typeof block.costUsd === 'number' && <span>· ≈ ${fmtCost(block.costUsd)}</span>}
    </p>
  );
}

function fmt(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}jt`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function fmtCost(value: number): string {
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.01) return value.toFixed(3);
  return value.toFixed(4);
}

function ReasoningView({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-accent-500/15 bg-accent-50/70 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-[12.5px] font-medium text-accent-700"
      >
        <BrainIcon className="h-4 w-4" />
        Proses berpikir model
        <ChevronIcon className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-muted light-scroll">
          {text}
        </pre>
      )}
    </div>
  );
}

function NoticeView({ level, text }: { level: 'info' | 'warn' | 'error'; text: string }) {
  const styles =
    level === 'error'
      ? 'border-rose-300/50 bg-rose-50 text-rose-700'
      : level === 'warn'
        ? 'border-amber-300/60 bg-amber-50 text-amber-800'
        : 'border-accent-300/50 bg-accent-50 text-accent-700';
  return (
    <div className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-[12.5px] leading-relaxed ${styles}`}>
      <WarnIcon className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="break-words">{text}</span>
    </div>
  );
}

function ToolView({ block }: { block: UiToolBlock }) {
  const [open, setOpen] = useState(false);
  const output = block.output ?? block.liveOutput ?? '';
  const ok = block.status === 'ok';
  const running = block.status === 'running';

  return (
    <div className="overflow-hidden rounded-xl border border-black/[0.07] bg-white/70 shadow-[0_6px_18px_-14px_rgba(31,27,58,0.4)] backdrop-blur">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span
          className={`flex h-5 w-5 items-center justify-center rounded-md ${
            running ? 'bg-accent-100 text-accent-600' : ok ? 'bg-emerald-100 text-emerald-600' : 'bg-rose-100 text-rose-600'
          }`}
        >
          {running ? (
            <DotIcon className="h-3 w-3 animate-pulse-dot" />
          ) : ok ? (
            <CheckIcon className="h-3.5 w-3.5" />
          ) : (
            <WarnIcon className="h-3.5 w-3.5" />
          )}
        </span>
        <TerminalIcon className="h-3.5 w-3.5 text-muted" />
        <span className="text-[12.5px] font-semibold text-[#1F1B3A]">{TOOL_LABEL[block.name] ?? block.name}</span>
        {toolTarget(block) && (
          <code className="min-w-0 flex-1 truncate rounded bg-black/[0.04] px-1.5 py-0.5 font-mono text-[11.5px] text-muted">
            {toolTarget(block)}
          </code>
        )}
        <ChevronIcon className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {block.previewUrl && (
        <a
          href={block.previewUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 border-t border-black/[0.06] px-3 py-1.5 text-[11.5px] text-accent-600 hover:bg-accent-50"
        >
          <ExternalIcon className="h-3.5 w-3.5" /> {block.previewUrl}
        </a>
      )}

      {open && output && (
        <pre className="max-h-80 overflow-auto border-t border-black/[0.06] bg-ink-950 px-3 py-2.5 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink-200 light-scroll">
          {output}
        </pre>
      )}
    </div>
  );
}
