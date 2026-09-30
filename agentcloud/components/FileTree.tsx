'use client';

import { useMemo, useState } from 'react';
import { ChevronIcon, FileIcon, FolderIcon } from './icons';
import { buildTree, type FileEntry, type TreeNode } from './types';

type Props = {
  files: FileEntry[];
  openPath?: string;
  onOpen: (path: string) => void;
  loading?: boolean;
  reason?: string | null;
};

export default function FileTree({ files, openPath, onOpen, loading, reason }: Props) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  if (loading) {
    return <p className="px-3 py-2 text-[12px] text-ink-400">Memuat daftar file…</p>;
  }
  if (!files.length) {
    return (
      <p className="px-3 py-2 text-[12px] leading-relaxed text-ink-400">
        {reason ?? 'Belum ada file di sandbox. Minta agent untuk membuat proyek dulu.'}
      </p>
    );
  }

  const toggle = (path: string) => setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }));

  const renderNode = (node: TreeNode, depth: number) => {
    if (node.type === 'dir') {
      const isCollapsed = collapsed[node.path];
      return (
        <div key={node.path}>
          <button
            type="button"
            onClick={() => toggle(node.path)}
            className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12.5px] text-ink-300 hover:bg-white/[0.04]"
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
          >
            <ChevronIcon className={`h-3 w-3 shrink-0 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
            <FolderIcon className="h-3.5 w-3.5 shrink-0 text-accent-300/80" />
            <span className="truncate">{node.name}</span>
          </button>
          {!isCollapsed && node.children.map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }

    const active = openPath === node.path;
    return (
      <button
        key={node.path}
        type="button"
        onClick={() => onOpen(node.path)}
        title={node.path}
        className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12.5px] transition ${
          active ? 'bg-accent-500/15 text-white' : 'text-ink-300 hover:bg-white/[0.04]'
        }`}
        style={{ paddingLeft: `${depth * 12 + 22}px` }}
      >
        <FileIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
        <span className="truncate">{node.name}</span>
      </button>
    );
  };

  return <div className="py-1">{tree.children.map((child) => renderNode(child, 0))}</div>;
}
