import { Dialog, type DialogProps } from '@/components/ui/dialog';

/** Модальная панель: на мобильных выезжает снизу, на широких экранах — окно по центру. */
export function Sheet(props: Omit<DialogProps, 'variant'>) {
  return <Dialog {...props} variant="sheet" />;
}
