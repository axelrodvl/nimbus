import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
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
    appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Nimbus' },
    description: t('app.description'),
    icons: { apple: '/icons/apple-touch-icon.png' },
    title: {
      default: 'Nimbus',
      template: '%s · Nimbus',
    },
  };
}

// Язык зависит от запроса (cookie / Accept-Language), поэтому корневой layout динамический:
// страница отдаётся целиком по запросу, без статической оболочки.
export const instant = false;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [locale, messages] = await Promise.all([getLocale(), getMessages()]);
  return (
    <html lang={locale} className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body className="bg-surface dark:bg-surface-dark flex h-[100dvh] flex-col text-black antialiased dark:text-white">
        <I18nProvider locale={locale} messages={messages}>
          <ThemeProvider>
            <OfflineIndicator />
            {children}
            <Toaster />
          </ThemeProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
