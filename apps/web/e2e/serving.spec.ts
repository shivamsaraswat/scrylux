import { expect, test } from './fixtures.js';

test('serves the app at the root', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Scrylux');
  await expect(page.locator('#root')).not.toBeEmpty();
});

test('reloads into the app on a deep link', async ({ page }) => {
  const response = await page.goto('/projects/6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d');
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle('Scrylux');
});

test('sends the content security policy with the page', async ({ page }) => {
  const response = await page.goto('/');
  const policy = response?.headers()['content-security-policy'] ?? '';
  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain("script-src 'self'");
  expect(policy).toContain("frame-ancestors 'none'");
});
