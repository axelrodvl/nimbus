import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayableTrackRow } from '@/components/player/play-buttons';
import type * as sourcesApi from '@/lib/api/sources';
import { appData } from '@/lib/app-data';
import { resetPlayer } from '@/lib/player';
import { installTestPlayer, seedPlayerLibrary } from '@/test/player-ui';
import { renderWithProviders } from '@/test/render';

vi.mock('@/lib/api/settings', () => ({ loadPrefetchEnabled: async () => true }));
vi.mock('@/lib/api/sources', async importOriginal => ({
  ...(await importOriginal<typeof sourcesApi>()),
  getAlbumTorrents: vi.fn(async () => []),
  getTrackSources: vi.fn(async () => []),
}));

/** Список со switch'ем: строку можно убрать из него (как прокрутка виртуального списка или смена фильтра). */
function List() {
  const [show, setShow] = useState(true);
  return (
    <>
      <button onClick={() => setShow(false)} type="button">
        remove-row
      </button>
      {show ? <PlayableTrackRow id={10} queueIds={[10]} /> : null}
    </>
  );
}

beforeEach(() => {
  seedPlayerLibrary();
  installTestPlayer();
});
afterEach(() => resetPlayer(true));

async function openPlaylistDialog() {
  await userEvent.click(screen.getByTestId('track-menu'));
  await userEvent.click(await screen.findByRole('menuitem', { name: /плейлист/i }));
  return screen.findByRole('dialog');
}

describe('общие диалоги трека', () => {
  it('dialog stays open when its row unmounts', async () => {
    renderWithProviders(<List />);
    const dialog = await openPlaylistDialog();
    expect(dialog).toHaveTextContent('Song One');
    act(() => screen.getByText('remove-row').click());
    expect(document.querySelector('[data-track-id="10"]')).toBeNull();
    expect(screen.getByRole('dialog')).toHaveTextContent('Song One');
  });

  it('dialog closes when the track disappears from the library', async () => {
    renderWithProviders(<List />);
    await openPlaylistDialog();
    act(() =>
      appData()
        .library.getState()
        .applyBatch({ deleted: [{ entity: 'track', id: 10 }] }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
