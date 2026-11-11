import { connection } from 'next/server';
import { SettingsView } from '@/features/settings/components/settings-view';
import type { Settings, Storage } from '@/features/settings/types';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';

export async function SettingsPage() {
  await connection();
  const settings = unwrap(await api.GET('/api/settings')) as unknown as Settings;
  const storage = await api
    .GET('/api/storage')
    .then(r => unwrap(r) as Storage)
    .catch(() => null);
  return <SettingsView settings={settings} storage={storage} />;
}
