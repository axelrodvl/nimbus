import * as Ariakit from '@ariakit/react';
import { useQuery } from '@tanstack/react-query';
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

/** О приложении: версии, синхронизация, сброс локальных данных, выход. */
export function AboutSection() {
  const t = useT();
  const resetDialog = Ariakit.useDialogStore();
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
          <span className="font-mono text-sm" data-testid="client-version">
            {clientVersion}
          </span>
        </SettingsRow>
        <SettingsRow group label={t('settings.about.server')}>
          <span className="font-mono text-sm" data-testid="server-version">
            {server.data ? server.data : server.isError ? '—' : t('common.loading')}
          </span>
        </SettingsRow>
        <SettingsRow group label={t('settings.about.sync')}>
          <SyncStatus />
        </SettingsRow>
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
