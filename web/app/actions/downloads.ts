'use server';

import type { ActionResult } from '@/app/actions/settings';
import type { Download, Downloads } from '@/features/downloads/types';
import { actionFailure } from '@/lib/api/action-errors';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';

export async function loadDownloads(): Promise<ActionResult<{ downloads: Downloads }>> {
  try {
    const d = unwrap(await api.GET('/api/downloads', { cache: 'no-store' }));
    return { downloads: d as Downloads, ok: true };
  } catch (e) {
    return actionFailure(e);
  }
}

export async function setDownloadPaused(infoHash: Download['info_hash'], paused: boolean): Promise<ActionResult> {
  try {
    const path = { params: { path: { info_hash: infoHash } } };
    unwrap(
      paused
        ? await api.POST('/api/downloads/{info_hash}/pause', path)
        : await api.POST('/api/downloads/{info_hash}/resume', path),
    );
    return { ok: true };
  } catch (e) {
    return actionFailure(e);
  }
}
