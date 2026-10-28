import { Cart } from '@/components/Cart';

export default function Home() {
  return (
    <main>
      <h1>Shop</h1>
      <Cart items={[{ price: 2, qty: 3 }]} />
    </main>
  );
}
