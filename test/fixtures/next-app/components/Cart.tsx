'use client';

import { useState } from 'react';
import { total, type Item } from '@/lib/price';

export function Cart({ items }: { items: Item[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <button onClick={() => setOpen(!open)}>{open ? 'Hide total' : 'Show total'}</button>
      {open && <p>Total: ${total(items)}</p>}
    </section>
  );
}
