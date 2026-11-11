'use client';

import { useState, useTransition } from 'react';
import { testProvider } from '@/app/actions/settings';
import { Button } from '@/components/ui/button';
import { useT } from '@/providers/i18n-provider';

export function ProviderTest({ provider, label }: { provider: 'tpb' | 'rutracker' | 'torznab'; label: string }) {
  const t = useT();
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center gap-3">
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        aria-label={t('settings.testLabel', { name: label })}
        onClick={() =>
          start(async () => {
            const r = await testProvider(provider);
            setResult(r.ok ? { message: r.message, success: r.success } : { message: r.message, success: false });
          })
        }
      >
        {pending ? t('settings.testing') : t('settings.test')}
      </Button>
      {result ? (
        <span
          data-testid={`test-${provider}`}
          className={result.success ? 'text-success text-xs' : 'text-danger text-xs'}
          role="status"
        >
          {result.message}
        </span>
      ) : null}
    </div>
  );
}
