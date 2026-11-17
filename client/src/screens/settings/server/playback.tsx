import { SettingsSection } from '@/components/ui/settings-section';
import { useT } from '@/lib/i18n/provider';
import { SelectRow, SwitchRow } from '../rows';
import { ServerSectionFrame } from '../section-frame';
import type { SectionProps } from './types';

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
