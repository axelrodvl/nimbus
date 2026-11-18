import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { TextInput } from '@/components/ui/text-input';
import { apiErrorMessage } from '@/lib/api/error-message';
import { useT } from '@/lib/i18n/provider';
import { addAlbumMagnet } from '@/lib/sources/actions';
import { checkMagnet } from '@/lib/sources/magnet';

/** «Свой magnet»: формат проверяется на клиенте (ошибка показывается, когда в поле что-то введено). */
export function AddMagnetForm({ albumId }: { albumId: number }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [magnet, setMagnet] = useState('');
  const [pending, setPending] = useState(false);
  const check = checkMagnet(magnet);
  return (
    <form
      className="flex w-full max-w-xl flex-col gap-1"
      data-testid="add-magnet-form"
      onSubmit={async e => {
        e.preventDefault();
        if (check !== 'ok' || pending) return;
        setPending(true);
        try {
          await addAlbumMagnet(albumId, magnet, { queryClient });
          toast.success(t('sources.magnetAdded'));
          setMagnet('');
        } catch (error) {
          toast.error(apiErrorMessage(error, t));
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="flex gap-2">
        <TextInput
          aria-describedby="magnet-error"
          aria-invalid={check === 'format' || undefined}
          aria-label={t('sources.magnetLabel')}
          className="flex-1"
          onChange={e => setMagnet(e.target.value)}
          placeholder="magnet:?xt=urn:btih:…"
          value={magnet}
        />
        <Button disabled={check !== 'ok'} pending={pending} type="submit">
          {t('sources.addMagnet')}
        </Button>
      </div>
      <p
        aria-live="polite"
        className="text-danger-fg min-h-4 px-4 text-xs"
        data-testid="magnet-error"
        id="magnet-error"
      >
        {check === 'format' ? t('error.invalid_magnet') : ''}
      </p>
    </form>
  );
}
