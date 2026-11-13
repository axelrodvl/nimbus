'use client';

import { useState } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { useT } from '@/providers/i18n-provider';

// Поле имени + «Создать». `onSubmit` возвращает `true`, если форму можно очистить/закрыть.
export function NewPlaylistForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (name: string) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const trimmed = name.trim();

  return (
    <form
      className="flex gap-2"
      onSubmit={async e => {
        e.preventDefault();
        if (!trimmed || pending) return;
        setPending(true);
        try {
          if (await onSubmit(trimmed)) setName('');
        } finally {
          setPending(false);
        }
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape' && onCancel) {
            e.stopPropagation();
            onCancel();
          }
        }}
        maxLength={100}
        placeholder={t('playlist.namePlaceholder')}
        aria-label={t('playlist.namePlaceholder')}
        className="border-divider dark:border-divider-dark focus:border-accent min-w-0 flex-1 rounded-full border bg-transparent px-4 py-2 text-sm outline-none"
      />
      <button
        type="submit"
        disabled={!trimmed || pending}
        className="bg-accent hover:bg-accent-hover inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? <Spinner className="h-4 w-4" /> : null}
        {t('playlist.create')}
      </button>
    </form>
  );
}
