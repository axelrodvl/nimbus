import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import { OfflineIndicator } from '@/components/offline-indicator';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { Toaster } from '@/components/toaster';
import type { Metadata, Viewport } from 'next';
import './globals.css';

export const viewport: Viewport = {
  themeColor: [
    { color: '#fafafa', media: '(prefers-color-scheme: light)' },
    { color: '#121212', media: '(prefers-color-scheme: dark)' },
  ],
  viewportFit: 'cover',
};

export const metadata: Metadata = {
  description: 'Веб-плеер: метаданные из MusicBrainz, музыка — потоково из торрентов.',
  title: {
    default: 'Nimbus',
    template: '%s · Nimbus',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body className="bg-surface dark:bg-surface-dark flex h-[100dvh] flex-col text-black antialiased dark:text-white">
        <ThemeProvider>
          <OfflineIndicator />
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
