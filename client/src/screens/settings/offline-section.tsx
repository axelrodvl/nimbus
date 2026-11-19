import * as Ariakit from '@ariakit/react';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { NumberInput } from '@/components/ui/number-input';
import { ProgressBar } from '@/components/ui/progress-bar';
import { SettingsRow, SettingsSection } from '@/components/ui/settings-section';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/lib/i18n/provider';
import { offline } from '@/lib/offline';
import { useOfflineStatus } from '@/lib/offline/hooks';
import { effectiveLimit } from '@/lib/offline/settings';
import { readStorageInfo, requestPersistNow } from '@/lib/pwa/storage';
import { formatSize } from '@/lib/sources/format';
import { warmStatus } from '@/lib/library/warm-runtime';
import { PageHeader } from './section-frame';

const GIB = 2 ** 30;

/** Есть ли у браузера сведения о типе соединения (Chromium): без них «только Wi-Fi» работать не может. */
export const hasConnectionApi = (): boolean =>
  (globalThis.navigator as { connection?: unknown } | undefined)?.connection !== undefined;

/** Раздел «Офлайн на этом устройстве»: настройки хранятся на устройстве, действуют сразу и работают без сети. */
export function OfflineSection() {
  const t = useT();
  const settings = useStore(offline().settings, s => s);
  const usage = useOfflineStatus(s => s.usage);
  const fileBytes = useOfflineStatus(s => {
    let n = 0;
    for (const f of s.files.values()) n += f.bytesDone;
    return n;
  });
  const fileCount = useOfflineStatus(s => s.files.size);
  const warm = useStore(warmStatus, s => s);
  const deleteAll = Ariakit.useDialogStore();
  const [persistent, setPersistent] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void readStorageInfo().then(info => alive && setPersistent(info.persistent));
    return () => {
      alive = false;
    };
  }, []);

  const limit = effectiveLimit(settings, usage.quota);
  const maxGb = Math.max(2, usage.quota ? Math.floor(usage.quota / GIB) : 50);
  const limitGb = Math.min(maxGb, Math.max(1, Math.round(limit / GIB)));
  const ratio = limit > 0 ? usage.bytes / limit : 0;

  return (
    <div className="flex flex-col gap-4" data-testid="settings-offline">
      <PageHeader description={t('offline.settings.hint')} title={t('settings.offline')} />
      <SettingsSection>
        <SettingsRow description={t('offline.settings.limitHint')} label={t('offline.settings.limit')}>
          <div className="flex w-full flex-col gap-2 sm:w-72">
            <Slider
              aria-label={t('offline.settings.limit')}
              data-testid="offline-limit"
              debounceMs={300}
              format={v => `${v} ${t('unit.GB')}`}
              max={maxGb}
              min={1}
              onCommit={v => offline().settings.update({ limitBytes: v * GIB })}
              step={1}
              value={limitGb}
            />
            <ProgressBar
              aria-label={t('offline.device.usageLabel')}
              max={limit > 0 ? limit : 1}
              tone={ratio >= 1 ? 'danger' : ratio >= 0.9 ? 'warning' : 'accent'}
              value={usage.bytes}
            />
            <span className="text-muted text-xs" data-testid="offline-usage">
              {t('offline.device.usage', { limit: formatSize(limit, t), used: formatSize(usage.bytes, t) })}
            </span>
          </div>
        </SettingsRow>
        <SettingsRow description={t('offline.settings.concurrencyHint')} label={t('offline.settings.concurrency')}>
          <NumberInput
            className="w-36"
            data-testid="offline-concurrency"
            max={6}
            min={1}
            onCommit={v => offline().settings.update({ concurrency: v })}
            value={settings.concurrency}
          />
        </SettingsRow>
        {hasConnectionApi() ? (
          <SettingsRow description={t('offline.settings.wifiHint')} label={t('offline.settings.wifi')}>
            <Switch
              checked={settings.wifiOnly}
              data-testid="offline-wifi"
              onCheckedChange={v => offline().settings.update({ wifiOnly: v })}
            />
          </SettingsRow>
        ) : null}
        <SettingsRow
          description={
            warm.total > 0 && settings.warmThumbs
              ? `${t('offline.settings.warmHint')} ${t('offline.settings.warmProgress', { total: warm.total, warmed: warm.warmed })}`
              : t('offline.settings.warmHint')
          }
          label={t('offline.settings.warm')}
        >
          <Switch
            checked={settings.warmThumbs}
            data-testid="offline-warm"
            onCheckedChange={v => offline().settings.update({ warmThumbs: v })}
          />
        </SettingsRow>
        <SettingsRow description={t('offline.settings.persistentHint')} group label={t('offline.settings.persistent')}>
          <div className="flex items-center gap-3">
            <span className="text-sm" data-testid="offline-persistent">
              {persistent === null ? '—' : t(persistent ? 'common.yes' : 'common.no')}
            </span>
            <Button
              data-testid="offline-persist-request"
              disabled={persistent !== false}
              onClick={() => void requestPersistNow().then(setPersistent)}
              variant="secondary"
            >
              {t('offline.settings.persistentRequest')}
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow description={t('offline.settings.deleteAllHint')} group label={t('offline.settings.deleteAll')}>
          <Button
            data-testid="offline-delete-all"
            disabled={fileCount === 0}
            onClick={deleteAll.show}
            variant="secondary"
          >
            {t('offline.settings.deleteAll')}
          </Button>
        </SettingsRow>
      </SettingsSection>
      <ConfirmDialog
        confirmAction={async () => {
          await offline().manager?.removeAll();
          return true;
        }}
        confirmLabel={t('offline.settings.deleteAll')}
        description={t('offline.settings.deleteAllConfirm', { count: fileCount, size: formatSize(fileBytes, t) })}
        store={deleteAll}
        title={t('offline.settings.deleteAll')}
      />
    </div>
  );
}
