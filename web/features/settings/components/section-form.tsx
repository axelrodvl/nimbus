'use client';

import * as Ariakit from '@ariakit/react';
import { startTransition, useActionState, useEffect, useRef, type ReactNode } from 'react';
import { toast } from 'sonner';
import { reimportArtists, saveSettings, type ActionResult, type SettingsPatch } from '@/app/actions/settings';
import { Button } from '@/components/ui/button';
import type { Settings } from '@/features/settings/types';
import { useT } from '@/providers/i18n-provider';

const REIMPORT_FIELD = '__reimport';

type State = ActionResult<{ settings: Settings }> | null;

// Раздел настроек: форма с собственной Server Function; `build` превращает поля формы в частичный патч.
export function SectionForm({
  id,
  title,
  children,
  build,
  askReimport,
}: {
  id: string;
  title: string;
  children: ReactNode;
  build: (fd: FormData) => SettingsPatch;
  /** Если вернёт true, перед сохранением спросим, применять ли изменения к уже добавленным артистам. */
  askReimport?: (fd: FormData) => boolean;
}) {
  const t = useT();
  const dialog = Ariakit.useDialogStore();
  const pendingData = useRef<FormData | null>(null);
  const [state, action, pending] = useActionState<State, FormData>(async (_prev, fd) => {
    const res = await saveSettings(build(fd));
    if (res.ok && fd.get(REIMPORT_FIELD) === '1') {
      const r = await reimportArtists();
      if (r.ok) toast.info(t('settings.reimport.started', { count: r.queued }));
      else toast.error(r.message);
    }
    return res;
  }, null);
  const submitWith = (reimport: boolean) => {
    const fd = pendingData.current;
    if (!fd) return;
    fd.set(REIMPORT_FIELD, reimport ? '1' : '0');
    dialog.hide();
    startTransition(() => action(fd));
  };
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
      <form
        action={action}
        onSubmit={e => {
          if (!askReimport) return;
          const fd = new FormData(e.currentTarget);
          if (!askReimport(fd)) return;
          e.preventDefault();
          pendingData.current = fd;
          dialog.show();
        }}
        className="flex flex-col gap-4"
      >
        {children}
        <div>
          <Button type="submit" disabled={pending}>
            {t('settings.save')}
          </Button>
        </div>
      </form>
      {askReimport ? (
        <Ariakit.Dialog
          store={dialog}
          backdrop={<div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />}
          className="border-divider dark:border-divider-dark fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border bg-white p-6 shadow-2xl outline-none dark:bg-black"
          unmountOnHide
        >
          <Ariakit.DialogHeading className="text-lg font-bold">{t('settings.reimport.title')}</Ariakit.DialogHeading>
          <Ariakit.DialogDescription className="text-muted mt-2 text-sm">
            {t('settings.reimport.description')}
          </Ariakit.DialogDescription>
          <div className="mt-6 flex flex-col gap-2">
            <Button type="button" onClick={() => submitWith(true)}>
              {t('settings.reimport.all')}
            </Button>
            <Button type="button" onClick={() => submitWith(false)}>
              {t('settings.reimport.newOnly')}
            </Button>
            <Ariakit.DialogDismiss className="text-muted hover:text-foreground py-2 text-sm">
              {t('common.cancel')}
            </Ariakit.DialogDismiss>
          </div>
        </Ariakit.Dialog>
      ) : null}
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
