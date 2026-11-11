import { Music } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FastLink } from '@/components/ui/fast-link';
import { getT } from '@/lib/i18n/server';

export default async function NotFound() {
  const t = await getT();
  return (
    <div className="flex flex-col items-center gap-3 px-5 py-16 text-center">
      <Music className="text-gray h-8 w-8" />
      <p className="text-sm font-medium text-black dark:text-white">{t('notFound.title')}</p>
      <p className="text-gray max-w-xs text-sm">{t('notFound.body')}</p>
      <FastLink href="/">
        <Button variant="secondary">{t('notFound.home')}</Button>
      </FastLink>
    </div>
  );
}
