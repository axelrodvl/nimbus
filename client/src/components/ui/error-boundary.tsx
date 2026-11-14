import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { useT } from '@/lib/i18n/provider';

type Props = {
  children: ReactNode;
  title?: string;
  body?: string;
  compact?: boolean;
  /** Свой экран ошибки вместо `ErrorState` с кнопкой повтора. */
  fallback?: ReactNode;
};
type State = { error: Error | null };

function Fallback({ body, compact, onRetry, title }: Omit<Props, 'children'> & { onRetry: () => void }) {
  const t = useT();
  return (
    <ErrorState body={body} compact={compact} title={title}>
      <Button onClick={onRetry} size="sm" variant="secondary">
        {t('common.retry')}
      </Button>
    </ErrorState>
  );
}

/** Граница ошибок рендера: показывает `ErrorState` с кнопкой повтора вместо падения всего дерева. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Единственный канал диагностики: в консоль браузера, с компонентным стеком.
    // eslint-disable-next-line no-console
    console.error(error, info.componentStack);
  }

  render() {
    if (this.state.error === null) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    const { children: _children, fallback: _fallback, ...rest } = this.props;
    return <Fallback {...rest} onRetry={() => this.setState({ error: null })} />;
  }
}
