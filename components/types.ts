'use client';

import type {
  Block,
  ChoicesBlock,
  NoticeBlock,
  PlanBlock,
  ReasoningBlock,
  TextBlock,
  ToolBlock,
  UsageBlock,
} from '@/lib/db/types';

/** ToolBlock versi UI: menyimpan output yang sedang di-stream secara live. */
export type UiToolBlock = ToolBlock & { liveOutput?: string };
export type UiUsageBlock = UsageBlock;
export type UiChoicesBlock = ChoicesBlock;
/** Blok rencana (daftar centang) — lihat lib/agent/plan.ts. */
export type UiPlanBlock = PlanBlock;
/** Screenshot hasil browser_check — hanya untuk sesi berjalan, tidak disimpan. */
export type UiImageBlock = { type: 'image'; dataUrl: string; caption: string };
export type UiBlock =
  | TextBlock
  | ReasoningBlock
  | NoticeBlock
  | UiUsageBlock
  | UiToolBlock
  | UiChoicesBlock
  | UiPlanBlock
  | UiImageBlock;

export type UiMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  blocks: UiBlock[];
  created_at?: string;
  pending?: boolean;
};

export type FileEntry = { path: string; name: string; type: 'file' | 'dir'; size: number };

export type TreeNode = {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  children: TreeNode[];
};

export type BootstrapResponse = {
  owner: string;
  settings: {
    model: string;
    hasKey: boolean;
    keySource: 'env' | 'settings' | 'none';
    keyPreview: string;
    updatedAt: string | null;
    /** Status token deploy Vercel (nilainya sendiri tidak pernah dikirim). */
    vercel?: {
      hasToken: boolean;
      tokenPreview: string;
      tokenSource: 'env' | 'settings' | 'none';
      scope: string;
    };
  };
  projects: ProjectLite[];
  capabilities: {
    openrouterFromEnv: boolean;
    e2bFromEnv: boolean;
    supabaseConfigured: boolean;
    supabaseRole: string;
    /** true = SUPABASE_URL diisi tapi formatnya tidak sah. */
    supabaseUrlInvalid?: boolean;
    sandboxDir: string;
    defaultPreviewPort: number;
    /** true = hosting serverless (mis. Vercel) tanpa Supabase → data tidak persisten. */
    storageEphemeral?: boolean;
    /** Peringatan penyimpanan file proyek (mis. tabel ac_files belum dibuat). */
    filesPersistenceWarning?: string | null;
    serverless?: boolean;
    storage: {
      configured: 'supabase' | 'sqlite';
      active: 'supabase' | 'sqlite';
      supabaseConfigured: boolean;
      supabaseRole: string;
      supabaseError?: string | null;
    };
  };
};

export type ProjectLite = {
  id: string;
  name: string;
  description: string;
  sandbox_id: string | null;
  preview_port: number | null;
  created_at: string;
  updated_at: string;
  /** Link permanen hasil deploy ke Vercel (kalau pernah dideploy). */
  deploy_url?: string | null;
  deploy_at?: string | null;
};

export type ToolTemplate = { id: string; name: string; args: Record<string, unknown>; status: 'running' | 'ok' | 'error'; output?: string; previewUrl?: string };

export function toUiBlocks(parts: UiBlock[] | Block[] | null, fallbackText: string): UiBlock[] {
  if (parts && parts.length) return parts as UiBlock[];
  return fallbackText ? [{ type: 'text', text: fallbackText }] : [];
}

export function buildTree(entries: FileEntry[]): TreeNode {
  const root: TreeNode = { name: 'project', path: '', type: 'dir', size: 0, children: [] };
  const index = new Map<string, TreeNode>([['', root]]);

  for (const entry of entries) {
    const segments = entry.path.split('/').filter(Boolean);
    let current = root;
    let walked = '';
    segments.forEach((segment, i) => {
      walked = walked ? `${walked}/${segment}` : segment;
      const isLeaf = i === segments.length - 1;
      let node = index.get(walked);
      if (!node) {
        node = {
          name: segment,
          path: walked,
          type: isLeaf ? entry.type : 'dir',
          size: isLeaf ? entry.size : 0,
          children: [],
        };
        index.set(walked, node);
        current.children.push(node);
      }
      current = node;
    });
  }

  const sortNodes = (node: TreeNode) => {
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortNodes);
  };
  sortNodes(root);
  return root;
}
