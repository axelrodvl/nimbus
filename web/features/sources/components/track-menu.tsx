'use client';

import * as Ariakit from '@ariakit/react';
import { MoreHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { retryTrack } from '@/app/actions/sources';
import { TrackSourceDialog } from '@/features/sources/components/track-source-dialog';
import { useT } from '@/providers/i18n-provider';

const itemClass =
  'hover:bg-card dark:hover:bg-card-dark data-[active-item]:bg-card dark:data-[active-item]:bg-card-dark flex cursor-pointer items-center rounded px-3 py-1.5 text-sm outline-none';

// Меню «…» строки трека: выбор источника и (для not_found) повторный поиск.
export function TrackMenu({
  trackId,
  albumId,
  title,
  notFound,
}: {
  trackId: number;
  albumId: number;
  title: string;
  notFound: boolean;
}) {
  const t = useT();
  const dialog = Ariakit.useDialogStore();
  return (
    <>
      <Ariakit.MenuProvider>
        <Ariakit.MenuButton
          aria-label={t('menu.actions', { title })}
          className="text-gray hover:bg-card dark:hover:bg-card-dark flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </Ariakit.MenuButton>
        <Ariakit.Menu
          gutter={4}
          portal
          className="border-divider dark:border-divider-dark z-30 min-w-44 rounded-lg border bg-white p-1 shadow-lg dark:bg-black"
        >
          <Ariakit.MenuItem className={itemClass} onClick={() => dialog.show()}>
            {t('menu.chooseSource')}
          </Ariakit.MenuItem>
          {notFound ? (
            <Ariakit.MenuItem
              className={itemClass}
              onClick={async () => {
                const r = await retryTrack(trackId, albumId);
                if (r.ok) toast.success(t('sources.retryStarted'));
                else toast.error(r.message);
              }}
            >
              {t('sources.retry')}
            </Ariakit.MenuItem>
          ) : null}
        </Ariakit.Menu>
      </Ariakit.MenuProvider>
      <TrackSourceDialog store={dialog} trackId={trackId} albumId={albumId} title={title} />
    </>
  );
}
