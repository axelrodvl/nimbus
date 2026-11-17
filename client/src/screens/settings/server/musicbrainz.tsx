import { Button } from '@/components/ui/button';
import { SettingsRow, SettingsSection } from '@/components/ui/settings-section';
import { useT } from '@/lib/i18n/provider';
import { getAt, isPresent } from '@/lib/settings/paths';
import { PUBLIC_MB_BASE } from '@/lib/settings/types';
import { NumberRow, TextRow } from '../rows';
import { useSection } from '../section-context';
import { ServerSectionFrame } from '../section-frame';
import type { SectionProps } from './types';

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
