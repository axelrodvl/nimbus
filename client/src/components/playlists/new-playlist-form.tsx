import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { TextInput } from '@/components/ui/text-input';
import { useT } from '@/lib/i18n/provider';

/** Максимальная длина названия (как на сервере). */
export const PLAYLIST_NAME_MAX = 100;

/**
 * Поле названия и «Создать». Пока идёт запрос — состояние ожидания (плейлист появляется после ответа сервера).
 * `onSubmit` возвращает `true`, если форму можно очистить.
 */
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
      data-testid="new-playlist-form"
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
      <TextInput
        aria-label={t('playlist.namePlaceholder')}
        autoFocus
        className="flex-1"
        disabled={pending}
        maxLength={PLAYLIST_NAME_MAX}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape' && onCancel) {
            e.stopPropagation();
            onCancel();
          }
        }}
        placeholder={t('playlist.namePlaceholder')}
        value={name}
      />
      <Button disabled={!trimmed} pending={pending} type="submit">
        {t('playlist.create')}
      </Button>
    </form>
  );
}
