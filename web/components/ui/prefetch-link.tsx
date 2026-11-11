'use client';

import { FastLink } from '@/components/ui/fast-link';
import type { Route } from 'next';
import type Link from 'next/link';

type Props<T extends string = string> = Omit<React.ComponentProps<typeof Link>, 'href' | 'prefetch'> & {
  href: Route<T> | URL;
};

export function PrefetchLink<T extends string>({ href, ...props }: Props<T>) {
  return <FastLink {...props} href={href as Route} prefetch />;
}
