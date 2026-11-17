import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SettingsRow, SettingsSection } from '@/components/ui/settings-section';
import { apiErrorMessage } from '@/lib/api/error-message';
import { useT } from '@/lib/i18n/provider';
import { testProvider, type ProviderName } from '@/lib/api/settings';
import { SecretRow, SwitchRow, TextAreaRow, TextRow } from '../rows';
import { useSection } from '../section-context';
import { ServerSectionFrame } from '../section-frame';
import type { SectionProps } from './types';

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
        <SecretRow
          description={t('settings.cookieHint')}
          label={t('settings.cookie')}
          path="providers.rutracker.cookie"
        />
        <TextRow
          description={t('settings.userAgentHint')}
          label={t('settings.userAgent')}
          path="providers.rutracker.user_agent"
        />
        <TextAreaRow
          description={t('settings.extraHeadersHint')}
          label={t('settings.extraHeaders')}
          path="providers.rutracker.headers"
          placeholder="Accept-Language: ru,en;q=0.9"
        />
        <TextRow description={t('settings.proxyHint')} label={t('settings.proxy')} path="providers.rutracker.proxy" />
        <ProviderTest enabled={p.rutracker != null} provider="rutracker" />
      </SettingsSection>
    </ServerSectionFrame>
  );
}
