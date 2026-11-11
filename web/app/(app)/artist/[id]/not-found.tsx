import { Music } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FastLink } from '@/components/ui/fast-link';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center gap-3 px-5 py-16 text-center">
      <Music className="text-gray h-8 w-8" />
      <p className="text-sm font-medium text-black dark:text-white">Не найдено</p>
      <p className="text-gray max-w-xs text-sm">Этого элемента нет в библиотеке.</p>
      <FastLink href="/library">
        <Button variant="secondary">В библиотеку</Button>
      </FastLink>
    </div>
  );
}
