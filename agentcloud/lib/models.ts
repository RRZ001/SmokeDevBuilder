export type ModelInfo = {
  id: string;
  label: string;
  vendor: string;
  note?: string;
  /** true = id sudah tidak dilayani OpenRouter (ditampilkan sebagai arsip). */
  retired?: boolean;
  recommended?: boolean;
};

export const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5';

/**
 * Katalog statis. Daftar ini dipakai sebagai default & fallback;
 * tombol "Muat model live" di Settings akan mengambil daftar asli dari OpenRouter.
 */
export const MODEL_CATALOG: ModelInfo[] = [
  {
    id: 'anthropic/claude-sonnet-4.5',
    label: 'Claude Sonnet 4.5',
    vendor: 'Anthropic',
    note: 'Pengganti resmi Claude 3.7 Sonnet',
    recommended: true,
  },
  {
    id: 'anthropic/claude-sonnet-4',
    label: 'Claude Sonnet 4',
    vendor: 'Anthropic',
  },
  {
    id: 'anthropic/claude-3.7-sonnet',
    label: 'Claude 3.7 Sonnet',
    vendor: 'Anthropic',
    note: 'Sudah ditarik dari OpenRouter - gunakan Sonnet 4.5',
    retired: true,
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    label: 'Claude 3.5 Sonnet',
    vendor: 'Anthropic',
    note: 'Sudah ditarik dari OpenRouter - gunakan Sonnet 4.5',
    retired: true,
  },
  {
    id: 'deepseek/deepseek-chat-v3-0324',
    label: 'DeepSeek V3 (0324)',
    vendor: 'DeepSeek',
    note: 'Murah, cepat, bagus untuk scaffold & refactor',
  },
  {
    id: 'deepseek/deepseek-chat-v3.1',
    label: 'DeepSeek V3.1',
    vendor: 'DeepSeek',
  },
  {
    id: 'deepseek/deepseek-r1-0528',
    label: 'DeepSeek R1 (0528)',
    vendor: 'DeepSeek',
    note: 'Reasoning chain-of-thought ditampilkan di panel chat',
  },
  {
    id: 'deepseek/deepseek-r1',
    label: 'DeepSeek R1',
    vendor: 'DeepSeek',
    note: 'Reasoning chain-of-thought ditampilkan di panel chat',
  },
  {
    id: 'openai/gpt-4o',
    label: 'GPT-4o',
    vendor: 'OpenAI',
  },
  {
    id: 'openai/gpt-4o-mini',
    label: 'GPT-4o mini',
    vendor: 'OpenAI',
  },
];

export function findModel(id: string): ModelInfo | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

export function modelLabel(id: string): string {
  return findModel(id)?.label ?? id;
}

export function isRetired(id: string): boolean {
  return Boolean(findModel(id)?.retired);
}

/** Susun daftar final: katalog + model yang diambil live dari OpenRouter. */
export function mergeCatalog(liveIds: string[]): { catalog: ModelInfo[]; liveExtra: ModelInfo[] } {
  const known = new Set(MODEL_CATALOG.map((m) => m.id.toLowerCase()));
  const liveExtra: ModelInfo[] = liveIds
    .map((id) => id.trim())
    .filter((id) => id && !known.has(id.toLowerCase()))
    .sort((a, b) => a.localeCompare(b))
    .map((id) => {
      const [vendor] = id.split('/');
      return {
        id,
        label: id.split('/').slice(1).join('/') || id,
        vendor: vendor ? vendor.charAt(0).toUpperCase() + vendor.slice(1) : 'Other',
        note: 'dari daftar live OpenRouter',
      } satisfies ModelInfo;
    });
  return { catalog: MODEL_CATALOG, liveExtra };
}
