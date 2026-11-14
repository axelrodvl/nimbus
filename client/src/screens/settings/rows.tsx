import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
import { PasswordInput } from '@/components/ui/password-input';
import { Select, type SelectOption } from '@/components/ui/select';
import { SettingsRow } from '@/components/ui/settings-section';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { TextInput } from '@/components/ui/text-input';
import { useT } from '@/lib/i18n/provider';
import { getAt, isPresent, patchAt } from '@/lib/settings/paths';
import { SECRET_MASK } from '@/lib/settings/types';
import { useSection } from './section-context';

type Base = { path: string; label: string; description?: string };

/** Строка-переключатель: сохраняется сразу одним патчем с этим полем. */
export function SwitchRow({ path, label, description }: Base) {
  const { settings, save, errors, readOnly } = useSection();
  if (!isPresent(settings, path)) return null;
  return (
    <SettingsRow description={description} error={errors[path]} label={label}>
      <Switch
        checked={getAt(settings, path) === true}
        disabled={readOnly}
        onCheckedChange={v => void save(patchAt(path, v))}
      />
    </SettingsRow>
  );
}

type NumberProps = Base & {
  min: number;
  max: number;
  step?: number;
  unit?: string;
  /** Пустое значение допустимо и означает `null` (например, «без ограничения»). */
  nullable?: boolean;
  extra?: ReactNode;
};

/** Числовая строка: сохраняется по `blur`/Enter. */
export function NumberRow({ path, label, description, min, max, step, unit, extra }: NumberProps) {
  const { settings, save, errors, readOnly } = useSection();
  if (!isPresent(settings, path)) return null;
  const value = getAt(settings, path);
  return (
    <SettingsRow description={description} error={errors[path]} label={label}>
      <div className="flex items-center gap-2">
        {extra}
        <NumberInput
          className="w-36"
          disabled={readOnly}
          max={max}
          min={min}
          onCommit={v => void save(patchAt(path, v))}
          step={step}
          unit={unit}
          value={typeof value === 'number' ? value : min}
        />
      </div>
    </SettingsRow>
  );
}

/** Строка со ползунком: один запрос после серии движений. */
export function SliderRow({
  path,
  label,
  description,
  min,
  max,
  step,
}: Base & { min: number; max: number; step: number }) {
  const { settings, save, errors, readOnly } = useSection();
  if (!isPresent(settings, path)) return null;
  const value = getAt(settings, path);
  return (
    <SettingsRow description={description} error={errors[path]} label={label}>
      <Slider
        disabled={readOnly}
        max={max}
        min={min}
        onCommit={v => void save(patchAt(path, v))}
        step={step}
        value={typeof value === 'number' ? value : min}
      />
    </SettingsRow>
  );
}

/** Строка с выпадающим списком: сохраняется сразу. */
export function SelectRow({ path, label, description, options }: Base & { options: readonly SelectOption[] }) {
  const { settings, save, errors, readOnly } = useSection();
  if (!isPresent(settings, path)) return null;
  return (
    <SettingsRow description={description} error={errors[path]} label={label}>
      <Select
        disabled={readOnly}
        onValueChange={v => void save(patchAt(path, v))}
        options={options}
        value={String(getAt(settings, path) ?? '')}
      />
    </SettingsRow>
  );
}

type TextProps = Base & {
  placeholder?: string;
  /** Пустое значение уходит как `null` (по умолчанию); у обязательных строк — как пустая строка. */
  required?: boolean;
};

/** Текстовая строка: сохраняется по `blur`/Enter; пустое значение уходит как `null`. */
export function TextRow({ path, label, description, placeholder, required }: TextProps) {
  const { settings, save, errors, readOnly } = useSection();
  const [draft, setDraft] = useState<string | null>(null);
  if (!isPresent(settings, path)) return null;
  const current = (getAt(settings, path) as string | null | undefined) ?? '';
  const commit = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (next !== current) void save(patchAt(path, next === '' && !required ? null : next));
  };
  return (
    <SettingsRow description={description} error={errors[path]} label={label}>
      <TextInput
        className="w-full sm:w-72"
        disabled={readOnly}
        onBlur={commit}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') commit();
        }}
        placeholder={placeholder}
        value={draft ?? current}
      />
    </SettingsRow>
  );
}

/**
 * Секретная строка. Сервер отдаёт заданный секрет маской, и маска никогда не уходит обратно: поле хранит только
 * то, что ввёл пользователь, пустое — «не менять». Сохранение — кнопкой в строке, чтобы не отправить недописанное.
 */
export function SecretRow({ path, label, description }: Base) {
  const t = useT();
  const { settings, save, errors, readOnly } = useSection();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  if (!isPresent(settings, path)) return null;
  const secretSet = getAt(settings, path) === SECRET_MASK;
  async function submit() {
    if (draft === '' || draft === SECRET_MASK) return;
    setPending(true);
    const ok = await save(patchAt(path, draft));
    setPending(false);
    if (ok) setDraft('');
  }
  return (
    <SettingsRow
      description={description ?? (secretSet ? t('settings.secretSet') : undefined)}
      error={errors[path]}
      label={label}
    >
      <div className="flex w-full items-center gap-2 sm:w-80">
        <PasswordInput
          className="flex-1"
          disabled={readOnly}
          onKeyDown={e => {
            if (e.key === 'Enter') void submit();
          }}
          onValueChange={setDraft}
          secretSet={secretSet}
          value={draft}
        />
        <Button disabled={readOnly || draft === ''} onClick={() => void submit()} pending={pending} size="sm">
          {t('settings.save')}
        </Button>
      </div>
    </SettingsRow>
  );
}
