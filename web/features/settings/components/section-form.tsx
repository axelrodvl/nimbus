'use client';

import { useActionState, useEffect, type ReactNode } from 'react';
import { toast } from 'sonner';
import { saveSettings, type ActionResult, type SettingsPatch } from '@/app/actions/settings';
import { Button } from '@/components/ui/button';
import type { Settings } from '@/features/settings/types';
import { useT } from '@/providers/i18n-provider';

type State = ActionResult<{ settings: Settings }> | null;

// Раздел настроек: форма с собственной Server Function; `build` превращает поля формы в частичный патч.
export function SectionForm({
  id,
  title,
  children,
  build,
}: {
  id: string;
  title: string;
  children: ReactNode;
  build: (fd: FormData) => SettingsPatch;
}) {
  const t = useT();
  const [state, action, pending] = useActionState<State, FormData>(async (_prev, fd) => saveSettings(build(fd)), null);
  useEffect(() => {
    if (!state) return;
    if (state.ok) toast.success(t('settings.saved', { title }));
    else toast.error(state.message);
  }, [state, title, t]);
  return (
    <section data-testid={`settings-${id}`} aria-labelledby={`s-${id}`} className="mb-10 max-w-2xl">
      <h2 id={`s-${id}`} className="mb-4 text-xl font-semibold">
        {title}
      </h2>
      <form action={action} className="flex flex-col gap-4">
        {children}
        <div>
          <Button type="submit" disabled={pending}>
            {t('settings.save')}
          </Button>
        </div>
      </form>
    </section>
  );
}

const inputClass =
  'border-divider dark:border-divider-dark w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent/40';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint ? <span className="text-muted text-xs">{hint}</span> : null}
    </label>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={inputClass} />;
}

export function Check({ name, label, defaultChecked }: { name: string; label: string; defaultChecked: boolean }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="h-4 w-4" />
      {label}
    </label>
  );
}
