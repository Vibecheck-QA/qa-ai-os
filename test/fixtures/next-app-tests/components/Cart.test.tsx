import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Cart } from './Cart';

test('shows the total only after the button is pressed', async () => {
  render(<Cart items={[{ price: 2, qty: 3 }]} />);
  expect(screen.queryByText(/Total:/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Show total' }));
  expect(screen.getByText('Total: $6')).toBeInTheDocument();
});

// Fails if the previous test's render leaked: its button would still be on screen.
test('each test starts with a clean screen', () => {
  render(<Cart items={[]} />);
  expect(screen.getAllByRole('button')).toHaveLength(1);
});
