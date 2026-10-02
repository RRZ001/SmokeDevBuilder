import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AgentCloud - Cloud AI Coding Agent',
  description:
    'AI coding agent di cloud: chat interaktif, cloud sandbox E2B, tool eksekusi terminal & file, live preview, riwayat tersimpan di Supabase atau SQLite.',
};

export const viewport: Viewport = {
  themeColor: '#0C0C15',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body className="min-h-screen bg-ink-950 text-ink-200">{children}</body>
    </html>
  );
}
