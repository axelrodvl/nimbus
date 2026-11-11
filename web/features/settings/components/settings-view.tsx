'use client';

import { FormatOrder } from '@/features/settings/components/format-order';
import { ProviderTest } from '@/features/settings/components/provider-test';
import { Check, Field, SectionForm, TextInput } from '@/features/settings/components/section-form';
import { SECRET_MASK, type Settings, type Storage } from '@/features/settings/types';
import { formatSize } from '@/features/sources/format';

const str = (fd: FormData, k: string) => String(fd.get(k) ?? '');
/** Пустая строка → null (сброс необязательного поля). */
const nz = (fd: FormData, k: string) => str(fd, k).trim() || null;
const num = (fd: FormData, k: string) => Number(str(fd, k));

function Secret({ name, label, set }: { name: string; label: string; set: boolean }) {
  return (
    <Field label={label} hint={set ? 'Сохранён. Оставьте пустым, чтобы не менять.' : undefined}>
      <TextInput name={name} type="password" autoComplete="off" placeholder={set ? SECRET_MASK : ''} defaultValue="" />
    </Field>
  );
}

export function SettingsView({ settings: s, storage }: { settings: Settings; storage: Storage | null }) {
  const tz = s.providers.torznab;
  const rt = s.providers.rutracker;
  const usedPct =
    storage && storage.limit_bytes > 0 ? Math.min(100, (storage.used_bytes / storage.limit_bytes) * 100) : 0;
  return (
    <>
      <SectionForm
        id="providers"
        title="Источники"
        build={fd => ({
          providers: {
            rutracker: {
              cookie: str(fd, 'rt_cookie'),
              music_forums_regex: rt?.music_forums_regex ?? null,
              password: str(fd, 'rt_password'),
              proxy: nz(fd, 'rt_proxy'),
              username: nz(fd, 'rt_username'),
            },
            torznab: nz(fd, 'tz_url') ? { api_key: str(fd, 'tz_key'), url: str(fd, 'tz_url').trim() } : (null as never),
            tpb_enabled: fd.get('tpb_enabled') === 'on',
          },
        })}
      >
        <div className="flex items-center gap-4">
          <Check name="tpb_enabled" label="The Pirate Bay" defaultChecked={s.providers.tpb_enabled} />
          <ProviderTest provider="tpb" label="The Pirate Bay" />
        </div>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold">Torznab (Jackett / Prowlarr)</legend>
          <Field label="URL">
            <TextInput
              name="tz_url"
              defaultValue={tz?.url ?? ''}
              placeholder="http://localhost:9117/api/v2.0/indexers/all/results/torznab"
            />
          </Field>
          <Secret name="tz_key" label="API-ключ" set={Boolean(tz?.api_key)} />
          <ProviderTest provider="torznab" label="Torznab" />
        </fieldset>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold">RuTracker</legend>
          <Field label="Логин">
            <TextInput name="rt_username" defaultValue={rt?.username ?? ''} autoComplete="off" />
          </Field>
          <Secret name="rt_password" label="Пароль" set={Boolean(rt?.password)} />
          <Secret name="rt_cookie" label="Cookie (bb_session=…)" set={Boolean(rt?.cookie)} />
          <Field label="Прокси" hint="Например socks5://127.0.0.1:1080">
            <TextInput name="rt_proxy" defaultValue={rt?.proxy ?? ''} />
          </Field>
          <ProviderTest provider="rutracker" label="RuTracker" />
        </fieldset>
      </SectionForm>

      <SectionForm
        id="search"
        title="Поиск и сопоставление"
        build={fd => ({
          matching: { accept: num(fd, 'accept'), confirm: num(fd, 'confirm') },
          search: {
            format_prefs: fd.getAll('format_prefs').map(String),
            max_candidates: num(fd, 'max_candidates'),
            skip_secondary_types: str(fd, 'skip_types')
              .split(',')
              .map(t => t.trim())
              .filter(Boolean),
          },
        })}
      >
        <Field label="Сколько раздач проверять на альбом">
          <TextInput name="max_candidates" type="number" min={1} max={30} defaultValue={s.search.max_candidates} />
        </Field>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">Порядок предпочтения форматов</span>
          <FormatOrder initial={s.search.format_prefs} />
        </div>
        <Field label="Пропускать типы релизов" hint="Через запятую: Compilation, Live, Remix, DJ-mix, Demo">
          <TextInput name="skip_types" defaultValue={s.search.skip_secondary_types.join(', ')} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Порог уверенного совпадения" hint="0…1">
            <TextInput name="accept" type="number" step="0.01" min={0} max={1} defaultValue={s.matching.accept} />
          </Field>
          <Field label="Порог «проверьте»" hint="0…1, не больше уверенного">
            <TextInput name="confirm" type="number" step="0.01" min={0} max={1} defaultValue={s.matching.confirm} />
          </Field>
        </div>
      </SectionForm>

      <SectionForm
        id="playback"
        title="Воспроизведение"
        build={fd => ({
          playback: {
            prefetch_next: fd.get('prefetch_next') === 'on',
            transcode_alac: fd.get('transcode_alac') === 'on',
            transcode_lossy_codec: str(fd, 'codec') as 'opus' | 'mp3',
          },
        })}
      >
        <Check
          name="prefetch_next"
          label="Заранее загружать следующий трек очереди"
          defaultChecked={s.playback.prefetch_next}
        />
        <Check
          name="transcode_alac"
          label="Перекодировать ALAC (пока не применяется)"
          defaultChecked={s.playback.transcode_alac}
        />
        <Field
          label="Кодек для lossy-источников при перекодировании"
          hint="Пока не применяется: перекодирование всегда в FLAC."
        >
          <select
            name="codec"
            defaultValue={s.playback.transcode_lossy_codec}
            className="border-divider dark:border-divider-dark rounded-lg border bg-transparent px-3 py-2 text-sm"
          >
            <option value="opus">Opus</option>
            <option value="mp3">MP3</option>
          </select>
        </Field>
      </SectionForm>

      <SectionForm
        id="storage"
        title="Хранилище"
        build={fd => ({
          storage: {
            cache_limit_gb: num(fd, 'cache_limit_gb'),
            seed_ratio: nz(fd, 'seed_ratio') === null ? null : num(fd, 'seed_ratio'),
            seeding: fd.get('seeding') === 'on',
          },
        })}
      >
        {storage ? (
          <div data-testid="storage-usage" className="flex flex-col gap-1 text-sm">
            <div className="bg-card dark:bg-card-dark h-2 overflow-hidden rounded-full">
              <div className="bg-accent h-full" style={{ width: `${usedPct}%` }} />
            </div>
            <span className="text-muted text-xs">
              Занято {formatSize(storage.used_bytes)} из {formatSize(storage.limit_bytes)} · файлов: {storage.files}
            </span>
          </div>
        ) : (
          <p className="text-muted text-xs">Данные о хранилище недоступны.</p>
        )}
        <Field label="Лимит кэша, ГБ" hint="Давно не игравшие файлы удаляются, когда кэш больше лимита.">
          <TextInput name="cache_limit_gb" type="number" min={1} defaultValue={s.storage.cache_limit_gb} />
        </Field>
        <Check name="seeding" label="Раздавать скачанное (seeding)" defaultChecked={s.storage.seeding} />
        <p className="text-muted -mt-2 text-xs">
          Раздача означает распространение файлов; для RuTracker повышает рейтинг.
        </p>
        <Field
          label="Остановить раздачу при рейтинге"
          hint="Пусто — раздавать без ограничения. Пока хранится, но движок его не применяет."
        >
          <TextInput name="seed_ratio" type="number" step="0.1" min={0.1} defaultValue={s.storage.seed_ratio ?? ''} />
        </Field>
      </SectionForm>
    </>
  );
}
