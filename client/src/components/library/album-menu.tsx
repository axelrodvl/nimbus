import * as Ariakit from '@ariakit/react';
import { MoreHorizontal } from 'lucide-react';
import { useNavigate } from 'react-router';
import { MenuSheet } from '@/components/ui/menu-sheet';
import { useT } from '@/lib/i18n/provider';
import { useRemoveFromLibrary } from './remove-from-library-button';
import { menuItemClass } from './row-menu';

type Props = { store: Ariakit.MenuStore; albumId: number; artistId: number };

/** Меню карточки альбома; открывается долгим нажатием (у карточки нет кнопки «…»). */
export function AlbumMenu({ store, albumId, artistId }: Props) {
  const t = useT();
  const navigate = useNavigate();
  return (
    <Ariakit.MenuProvider store={store}>
      <MenuSheet>
        <Ariakit.MenuItem className={menuItemClass} onClick={() => void navigate(`/album/${albumId}`)}>
          {t('player.goAlbum')}
        </Ariakit.MenuItem>
        <Ariakit.MenuItem className={menuItemClass} onClick={() => void navigate(`/artist/${artistId}`)}>
          {t('player.goArtist')}
        </Ariakit.MenuItem>
      </MenuSheet>
    </Ariakit.MenuProvider>
  );
}

/** Меню «…» шапки альбома: «Источники» и «Удалить из библиотеки» (если альбом в библиотеке). */
export function AlbumHeaderMenu({ albumId, title, inLibrary }: { albumId: number; title: string; inLibrary: boolean }) {
  const t = useT();
  const navigate = useNavigate();
  const remove = useRemoveFromLibrary({ id: albumId, redirectTo: '/library/albums', title, type: 'album' });
  return (
    <Ariakit.MenuProvider>
      <Ariakit.MenuButton
        aria-label={t('menu.actions', { title })}
        className="border-divider hover:bg-card dark:border-divider-dark dark:hover:bg-card-dark focus-visible:ring-accent/40 flex size-10 shrink-0 items-center justify-center rounded-full border focus-visible:ring-2 focus-visible:outline-none"
        data-testid="album-menu"
      >
        <MoreHorizontal aria-hidden className="size-5" />
      </Ariakit.MenuButton>
      <MenuSheet>
        <Ariakit.MenuItem
          className={menuItemClass}
          data-testid="album-sources-link"
          onClick={() => void navigate(`/album/${albumId}/sources`)}
        >
          {t('album.sources')}
        </Ariakit.MenuItem>
        {inLibrary ? (
          <Ariakit.MenuItem className={menuItemClass} data-testid="album-remove" onClick={remove.open}>
            {t('remove.button')}
          </Ariakit.MenuItem>
        ) : null}
      </MenuSheet>
      {remove.dialog}
    </Ariakit.MenuProvider>
  );
}
