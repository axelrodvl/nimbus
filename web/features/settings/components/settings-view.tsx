'use client';

import Link from 'next/link';
import { FormatOrder } from '@/features/settings/components/format-order';
import { ProviderTest } from '@/features/settings/components/provider-test';
import { ReleaseTypes } from '@/features/settings/components/release-types';
import { Check, Field, SectionForm, TextInput } from '@/features/settings/components/section-form';
import { SECRET_MASK, type Settings, type Storage } from '@/features/settings/types';
import { formatSize } from '@/features/sources/format';
import { useT } from '@/providers/i18n-provider';

const str = (fd: FormData, k: string) => String(fd.get(k) ?? '');
/** Пустая строка → null (сброс необязательного поля). */
const nz = (fd: FormData, k: string) => str(fd, k).trim() || null;
const num = (fd: FormData, k: string) => Number(str(fd, k));

function Secret({ name, label, set }: { name: string; label: string; set: boolean }) {
  const t = useT();
  return (
    <Field label={label} hint={set ? t('settings.secretSet') : undefined}>
      <TextInput name={name} type="password" autoComplete="off" placeholder={set ? SECRET_MASK : ''} defaultValue="" />
    </Field>
  );
}

export function SettingsView({ settings: s, storage }: { settings: Settings; storage: Storage | null }) {
  const t = useT();
  const tz = s.providers.torznab;
  const rt = s.providers.rutracker;
  const usedPct =
    storage && storage.limit_bytes > 0 ? Math.min(100, (storage.used_bytes / storage.limit_bytes) * 100) : 0;
  return (
    <>
      <SectionForm
        id="providers"
        title={t('settings.providers')}
        build={fd => ({
          providers: {
            rutracker: {
              cookie: str(fd, 'rt_cookie'),
              music_forums_regex: rt?.music_forums_regex ?? null,
              password: str(fd, 'rt_password'),
              proxy: nz(fd, 'rt_proxy'),
              username: nz(fd, 'rt_username'),
            },
            torznab: nz(fd, 'tz_url') ? { api_key: str(fd, 'tz_key'), url: str(fd, 'tz_url').trim() } : (null as never),
            tpb_enabled: fd.get('tpb_enabled') === 'on',
          },
        })}
      >
        <div className="flex items-center gap-4">
          <Check name="tpb_enabled" label="The Pirate Bay" defaultChecked={s.providers.tpb_enabled} />
          <ProviderTest provider="tpb" label="The Pirate Bay" />
        </div>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold">Torznab (Jackett / Prowlarr)</legend>
          <Field label="URL">
            <TextInput
              name="tz_url"
              defaultValue={tz?.url ?? ''}
              placeholder="http://localhost:9117/api/v2.0/indexers/all/results/torznab"
            />
          </Field>
          <Secret name="tz_key" label={t('settings.apiKey')} set={Boolean(tz?.api_key)} />
          <ProviderTest provider="torznab" label="Torznab" />
        </fieldset>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold">RuTracker</legend>
          <Field label={t('settings.login')}>
            <TextInput name="rt_username" defaultValue={rt?.username ?? ''} autoComplete="off" />
          </Field>
          <Secret name="rt_password" label={t('settings.password')} set={Boolean(rt?.password)} />
          <Secret name="rt_cookie" label={t('settings.cookie')} set={Boolean(rt?.cookie)} />
          <Field label={t('settings.proxy')} hint={t('settings.proxyHint')}>
            <TextInput name="rt_proxy" defaultValue={rt?.proxy ?? ''} />
          </Field>
          <ProviderTest provider="rutracker" label="RuTracker" />
        </fieldset>
      </SectionForm>

      <SectionForm
        id="search"
        title={t('settings.search')}
        build={fd => ({
          matching: { accept: num(fd, 'accept'), confirm: num(fd, 'confirm') },
          search: {
            format_prefs: fd.getAll('format_prefs').map(String),
            max_candidates: num(fd, 'max_candidates'),
            skip_secondary_types: fd.getAll('skip_types').map(String),
          },
        })}
        askReimport={fd => {
          const before = new Set(s.search.skip_secondary_types);
          // Вопрос нужен, только если какой-то ранее пропускавшийся тип включили.
          const after = new Set(fd.getAll('skip_types').map(String));
          return [...before].some(type => !after.has(type));
        }}
      >
        <Field label={t('settings.maxCandidates')}>
          <TextInput name="max_candidates" type="number" min={1} max={30} defaultValue={s.search.max_candidates} />
        </Field>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">{t('settings.formatOrder')}</span>
          <FormatOrder initial={s.search.format_prefs} />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">{t('settings.skipTypes')}</span>
          <ReleaseTypes skipped={s.search.skip_secondary_types} />
          <span className="text-muted text-xs">{t('settings.skipTypesHint')}</span>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('settings.accept')} hint="0…1">
            <TextInput name="accept" type="number" step="0.01" min={0} max={1} defaultValue={s.matching.accept} />
          </Field>
          <Field label={t('settings.confirm')} hint={t('settings.confirmHint')}>
            <TextInput name="confirm" type="number" step="0.01" min={0} max={1} defaultValue={s.matching.confirm} />
          </Field>
        </div>
      </SectionForm>

      <SectionForm
        id="playback"
        title={t('settings.playback')}
        build={fd => ({
          playback: {
            prefetch_next: fd.get('prefetch_next') === 'on',
            transcode_alac: fd.get('transcode_alac') === 'on',
            transcode_lossy_codec: str(fd, 'codec') as 'opus' | 'mp3',
          },
        })}
      >
        <Check name="prefetch_next" label={t('settings.prefetch')} defaultChecked={s.playback.prefetch_next} />
        <Check name="transcode_alac" label={t('settings.transcodeAlac')} defaultChecked={s.playback.transcode_alac} />
        <Field label={t('settings.codec')} hint={t('settings.codecHint')}>
          <select
            name="codec"
            defaultValue={s.playback.transcode_lossy_codec}
            className="border-divider dark:border-divider-dark rounded-lg border bg-transparent px-3 py-2 text-sm"
          >
            <option value="opus">{t('settings.codec.opus')}</option>
            <option value="mp3">{t('settings.codec.mp3')}</option>
          </select>
        </Field>
      </SectionForm>

      <SectionForm
        id="storage"
        title={t('settings.storage')}
        build={fd => ({
          storage: {
            cache_limit_gb: num(fd, 'cache_limit_gb'),
            seed_ratio: nz(fd, 'seed_ratio') === null ? null : num(fd, 'seed_ratio'),
            seeding: fd.get('seeding') === 'on',
          },
        })}
      >
        {storage ? (
          <div data-testid="storage-usage" className="flex flex-col gap-1 text-sm">
            <div className="bg-card dark:bg-card-dark h-2 overflow-hidden rounded-full">
              <div className="bg-accent h-full" style={{ width: `${usedPct}%` }} />
            </div>
            <span className="text-muted text-xs">
              {t('settings.storageUsage', {
                files: storage.files,
                limit: formatSize(storage.limit_bytes, t),
                used: formatSize(storage.used_bytes, t),
              })}
            </span>
          </div>
        ) : (
          <p className="text-muted text-xs">{t('settings.storageUnavailable')}</p>
        )}
        <Field label={t('settings.cacheLimit')} hint={t('settings.cacheLimitHint')}>
          <TextInput name="cache_limit_gb" type="number" min={1} defaultValue={s.storage.cache_limit_gb} />
        </Field>
        <Check name="seeding" label={t('settings.seeding')} defaultChecked={s.storage.seeding} />
        <p className="text-muted -mt-2 text-xs">{t('settings.seedingNote')}</p>
        <Field label={t('settings.seedRatio')} hint={t('settings.seedRatioHint')}>
          <TextInput name="seed_ratio" type="number" step="0.1" min={0.1} defaultValue={s.storage.seed_ratio ?? ''} />
        </Field>
      </SectionForm>

      <section data-testid="settings-downloads" aria-labelledby="s-downloads" className="mb-10 max-w-2xl">
        <h2 id="s-downloads" className="mb-2 text-xl font-semibold">
          {t('settings.downloads')}
        </h2>
        <p className="text-muted mb-4 text-sm">{t('settings.downloadsHint')}</p>
        <Link
          href="/settings/downloads"
          className="border-divider hover:bg-card dark:border-divider-dark dark:hover:bg-card-dark inline-flex items-center rounded-full border px-5 py-2 text-sm font-semibold transition-colors"
        >
          {t('settings.downloadsOpen')}
        </Link>
      </section>
    </>
  );
}
