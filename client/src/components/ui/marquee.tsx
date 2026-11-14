import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Single-line text that scrolls back and forth when it doesn't fit.
 * Falls back to plain ellipsis truncation while it fits or when the user prefers reduced motion.
 */
export function Marquee({
  children,
  className,
  'data-testid': testId,
}: {
  children: ReactNode;
  className?: string;
  'data-testid'?: string;
}) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const inner = innerRef.current;
    if (!box || !inner) return;
    const measure = () => setOverflow(Math.max(0, Math.ceil(inner.scrollWidth - box.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [children]);

  const scrolling = overflow > 1;
  // ~40px/s plus pauses at both ends
  const duration = Math.max(4, overflow / 40 + 3);

  return (
    <span
      ref={boxRef}
      data-testid={testId}
      className={cn('block min-w-0 overflow-hidden whitespace-nowrap', !scrolling && 'text-ellipsis', className)}
    >
      <span
        ref={innerRef}
        className={cn('inline-block', scrolling && 'marquee-run')}
        style={
          scrolling
            ? ({ '--marquee-dist': `-${overflow}px`, animationDuration: `${duration}s` } as React.CSSProperties)
            : undefined
        }
      >
        {children}
      </span>
    </span>
  );
}
