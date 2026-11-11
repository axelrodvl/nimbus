import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { FastLink } from '@/components/ui/fast-link';

// Данные библиотеки появятся в шаге 11; пока всегда пусто.
export function EmptyLibrary() {
  return (
    <EmptyState title="Библиотека пуста" body="Найдите музыку через поиск и добавьте её в библиотеку.">
      <FastLink href="/search">
        <Button variant="secondary">Перейти к поиску</Button>
      </FastLink>
    </EmptyState>
  );
}
