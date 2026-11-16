import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { retryFailedJob } from '@/lib/acquisition/actions';
import { useFailedJobs } from '@/lib/acquisition/hooks';
import { jobKindKey, jobTarget } from '@/lib/acquisition/model';
import type { JobInfo } from '@/lib/api/acquisition';
import { apiErrorMessage } from '@/lib/api/error-message';
import { useT } from '@/lib/i18n/provider';
import { PageHeader } from './section-frame';

function JobRow({ job }: { job: JobInfo }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const target = jobTarget(job.payload);
  const kind = jobKindKey(job.kind);
  async function retry() {
    setPending(true);
    try {
      await retryFailedJob(job.id, { queryClient });
      toast.success(t('acq.job.retried'));
    } catch (e) {
      toast.error(apiErrorMessage(e, t));
    } finally {
      setPending(false);
    }
  }
  return (
    <li
      className="border-divider/70 dark:border-divider-dark/70 flex items-center gap-3 border-b py-3 last:border-b-0"
      data-testid={`job-${job.id}`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm font-semibold">
          {kind ? t(kind) : job.kind}
          {target ? (
            <>
              {' · '}
              <Link className="text-accent-fg underline underline-offset-2" to={target.to}>
                {t(target.label, { id: target.id })}
              </Link>
            </>
          ) : null}
        </p>
        {job.last_error ? <p className="text-danger-fg text-xs break-words">{job.last_error}</p> : null}
        <p className="text-muted text-xs">{t('acq.job.attempts', { attempts: job.attempts, max: job.max_attempts })}</p>
      </div>
      <Button data-testid="job-retry" onClick={() => void retry()} pending={pending} size="sm" variant="secondary">
        {t('common.retry')}
      </Button>
    </li>
  );
}

function FailedJobs() {
  const t = useT();
  const query = useFailedJobs();
  if (query.isPending) return <Skeleton className="h-24 w-full rounded-xl" />;
  if (query.isError && !query.data) {
    return (
      <ErrorState body={apiErrorMessage(query.error, t)} title={t('common.loadFailed')}>
        <Button onClick={() => void query.refetch()} variant="secondary">
          {t('common.retry')}
        </Button>
      </ErrorState>
    );
  }
  const jobs = query.data?.jobs ?? [];
  if (jobs.length === 0) return <EmptyState body={t('acq.emptyHint.jobs')} title={t('acq.empty.jobs')} />;
  return (
    <ul className="bg-card dark:bg-card-dark rounded-2xl px-4 sm:px-5" data-testid="jobs-list">
      {jobs.map(job => (
        <JobRow job={job} key={job.id} />
      ))}
    </ul>
  );
}

/**
 * Раздел настроек «Фоновые задачи»: упавшие задачи сервера — вид, к чему относятся, ошибка, число попыток;
 * «Повторить» возвращает задачу в очередь. Нужна связь с сервером.
 */
export function JobsSection() {
  const t = useT();
  return (
    <div className="flex flex-col gap-4" data-testid="settings-jobs">
      <PageHeader description={t('settings.jobsHint')} title={t('settings.jobs')} />
      <FailedJobs />
    </div>
  );
}
