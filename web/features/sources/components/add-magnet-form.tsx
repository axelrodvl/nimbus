'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { addMagnet } from '@/app/actions/sources';
import { Button } from '@/components/ui/button';

export function AddMagnetForm({ albumId }: { albumId: number }) {
  const [magnet, setMagnet] = useState('');
  const [pending, start] = useTransition();
  return (
    <form
      className="flex w-full max-w-xl gap-2"
      onSubmit={e => {
        e.preventDefault();
        start(async () => {
          const r = await addMagnet(albumId, magnet.trim());
          if (r.ok) {
            toast.success('Раздача добавлена, проверяем');
            setMagnet('');
          } else toast.error(r.message);
        });
      }}
    >
      <input
        value={magnet}
        onChange={e => setMagnet(e.target.value)}
        placeholder="magnet:?xt=urn:btih:…"
        aria-label="Magnet-ссылка"
        className="border-divider dark:border-divider-dark focus:ring-accent/40 min-w-0 flex-1 rounded-full border bg-transparent px-4 py-2 text-sm outline-none focus:ring-2"
      />
      <Button type="submit" disabled={pending || !magnet.trim()}>
        Добавить magnet
      </Button>
    </form>
  );
}
