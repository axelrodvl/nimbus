import * as Ariakit from '@ariakit/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog } from '@/components/ui/dialog';
import { SettingsRow, SettingsSection } from '@/components/ui/settings-section';
import { SortableList } from '@/components/ui/sortable-list';
import { apiErrorMessage } from '@/lib/api/error-message';
import { useT } from '@/lib/i18n/provider';
import { reimportArtists } from '@/lib/api/settings';
import { getAt, isPresent, patchAt } from '@/lib/settings/paths';
import { FORMAT_KEYS, RELEASE_TYPES } from '@/lib/settings/types';
import { NumberRow, SliderRow, SwitchRow } from '../rows';
import { useSection } from '../section-context';
import { ServerSectionFrame } from '../section-frame';
import type { SectionProps } from './types';

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
