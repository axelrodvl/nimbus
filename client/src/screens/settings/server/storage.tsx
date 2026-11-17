import { Link } from 'react-router';
import { ProgressBar } from '@/components/ui/progress-bar';
import { SettingsSection } from '@/components/ui/settings-section';
import { useT } from '@/lib/i18n/provider';
import { formatSize } from '@/lib/sources/format';
import { useStorage } from '@/lib/settings/hooks';
import { NumberRow, SwitchRow } from '../rows';
import { ServerSectionFrame } from '../section-frame';
import type { SectionProps } from './types';

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
        className="text-accent-fg text-sm hover:underline"
        data-testid="storage-downloaded-link"
        to="/downloads/downloaded"
      >
        {t('settings.storageDownloaded')}
      </Link>
      {data.over_limit ? (
        <p className="text-danger-fg text-sm" role="alert">
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
