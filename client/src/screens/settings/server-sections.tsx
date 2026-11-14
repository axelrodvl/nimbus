import { Link } from 'react-router';
import * as Ariakit from '@ariakit/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog } from '@/components/ui/dialog';
import { ProgressBar } from '@/components/ui/progress-bar';
import { SettingsRow, SettingsSection } from '@/components/ui/settings-section';
import { SortableList } from '@/components/ui/sortable-list';
import { apiErrorMessage } from '@/lib/api/error-message';
import { useT } from '@/lib/i18n/provider';
import { formatSize } from '@/lib/sources/format';
import { reimportArtists, testProvider, type ProviderName } from '@/lib/api/settings';
import { useStorage } from '@/lib/settings/hooks';
import { getAt, isPresent, patchAt } from '@/lib/settings/paths';
import {
  FORMAT_KEYS,
  PERFORMANCE_FIELDS,
  PUBLIC_MB_BASE,
  RELEASE_TYPES,
  type ServerSettings,
} from '@/lib/settings/types';
import { NumberRow, SecretRow, SelectRow, SliderRow, SwitchRow, TextRow } from './rows';
import { useSection } from './section-context';
import { ServerSectionFrame } from './section-frame';

type SectionProps = { settings: ServerSettings; readOnly: boolean };

/** Строка проверки провайдера: пробный поиск на сервере и результат меткой. */
function ProviderTest({ provider, enabled }: { provider: ProviderName; enabled: boolean }) {
  const t = useT();
  const { readOnly } = useSection();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  async function run() {
    setPending(true);
    setResult(null);
    try {
      const r = await testProvider(provider);
      setResult({ ok: r.ok, text: r.message });
    } catch (e) {
      setResult({ ok: false, text: apiErrorMessage(e, t) });
    } finally {
      setPending(false);
    }
  }
  return (
    <SettingsRow description={t('settings.connectionHint')} group label={t('settings.connection')}>
      <div className="flex min-w-0 items-center gap-3">
        {result ? (
          <Badge data-testid={`test-result-${provider}`} role="status" tone={result.ok ? 'success' : 'danger'}>
            {result.text}
          </Badge>
        ) : null}
        <Button
          aria-label={t('settings.testLabel', { name: provider })}
          disabled={!enabled || readOnly}
          onClick={() => void run()}
          pending={pending}
          variant="secondary"
        >
          {pending ? t('settings.testing') : t('settings.test')}
        </Button>
      </div>
    </SettingsRow>
  );
}

export function SourcesSection({ settings, readOnly }: SectionProps) {
  const t = useT();
  const p = settings.providers ?? {};
  return (
    <ServerSectionFrame
      description={t('settings.providersHint')}
      id="sources"
      readOnly={readOnly}
      settings={settings}
      title={t('settings.providers')}
    >
      <SettingsSection title="The Pirate Bay">
        <SwitchRow description={t('settings.tpbHint')} label={t('settings.enabled')} path="providers.tpb_enabled" />
        <ProviderTest enabled={p.tpb_enabled === true} provider="tpb" />
      </SettingsSection>
      <SettingsSection title="Torznab">
        <TextRow description={t('settings.torznabUrlHint')} label="URL" path="providers.torznab.url" required />
        <SecretRow label={t('settings.apiKey')} path="providers.torznab.api_key" />
        <ProviderTest enabled={Boolean(p.torznab?.url)} provider="torznab" />
      </SettingsSection>
      <SettingsSection title="RuTracker">
        <TextRow label={t('settings.login')} path="providers.rutracker.username" />
        <SecretRow label={t('settings.password')} path="providers.rutracker.password" />
        <SecretRow label={t('settings.cookie')} path="providers.rutracker.cookie" />
        <TextRow description={t('settings.proxyHint')} label={t('settings.proxy')} path="providers.rutracker.proxy" />
        <ProviderTest enabled={p.rutracker != null} provider="rutracker" />
      </SettingsSection>
    </ServerSectionFrame>
  );
}

const FORMAT_LABELS: Record<string, string> = {
  aac: 'AAC',
  alac: 'ALAC',
  ape_wv: 'APE / WavPack',
  flac: 'FLAC',
  mp3_320: 'MP3 320',
  mp3_v0: 'MP3 V0',
};

function FormatOrder() {
  const t = useT();
  const { settings, save, readOnly, errors } = useSection();
  if (!isPresent(settings, 'search.format_prefs')) return null;
  const prefs = (getAt(settings, 'search.format_prefs') as string[]) ?? [...FORMAT_KEYS];
  const label = (k: string) => (k === 'mp3_other' ? t('format.mp3_other') : (FORMAT_LABELS[k] ?? k));
  return (
    <SettingsRow
      description={t('settings.formatOrderHint')}
      error={errors['search.format_prefs']}
      group
      label={t('settings.formatOrder')}
    >
      <div className="w-full sm:w-72">
        <SortableList
          aria-label={t('settings.formatOrder')}
          data-testid="format-order"
          disabled={readOnly}
          items={prefs.map(k => ({ id: k, label: label(k) }))}
          onReorder={ids => void save(patchAt('search.format_prefs', ids))}
        />
      </div>
    </SettingsRow>
  );
}

/** Типы релизов: включённый тип импортируется. Включение ранее пропускавшегося спрашивает про уже добавленных артистов. */
function ReleaseTypes() {
  const t = useT();
  const { settings, save, readOnly, errors } = useSection();
  const dialog = Ariakit.useDialogStore();
  const [pendingNext, setPendingNext] = useState<string[] | null>(null);
  if (!isPresent(settings, 'search.skip_secondary_types')) return null;
  const skipped = (getAt(settings, 'search.skip_secondary_types') as string[]) ?? [];

  function toggle(type: string, on: boolean) {
    const next = on ? skipped.filter(s => s !== type) : [...skipped, type];
    if (on) {
      // Тип был пропускаемым и теперь включается: новые артисты его получат, существующих спросим.
      setPendingNext(next);
      dialog.show();
    } else {
      void save(patchAt('search.skip_secondary_types', next));
    }
  }

  async function apply(reimport: boolean) {
    const next = pendingNext;
    dialog.hide();
    setPendingNext(null);
    if (!next) return;
    if (!(await save(patchAt('search.skip_secondary_types', next)))) return;
    if (!reimport) return;
    try {
      toast.info(t('settings.reimport.started', { count: await reimportArtists() }));
    } catch (e) {
      toast.error(apiErrorMessage(e, t));
    }
  }

  return (
    <SettingsRow
      description={t('settings.skipTypesHint')}
      error={errors['search.skip_secondary_types']}
      group
      label={t('settings.skipTypes')}
    >
      <div className="flex flex-wrap gap-2 sm:max-w-md sm:justify-end" data-testid="release-types">
        {RELEASE_TYPES.map(type => (
          <Checkbox
            checked={!skipped.includes(type)}
            disabled={readOnly}
            key={type}
            label={type}
            onCheckedChange={on => toggle(type, on)}
          />
        ))}
      </div>
      <Dialog
        description={t('settings.reimport.description')}
        store={dialog}
        title={t('settings.reimport.title')}
        variant="sheet"
        wrapDescription
      >
        <div className="mt-2 flex flex-col gap-2">
          <Button onClick={() => void apply(true)}>{t('settings.reimport.all')}</Button>
          <Button onClick={() => void apply(false)} variant="secondary">
            {t('settings.reimport.newOnly')}
          </Button>
          <Ariakit.DialogDismiss render={<Button variant="ghost" />}>{t('common.cancel')}</Ariakit.DialogDismiss>
        </div>
      </Dialog>
    </SettingsRow>
  );
}

export function SearchSection({ settings, readOnly }: SectionProps) {
  const t = useT();
  return (
    <ServerSectionFrame
      description={t('settings.searchHint')}
      id="search"
      readOnly={readOnly}
      settings={settings}
      title={t('settings.search')}
    >
      <SettingsSection title={t('settings.searchGroup')}>
        <NumberRow
          description={t('settings.maxCandidatesHint')}
          label={t('settings.maxCandidates')}
          max={30}
          min={1}
          path="search.max_candidates"
        />
        <FormatOrder />
        <ReleaseTypes />
        <SwitchRow description={t('settings.autoRetryHint')} label={t('settings.autoRetry')} path="search.auto_retry" />
      </SettingsSection>
      <SettingsSection title={t('settings.matchingGroup')}>
        <SliderRow
          description={t('settings.acceptHint')}
          label={t('settings.accept')}
          max={1}
          min={0}
          path="matching.accept"
          step={0.01}
        />
        <SliderRow
          description={t('settings.confirmHint')}
          label={t('settings.confirm')}
          max={1}
          min={0}
          path="matching.confirm"
          step={0.01}
        />
      </SettingsSection>
    </ServerSectionFrame>
  );
}

function ResetMusicbrainz() {
  const t = useT();
  const { settings, save, readOnly } = useSection();
  const isPublic = getAt(settings, 'musicbrainz.base_url') === PUBLIC_MB_BASE;
  return (
    <SettingsRow description={t('settings.mb.resetHint')} label={t('settings.mb.reset')}>
      <Button
        disabled={readOnly || isPublic}
        onClick={() =>
          void save({ musicbrainz: { base_url: PUBLIC_MB_BASE, burst: 3, max_concurrent: 2, rate_per_sec: 1 } })
        }
        variant="secondary"
      >
        {t('settings.mb.resetAction')}
      </Button>
    </SettingsRow>
  );
}

export function MusicbrainzSection({ settings, readOnly }: SectionProps) {
  const t = useT();
  return (
    <ServerSectionFrame
      description={t('settings.mbHint')}
      id="musicbrainz"
      readOnly={readOnly}
      settings={settings}
      title={t('settings.mb')}
    >
      <SettingsSection>
        <TextRow
          description={t('settings.mb.baseUrlHint')}
          label={t('settings.mb.baseUrl')}
          path="musicbrainz.base_url"
          required
        />
        <NumberRow
          description={t('settings.mb.rateHint')}
          label={t('settings.mb.rate')}
          max={100}
          min={0}
          path="musicbrainz.rate_per_sec"
          step={0.1}
          unit={t('settings.unit.perSec')}
        />
        <NumberRow
          description={t('settings.mb.burstHint')}
          label={t('settings.mb.burst')}
          max={20}
          min={1}
          path="musicbrainz.burst"
        />
        <NumberRow
          description={t('settings.mb.concurrencyHint')}
          label={t('settings.mb.concurrency')}
          max={32}
          min={1}
          path="musicbrainz.max_concurrent"
        />
        {isPresent(settings, 'musicbrainz.base_url') ? <ResetMusicbrainz /> : null}
      </SettingsSection>
    </ServerSectionFrame>
  );
}

export function PlaybackSection({ settings, readOnly }: SectionProps) {
  const t = useT();
  return (
    <ServerSectionFrame
      description={t('settings.playbackHint')}
      id="playback"
      readOnly={readOnly}
      settings={settings}
      title={t('settings.playback')}
    >
      <SettingsSection>
        <SwitchRow
          description={t('settings.prefetchHint')}
          label={t('settings.prefetch')}
          path="playback.prefetch_next"
        />
        <SwitchRow label={t('settings.transcodeAlac')} path="playback.transcode_alac" />
        <SelectRow
          description={t('settings.codecHint')}
          label={t('settings.codec')}
          options={[
            { label: t('settings.codec.opus'), value: 'opus' },
            { label: t('settings.codec.mp3'), value: 'mp3' },
          ]}
          path="playback.transcode_lossy_codec"
        />
      </SettingsSection>
    </ServerSectionFrame>
  );
}

/** Заполненность хранилища: использовано / лимит / закреплено; предупреждение, если закреплённое не помещается. */
function StorageUsage() {
  const t = useT();
  const { data, isError, isPending } = useStorage();
  if (isPending) return <div aria-hidden className="bg-divider dark:bg-divider-dark h-12 animate-pulse rounded-xl" />;
  if (isError || !data) return <p className="text-muted text-sm">{t('settings.storageUnavailable')}</p>;
  return (
    <div className="flex flex-col gap-2" data-testid="storage-usage">
      <ProgressBar
        aria-label={t('settings.storage')}
        max={data.limit_bytes}
        tone={data.over_limit ? 'danger' : data.used_bytes / Math.max(1, data.limit_bytes) > 0.9 ? 'warning' : 'accent'}
        value={data.used_bytes}
      />
      <p className="text-muted text-xs">
        {t('settings.storageUsage', {
          files: data.files,
          limit: formatSize(data.limit_bytes, t),
          used: formatSize(data.used_bytes, t),
        })}
      </p>
      <p className="text-muted text-xs">
        {t('settings.pinned', { files: data.pinned_files, size: formatSize(data.pinned_bytes, t) })}
      </p>
      <Link
        className="text-accent text-sm hover:underline"
        data-testid="storage-downloaded-link"
        to="/downloads/downloaded"
      >
        {t('settings.storageDownloaded')}
      </Link>
      {data.over_limit ? (
        <p className="text-danger text-sm" role="alert">
          {t('settings.overLimit')}
        </p>
      ) : null}
    </div>
  );
}

export function StorageSection({ settings, readOnly }: SectionProps) {
  const t = useT();
  return (
    <ServerSectionFrame
      description={t('settings.storageHint')}
      id="storage"
      readOnly={readOnly}
      settings={settings}
      title={t('settings.storageServer')}
    >
      <SettingsSection>
        <div className="py-3.5">
          <StorageUsage />
        </div>
        <NumberRow
          description={t('settings.cacheLimitHint')}
          label={t('settings.cacheLimit')}
          max={1_000_000}
          min={1}
          path="storage.cache_limit_gb"
        />
        <SwitchRow description={t('settings.seedingNote')} label={t('settings.seeding')} path="storage.seeding" />
        <NumberRow
          description={t('settings.seedRatioNote')}
          label={t('settings.seedRatio')}
          max={100}
          min={0.1}
          path="storage.seed_ratio"
          step={0.1}
        />
        <SwitchRow
          description={t('settings.autoDownloadHint')}
          label={t('settings.autoDownload')}
          path="storage.auto_download"
        />
      </SettingsSection>
    </ServerSectionFrame>
  );
}

const PERF_LABELS = {
  discover_workers: 'settings.perf.discover',
  download_concurrency: 'settings.perf.download',
  import_workers: 'settings.perf.import',
  metadata_concurrency: 'settings.perf.metadata',
  metadata_timeout_secs: 'settings.perf.timeout',
  verify_workers: 'settings.perf.verify',
} as const;

function DefaultButton({ path, def }: { path: string; def: number }) {
  const t = useT();
  const { settings, save, readOnly } = useSection();
  if (getAt(settings, path) === def) return null;
  return (
    <Button disabled={readOnly} onClick={() => void save(patchAt(path, def))} size="sm" variant="ghost">
      {t('settings.default')}
    </Button>
  );
}

export function PerformanceSection({ settings, readOnly }: SectionProps) {
  const t = useT();
  return (
    <ServerSectionFrame
      description={t('settings.perfHint')}
      id="performance"
      readOnly={readOnly}
      settings={settings}
      title={t('settings.perf')}
    >
      {settings.restart_required ? (
        <p className="text-warning text-sm" data-testid="restart-required" role="status">
          {t('settings.restartRequired')}
        </p>
      ) : null}
      <SettingsSection>
        {PERFORMANCE_FIELDS.map(f => {
          const path = `performance.${f.key}`;
          return (
            <NumberRow
              description={t('settings.range', { def: f.def, max: f.max, min: f.min })}
              extra={<DefaultButton def={f.def} path={path} />}
              key={f.key}
              label={t(PERF_LABELS[f.key])}
              max={f.max}
              min={f.min}
              path={path}
              unit={f.key === 'metadata_timeout_secs' ? t('settings.unit.sec') : undefined}
            />
          );
        })}
      </SettingsSection>
    </ServerSectionFrame>
  );
}
