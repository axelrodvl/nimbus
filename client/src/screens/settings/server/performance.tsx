import { Button } from '@/components/ui/button';
import { SettingsSection } from '@/components/ui/settings-section';
import { useT } from '@/lib/i18n/provider';
import { getAt, patchAt } from '@/lib/settings/paths';
import { PERFORMANCE_FIELDS } from '@/lib/settings/types';
import { NumberRow } from '../rows';
import { useSection } from '../section-context';
import { ServerSectionFrame } from '../section-frame';
import type { SectionProps } from './types';

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
        <p className="text-warning-fg text-sm" data-testid="restart-required" role="status">
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
