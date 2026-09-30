'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiJson } from '@/lib/client';
import { CheckIcon, ChevronIcon, CloseIcon, GearIcon, SparkIcon, WarnIcon } from './icons';
import type { BootstrapResponse } from './types';

type ModelOption = {
  id: string;
  label: string;
  vendor: string;
  note?: string;
  retired?: boolean;
  recommended?: boolean;
};

type ModelsResponse = {
  catalog: ModelOption[];
  liveExtra: ModelOption[];
  liveCount: number;
  liveError: string | null;
  defaultModel: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  settings: BootstrapResponse['settings'];
  capabilities: BootstrapResponse['capabilities'];
  onSaved: (settings: BootstrapResponse['settings']) => void;
};

export default function SettingsModal({ open, onClose, settings, capabilities, onSaved }: Props) {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(settings.model);
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [search, setSearch] = useState('');
  const [dropdown, setDropdown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setModel(settings.model);
    setApiKey('');
    setFeedback(null);
  }, [open, settings.model]);

  useEffect(() => {
    if (!open || models) return;
    void loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function loadModels() {
    setLoadingModels(true);
    try {
      const data = await apiJson<ModelsResponse>('/api/models');
      setModels(data);
      if (data.liveError) {
        setFeedback({ ok: false, text: `Daftar model live gagal dimuat (${data.liveError}). Memakai katalog bawaan.` });
      }
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoadingModels(false);
    }
  }

  const options = useMemo(() => {
    if (!models) return [];
    const all = [...models.catalog, ...models.liveExtra];
    const q = search.trim().toLowerCase();
    return q ? all.filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q)) : all;
  }, [models, search]);

  const selected = useMemo(() => {
    const all = models ? [...models.catalog, ...models.liveExtra] : [];
    return all.find((m) => m.id === model);
  }, [models, model]);

  async function save() {
    setSaving(true);
    setFeedback(null);
    try {
      const payload: Record<string, unknown> = { model };
      if (apiKey.trim()) payload.openrouter_api_key = apiKey.trim();
      const data = await apiJson<{ settings: BootstrapResponse['settings'] }>('/api/settings', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      onSaved(data.settings);
      setApiKey('');
      setFeedback({ ok: true, text: 'Pengaturan tersimpan.' });
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setFeedback(null);
    try {
      const data = await apiJson<{ ok: boolean; message: string; latencyMs: number }>('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ action: 'test', model, ...(apiKey.trim() ? { openrouter_api_key: apiKey.trim() } : {}) }),
      });
      setFeedback({ ok: data.ok, text: `${data.message} (${data.latencyMs} ms)` });
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }

  if (!open) return null;

  const keyFromEnv = settings.keySource === 'env';
  const e2bReady = capabilities.e2bFromEnv;
  const storage = capabilities.storage;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/70 p-4 backdrop-blur-sm sm:items-center">
      <div className="w-full max-w-2xl animate-fade-up rounded-2xl border border-white/10 bg-ink-900/95 p-5 shadow-glass">
        <header className="mb-4 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-accent-500 to-accent-700 text-white">
            <GearIcon className="h-4 w-4" />
          </span>
          <div className="mr-auto">
            <h2 className="text-[15px] font-semibold text-white">Settings</h2>
            <p className="text-[11.5px] text-ink-400">API key, model AI, dan status layanan</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-ink-300 hover:text-white"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-4">
          {/* OpenRouter key */}
          <section className="rounded-xl border border-white/[0.07] bg-ink-950/60 p-3.5">
            <label className="block text-[12px] font-semibold text-ink-200">OpenRouter API Key</label>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-400">
              Ambil di <span className="text-accent-300">openrouter.ai/keys</span>. Key disimpan di database server
              (atau isi <code className="font-mono text-accent-300">OPENROUTER_API_KEY</code> di environment hosting).
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={settings.hasKey ? `Tersimpan: ${settings.keyPreview}` : 'sk-or-v1-...'}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-ink-900 px-3 py-2 font-mono text-[12.5px] text-ink-200 outline-none placeholder:text-ink-600"
              />
              <button
                type="button"
                onClick={test}
                disabled={testing}
                className="rounded-lg border border-white/10 px-3 py-2 text-[12px] font-medium text-ink-200 transition hover:border-accent-300/50 hover:text-white disabled:opacity-50"
              >
                {testing ? 'Menguji…' : 'Tes koneksi'}
              </button>
            </div>
            <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-ink-400">
              {settings.hasKey ? (
                <>
                  <CheckIcon className="h-3.5 w-3.5 text-emerald-400" />
                  Key aktif{keyFromEnv ? ' dari environment' : ' dari database'}
                </>
              ) : (
                <>
                  <WarnIcon className="h-3.5 w-3.5 text-amber-400" />
                  Belum ada key - chat belum bisa jalan
                </>
              )}
            </p>
          </section>

          {/* Model */}
          <section className="rounded-xl border border-white/[0.07] bg-ink-950/60 p-3.5">
            <label className="block text-[12px] font-semibold text-ink-200">Model AI</label>
            <p className="mt-0.5 text-[11.5px] text-ink-400">
              {models
                ? `${models.catalog.length} model katalog + ${models.liveExtra.length} model live dari OpenRouter`
                : 'Memuat daftar model…'}
            </p>

            <div className="relative mt-2">
              <button
                type="button"
                onClick={() => setDropdown((v) => !v)}
                className="flex w-full items-center gap-2 rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-left"
              >
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-200">
                  {selected ? `${selected.label} — ${selected.id}` : model}
                </span>
                {selected?.retired && (
                  <span className="shrink-0 rounded-full bg-amber-400/15 px-2 py-0.5 text-[10.5px] text-amber-300">arsip</span>
                )}
                <ChevronIcon className={`h-4 w-4 shrink-0 text-ink-400 transition-transform ${dropdown ? 'rotate-180' : ''}`} />
              </button>

              {dropdown && (
                <div className="absolute z-20 mt-1 max-h-80 w-full overflow-hidden rounded-xl border border-white/10 bg-ink-850 shadow-glass">
                  <div className="flex items-center gap-2 border-b border-white/[0.07] p-2">
                    <input
                      autoFocus
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Cari model…"
                      className="min-w-0 flex-1 rounded-lg border border-white/10 bg-ink-950 px-2.5 py-1.5 text-[12px] text-ink-200 outline-none placeholder:text-ink-600"
                    />
                    <button
                      type="button"
                      onClick={loadModels}
                      disabled={loadingModels}
                      className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[11.5px] text-ink-300 hover:text-white disabled:opacity-50"
                    >
                      {loadingModels ? '…' : 'Muat live'}
                    </button>
                  </div>
                  <div className="max-h-64 overflow-y-auto p-1.5">
                    {options.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => {
                          setModel(option.id);
                          setDropdown(false);
                          setSearch('');
                        }}
                        className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-white/[0.06] ${
                          option.id === model ? 'bg-accent-500/15' : ''
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-[12.5px] font-medium text-ink-200">{option.label}</span>
                            <span className="shrink-0 text-[10.5px] text-ink-600">{option.vendor}</span>
                            {option.recommended && (
                              <span className="shrink-0 rounded-full bg-accent-500/20 px-1.5 py-0.5 text-[10px] text-accent-300">
                                rekomendasi
                              </span>
                            )}
                            {option.retired && (
                              <span className="shrink-0 rounded-full bg-amber-400/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                                arsip
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block truncate font-mono text-[11px] text-ink-400">{option.id}</span>
                          {option.note && <span className="mt-0.5 block text-[11px] text-ink-500">{option.note}</span>}
                        </span>
                        {option.id === model && <CheckIcon className="mt-1 h-3.5 w-3.5 shrink-0 text-accent-300" />}
                      </button>
                    ))}
                    {!options.length && <p className="px-2 py-3 text-[12px] text-ink-400">Model tidak ditemukan.</p>}
                  </div>
                </div>
              )}
            </div>

            {selected?.retired && (
              <p className="mt-2 flex items-start gap-1.5 text-[11.5px] text-amber-300">
                <WarnIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Model ini sudah ditarik dari OpenRouter dan akan mengembalikan error 404. Pilih penggantinya, mis. Claude
                Sonnet 4.5.
              </p>
            )}
          </section>

          {/* Status layanan */}
          <section className="grid gap-3 sm:grid-cols-3">
            <StatusCard
              title="Penyimpanan"
              ok
              value={storage.active === 'supabase' ? 'Supabase' : 'SQLite lokal'}
              hint={
                storage.supabaseConfigured
                  ? storage.active === 'supabase'
                    ? `Aktif (${storage.supabaseRole})`
                    : `Supabase gagal, fallback otomatis: ${storage.supabaseError ?? '-'}`
                  : 'SUPABASE_URL belum diisi - fallback otomatis aktif'
              }
            />
            <StatusCard
              title="Cloud sandbox"
              ok={e2bReady}
              value={e2bReady ? 'E2B siap' : 'Belum aktif'}
              hint={e2bReady ? `Direktori: ${capabilities.sandboxDir}` : 'Isi E2B_API_KEY di environment hosting'}
            />
            <StatusCard
              title="OpenRouter"
              ok={capabilities.openrouterFromEnv || settings.hasKey}
              value={capabilities.openrouterFromEnv ? 'Dari env' : settings.hasKey ? 'Dari database' : 'Belum ada key'}
              hint="Model dipakai untuk seluruh percakapan & tool"
            />
          </section>

          {feedback && (
            <p
              className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-[12px] ${
                feedback.ok ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-amber-400/30 bg-amber-400/10 text-amber-200'
              }`}
            >
              {feedback.ok ? <CheckIcon className="mt-0.5 h-4 w-4 shrink-0" /> : <WarnIcon className="mt-0.5 h-4 w-4 shrink-0" />}
              <span className="break-words">{feedback.text}</span>
            </p>
          )}
        </div>

        <footer className="mt-5 flex flex-wrap items-center gap-2">
          <p className="mr-auto flex items-center gap-1.5 text-[11.5px] text-ink-400">
            <SparkIcon className="h-3.5 w-3.5" /> Perubahan berlaku untuk percakapan berikutnya.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-white/10 px-3.5 py-2 text-[12.5px] text-ink-200 hover:text-white"
          >
            Tutup
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-gradient-to-br from-accent-500 to-accent-700 px-4 py-2 text-[12.5px] font-semibold text-white shadow-soft transition hover:brightness-110 disabled:opacity-50"
          >
            {saving ? 'Menyimpan…' : 'Simpan'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function StatusCard({ title, value, hint, ok }: { title: string; value: string; hint: string; ok: boolean }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-ink-950/60 p-3">
      <p className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-500">{title}</p>
      <p className={`mt-1 flex items-center gap-1.5 text-[12.5px] font-medium ${ok ? 'text-emerald-300' : 'text-amber-300'}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
        {value}
      </p>
      <p className="mt-1 break-words text-[11px] leading-relaxed text-ink-400">{hint}</p>
    </div>
  );
}
