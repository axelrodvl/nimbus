import * as Ariakit from '@ariakit/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select } from '@/components/ui/select';
import { SettingsRow, SettingsSection } from '@/components/ui/settings-section';
import { SyncStatus } from '@/components/sync-status';
import { resetLocalData } from '@/components/crash-screen';
import { session } from '@/lib/auth';
import { LOCALES, isLocale } from '@/lib/i18n/config';
import { useLocale, useT } from '@/lib/i18n/provider';
import { setLocale } from '@/lib/i18n/store';
import { fetchServerVersion } from '@/lib/api/settings';
import { needsIosInstallHint, promptInstall, useCanInstall } from '@/lib/pwa/install';
import { readStorageInfo, type StorageInfo } from '@/lib/pwa/storage';
import { useOfflineSupported } from '@/lib/offline/hooks';
import { useTheme, type Theme } from '@/lib/theme/theme';
import { version as clientVersion } from '../../../package.json';
import { PageHeader } from './section-frame';

/** Внешний вид: тема и язык. Хранятся на устройстве, работают офлайн. */
export function AppearanceSection() {
  const t = useT();
  const locale = useLocale();
  const { setTheme, theme } = useTheme();
  return (
    <div className="flex flex-col gap-4" data-testid="settings-appearance">
      <PageHeader description={t('settings.appearanceHint')} title={t('settings.appearance')} />
      <SettingsSection>
        <SettingsRow description={t('settings.themeHint')} group label={t('settings.theme')}>
          <SegmentedControl<Theme>
            aria-label={t('settings.theme')}
            onValueChange={setTheme}
            options={[
              { label: t('settings.theme.light'), value: 'light' },
              { label: t('settings.theme.dark'), value: 'dark' },
              { label: t('settings.theme.system'), value: 'system' },
            ]}
            value={theme}
          />
        </SettingsRow>
        <SettingsRow description={t('settings.languageHint')} label={t('language.label')}>
          <Select
            data-testid="language-select"
            onValueChange={v => {
              if (isLocale(v)) void setLocale(v);
            }}
            options={LOCALES.map(l => ({ label: l.name, lang: l.code, value: l.code }))}
            value={locale}
          />
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}

/** «Локальные данные: N МБ, хранилище постоянное: да/нет». */
function useStorageInfo(): StorageInfo | null {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  useEffect(() => {
    let alive = true;
    void readStorageInfo().then(v => alive && setInfo(v));
    return () => {
      alive = false;
    };
  }, []);
  return info;
}

/** О приложении: версии, синхронизация, сброс локальных данных, выход. */
export function AboutSection() {
  const t = useT();
  const resetDialog = Ariakit.useDialogStore();
  const storage = useStorageInfo();
  const canInstall = useCanInstall();
  const iosHint = needsIosInstallHint();
  const offlineSupported = useOfflineSupported();
  const server = useQuery({
    queryFn: ({ signal }) => fetchServerVersion(signal),
    queryKey: ['health', 'version'],
    staleTime: 60_000,
  });
  return (
    <div className="flex flex-col gap-4" data-testid="settings-about">
      <PageHeader title={t('settings.about')} />
      <SettingsSection>
        <SettingsRow group label={t('settings.about.client')}>
          <span className="text-sm tabular-nums" data-testid="client-version">
            {clientVersion}
          </span>
        </SettingsRow>
        <SettingsRow group label={t('settings.about.server')}>
          <span className="text-sm tabular-nums" data-testid="server-version">
            {server.data ? server.data : server.isError ? '—' : t('common.loading')}
          </span>
        </SettingsRow>
        <SettingsRow group label={t('settings.about.sync')}>
          <SyncStatus className="text-sm" />
        </SettingsRow>
        {storage?.usage != null ? (
          <SettingsRow group label={t('settings.about.storage')}>
            <span className="text-sm" data-testid="storage-info">
              {t('settings.about.storageValue', {
                persistent: t(storage.persistent ? 'common.yes' : 'common.no'),
                size: Math.max(0.1, Math.round(storage.usage / 1e5) / 10),
              })}
            </span>
          </SettingsRow>
        ) : null}
        {offlineSupported ? null : (
          <SettingsRow group label={t('settings.offline')}>
            <span className="text-muted text-xs" data-testid="offline-unsupported">
              {t('offline.unsupported')}
            </span>
          </SettingsRow>
        )}
        {canInstall ? (
          <SettingsRow description={t('settings.about.installHint')} group label={t('settings.about.install')}>
            <Button data-testid="install-app" onClick={() => void promptInstall()} variant="secondary">
              {t('settings.about.install')}
            </Button>
          </SettingsRow>
        ) : null}
        {iosHint ? (
          <SettingsRow group label={t('settings.about.install')}>
            <span className="text-muted text-xs" data-testid="ios-install-hint">
              {t('pwa.iosHint')}
            </span>
          </SettingsRow>
        ) : null}
        <SettingsRow description={t('settings.about.resetHint')} group label={t('shell.resetData')}>
          <Button onClick={resetDialog.show} variant="secondary">
            {t('settings.about.resetAction')}
          </Button>
        </SettingsRow>
        <SettingsRow description={t('settings.about.logoutHint')} group label={t('login.logout')}>
          <Button onClick={() => void session.logout()} variant="secondary">
            {t('login.logout')}
          </Button>
        </SettingsRow>
      </SettingsSection>
      <ConfirmDialog
        confirmAction={async () => {
          await resetLocalData();
          return true;
        }}
        confirmLabel={t('settings.about.resetAction')}
        description={t('settings.about.resetConfirm')}
        store={resetDialog}
        title={t('shell.resetData')}
        variant="primary"
      />
    </div>
  );
}
