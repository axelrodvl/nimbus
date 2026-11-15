import * as Ariakit from '@ariakit/react';
import { useNavigate } from 'react-router';
import { MenuSheet } from '@/components/ui/menu-sheet';
import { useT } from '@/lib/i18n/provider';
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
