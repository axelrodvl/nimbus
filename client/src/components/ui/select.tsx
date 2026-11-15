import * as Ariakit from '@ariakit/react';
import { Check, ChevronDown } from 'lucide-react';
import { controlBase } from '@/components/ui/control';
import { useFieldControl } from '@/components/ui/field';
import { cn } from '@/lib/utils';

export type SelectOption = { value: string; label: string; lang?: string };

type Props = {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  disabled?: boolean;
  'aria-label'?: string;
  className?: string;
  'data-testid'?: string;
};

/** Выпадающий список (Ariakit Select). Список — в портале с слоем выше диалогов; на узком экране кнопка — во всю ширину. */
export function Select({ value, onValueChange, options, disabled, className, ...rest }: Props) {
  const field = useFieldControl();
  const current = options.find(o => o.value === value);
  return (
    <Ariakit.SelectProvider setValue={v => onValueChange(String(v))} value={value}>
      <Ariakit.Select
        className={cn(controlBase, 'flex w-full items-center justify-between gap-2 text-left sm:min-w-48', className)}
        disabled={disabled}
        {...field}
        {...rest}
      >
        <span className="truncate" lang={current?.lang}>
          {current?.label ?? value}
        </span>
        <ChevronDown aria-hidden className="text-muted size-4 shrink-0" />
      </Ariakit.Select>
      <Ariakit.SelectPopover
        className="border-divider dark:border-divider-dark z-[90] max-h-[min(18rem,var(--popover-available-height,18rem))] overflow-y-auto overscroll-contain rounded-xl border bg-white p-1 text-sm shadow-xl outline-none dark:bg-black"
        gutter={6}
        portal
        sameWidth
      >
        {options.map(o => (
          <Ariakit.SelectItem
            className="data-active-item:bg-card dark:data-active-item:bg-card-dark flex min-h-10 cursor-pointer items-center justify-between gap-2 rounded-lg px-3 pointer-coarse:min-h-11"
            key={o.value}
            lang={o.lang}
            value={o.value}
          >
            <span className="truncate">{o.label}</span>
            {o.value === value ? <Check aria-hidden className="text-accent-fg size-4 shrink-0" /> : null}
          </Ariakit.SelectItem>
        ))}
      </Ariakit.SelectPopover>
    </Ariakit.SelectProvider>
  );
}
