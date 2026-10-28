import { test, expect } from 'vitest';
import { total } from './price';

test('total multiplies price by quantity and sums items', () => {
  expect(total([{ price: 2, qty: 3 }, { price: 5, qty: 1 }])).toBe(11);
});
