'use client';

import { useEffect, useState } from 'react';
import { ExternalIcon, RefreshIcon } from './icons';

type Props = {
  url: string | null;
  port: number;
  status: string;
  online: boolean;
  loading: boolean;
  canPreview: boolean;
  reason?: string | null;
  /** 'loopback' = server hanya listen di 127.0.0.1, penyebab Closed Port Error. */
  listenScope?: 'all' | 'loopback' | 'none' | 'unknown' | null;
  restarted?: boolean;
  proxyError?: boolean;
  onRefresh: () => void;
  onRestart: () => void;
  onSetPort: (port: number) => void;
};

export default function PreviewPanel({
  url,
  port,
  status,
  online,
  loading,
  canPreview,
  reason,
  listenScope,
  restarted,
  proxyError,
  onRefresh,
  onRestart,
  onSetPort,
}: Props) {
  const [portDraft, setPortDraft] = useState(String(port));
  const [nonce, setNonce] = useState(0);

  useEffect(() => setPortDraft(String(port)), [port]);

  const bindHint =
    listenScope === 'loopback'
      ? 'Server hanya mendengarkan di 127.0.0.1 (localhost) sehingga proxy E2B tidak bisa menjangkaunya. Bind ke 0.0.0.0: Vite/Astro/Svelte → "npm run dev -- --host 0.0.0.0", Next.js → "--hostname 0.0.0.0", Express/Node → app.listen(port, "0.0.0.0").'
      : null;

  const offlineText = reason ?? bindHint;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-3 py-2">
        <span className="flex items-center gap-1.5 text-[11.5px] text-ink-400">
          port
          <input
            value={portDraft}
            onChange={(e) => setPortDraft(e.target.value.replace(/[^0-9]/g, '').slice(0, 5))}
            onBlur={() => {
              const value = Number(portDraft);
              if (value >= 1024 && value <= 65535 && value !== port) onSetPort(value);
              else setPortDraft(String(port));
            }}
            className="w-16 rounded border border-white/10 bg-ink-900 px-1.5 py-0.5 text-center font-mono text-[11.5px] text-ink-200 outline-none"
          />
        </span>

        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-white/10 bg-ink-900 px-2.5 py-1">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${online ? 'bg-emerald-400' : status === '000' ? 'bg-rose-400' : 'bg-amber-400'}`}
          />
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-300">{url ?? 'Belum ada sandbox aktif'}</span>
          <span className="shrink-0 font-mono text-[11px] text-ink-600">
            {loading ? 'memeriksa…' : `HTTP ${status}`}
          </span>
        </div>

        <button
          type="button"
          onClick={() => setNonce((n) => n + 1)}
          title="Muat ulang iframe"
          className="flex h-7 w-7 items-center justify-center rounded-md border border-white/10 text-ink-300 hover:text-white"
        >
          <RefreshIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onRefresh}
          disabled={!canPreview || loading}
          className="h-7 rounded-md border border-white/10 px-2.5 text-[11.5px] text-ink-300 hover:text-white disabled:opacity-40"
        >
          {loading ? 'Cek…' : 'Cek status'}
        </button>
        <button
          type="button"
          onClick={onRestart}
          disabled={!canPreview || loading}
          title="Jalankan ulang perintah dev server terakhir di sandbox (mis. setelah sandbox bangun dari pause)"
          className="h-7 rounded-md border border-white/10 px-2.5 text-[11.5px] text-ink-300 hover:text-white disabled:opacity-40"
        >
          Jalankan ulang server
        </button>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="flex h-7 items-center gap-1.5 rounded-md bg-accent-500/90 px-2.5 text-[11.5px] font-semibold text-white hover:brightness-110"
          >
            <ExternalIcon className="h-3.5 w-3.5" /> Buka tab baru
          </a>
        )}
      </div>

      {(restarted || proxyError) && (
        <div
          className={`border-b px-3 py-1.5 text-[11.5px] ${
            proxyError
              ? 'border-amber-300/20 bg-amber-300/[0.08] text-amber-200'
              : 'border-white/[0.06] bg-white/[0.02] text-ink-300'
          }`}
        >
          {proxyError
            ? 'URL publik E2B menolak koneksi — aplikasi belum benar-benar jalan di sandbox (bukan masalah kode di UI ini).'
            : 'Dev server dijalankan ulang otomatis.'}
        </div>
      )}

      <div className="relative flex-1 bg-ink-950">
        {url && online ? (
          <iframe
            key={`${url}-${nonce}`}
            src={url}
            title="Preview aplikasi"
            className="h-full w-full border-0 bg-white"
            allow="clipboard-read; clipboard-write"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            <p className="text-[13px] text-ink-300">
              {canPreview ? 'Server belum merespons di port ini.' : 'Preview belum tersedia.'}
            </p>
            <p className="max-w-md text-[12px] leading-relaxed text-ink-400">
              {offlineText ??
                (url
                  ? 'Server belum merespons di port ini. Kalau agent baru saja menyiapkan proyek, tunggu sebentar — status dicek otomatis setiap 4 detik, dan dev server yang mati akan dicoba dijalankan ulang otomatis.'
                  : 'Jalankan dev server di sandbox, mis. lewat tab Terminal: npm run dev -- --host 0.0.0.0 --port 3000. Agent juga menjalankannya otomatis lewat tool start_server.')}
            </p>
            <p className="text-[11.5px] text-ink-400">
              {loading ? 'Memeriksa status server…' : 'Pemeriksaan otomatis aktif (tanpa perlu klik).'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
