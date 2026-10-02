export function truncate(text: string, max = 8_000): string {
  if (!text) return '';
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  return `${head}\n... [dipotong ${text.length - max} karakter]`;
}

export function relPath(path: string, root: string): string {
  if (!path) return path;
  if (path === root) return '.';
  return path.startsWith(root + '/') ? path.slice(root.length + 1) : path;
}

export function joinSandboxPath(root: string, path: string): string {
  const raw = (path || '.').trim();
  if (raw.startsWith('/')) return normalize(raw);
  return normalize(`${root}/${raw}`);
}

export function normalize(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

const LANG_BY_EXT: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  json5: 'json',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  env: 'ini',
  sql: 'sql',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  dockerfile: 'dockerfile',
};

export function languageFromPath(path: string): string | undefined {
  const name = (path || '').split('/').pop() || '';
  if (/^dockerfile$/i.test(name)) return 'dockerfile';
  if (/^\.?env/i.test(name)) return 'ini';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return LANG_BY_EXT[ext];
}

export function isProbablyTextFile(path: string): boolean {
  const name = (path || '').split('/').pop() || '';
  if (!name.includes('.')) return true;
  return !/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|mp4|mov|mp3|woff2?|ttf|otf|so|bin|exe|class|jar|wasm|lock|sqlite|db)$/i.test(
    name,
  );
}

export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 12) return '••••';
  return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
}

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}
