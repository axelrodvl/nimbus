import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import { Suspense } from 'react';
import { OfflineIndicator } from '@/components/offline-indicator';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { Toaster } from '@/components/toaster';
import { getLocale, getMessages, getT } from '@/lib/i18n/server';
import { I18nProvider } from '@/providers/i18n-provider';
import type { Metadata, Viewport } from 'next';
import './globals.css';

export const viewport: Viewport = {
  themeColor: [
    { color: '#fafafa', media: '(prefers-color-scheme: light)' },
    { color: '#121212', media: '(prefers-color-scheme: dark)' },
  ],
  viewportFit: 'cover',
};

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    description: t('app.description'),
    title: {
      default: 'Nimbus',
      template: '%s · Nimbus',
    },
  };
}

// Язык берётся из cookie/заголовка, то есть зависит от запроса: всё содержимое страницы лежит внутри
// Suspense, а `<html lang>` обновляет I18nProvider на клиенте (статическая оболочка остаётся пререндеримой).
async function LocalizedShell({ children }: { children: React.ReactNode }) {
  const [locale, messages] = await Promise.all([getLocale(), getMessages()]);
  return (
    <I18nProvider locale={locale} messages={messages}>
      <ThemeProvider>
        <OfflineIndicator />
        {children}
        <Toaster />
      </ThemeProvider>
    </I18nProvider>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body className="bg-surface dark:bg-surface-dark flex h-[100dvh] flex-col text-black antialiased dark:text-white">
        <Suspense fallback={null}>
          <LocalizedShell>{children}</LocalizedShell>
        </Suspense>
      </body>
    </html>
  );
}
