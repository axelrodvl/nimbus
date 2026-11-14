import { Monitor, Moon, Sun } from 'lucide-react';
import { useT } from '@/lib/i18n/provider';
import { useTheme, type Theme } from '@/lib/theme/theme';
import { cn } from '@/lib/utils';

type Props = { variant?: 'pill' | 'inline' };

export function ThemeToggle({ variant = 'pill' }: Props) {
  const { setTheme, theme } = useTheme();
  const t = useT();

  const wrapperClass =
    variant === 'inline'
      ? 'inline-flex items-center gap-0.5'
      : 'border-divider dark:border-divider-dark inline-flex items-center rounded-full border p-0.5';

  const option = (value: Theme, label: string, icon: React.ReactNode) => (
    <ToggleButton active={theme === value} label={label} onClick={() => setTheme(value)}>
      {icon}
    </ToggleButton>
  );

  return (
    <div className={wrapperClass}>
      {option('light', t('theme.light'), <Sun className="size-4" />)}
      {option('dark', t('theme.dark'), <Moon className="size-4" />)}
      {option('system', t('theme.system'), <Monitor className="size-4" />)}
    </div>
  );
}

function ToggleButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'focus-visible:ring-accent/40 rounded-full p-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none',
        active
          ? 'bg-card dark:bg-card-dark text-black dark:text-white'
          : 'text-gray hover:text-black dark:hover:text-white',
      )}
    >
      {children}
    </button>
  );
}
