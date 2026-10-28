// QA AI OS: the smoke test. Tagged @smoke, so it runs on every push
// (npm run test:smoke) and on a schedule against production.
import { test, expect } from '@playwright/test';

test('home page loads with no errors @smoke', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  const response = await page.goto('/');
  expect(response, 'no response from /').not.toBeNull();
  expect(response!.status(), 'status of /').toBeLessThan(400);
  await expect(page.locator('body')).not.toBeEmpty();
  expect(errors, 'errors in the browser console').toEqual([]);
});
