import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { canvasOf, dragBy, nodeOf, positionOnDiagram, stored, untilStill } from './diagram-helpers.js';
import { apiRequest, apiToken, expect, seedElements, seedModel, signInAsNewAccount, test } from './fixtures.js';

// Never lose work (US4, spec FR-019, FR-020, FR-020b, FR-020d, SC-003, SC-005): a change that cannot be
// saved stays on screen and can be retried, a refused one is undone with its reason, and a session that
// ends in the middle of editing can be signed in again over the page.

test.use({ viewport: { width: 1400, height: 1100 } });

const BATCH = '**/api/v1/threat-models/*/elements/batch';

async function open(page: Page, base: string) {
  const token = await apiToken(base);
  const { modelId, projectId } = await seedModel(base, token, 'saving');
  const process = randomUUID();
  await seedElements(base, token, modelId, [{ op: 'create', element: { id: process, type: 'process', name: 'Worker', layout: { x: 0, y: 0 } } }]);
  const account = await signInAsNewAccount(page, base);
  await page.goto(`/threat-models/${modelId}/diagram`);
  await untilStill(nodeOf(page, 'Worker'));
  await canvasOf(page).scrollIntoViewIfNeeded();
  return { token, modelId, projectId, process, account };
}

const saved = (page: Page) => page.getByText('All changes saved');

test('shows "All changes saved" within two seconds of a change (SC-003)', async ({ page, baseURL }) => {
  const base = baseURL ?? '';
  await open(page, base);
  await expect(saved(page)).toBeVisible();

  await dragBy(page, nodeOf(page, 'Worker'), 120, 60);

  // It goes through "Saving…" and ends at "All changes saved", well inside the budget.
  await expect(saved(page)).toBeVisible({ timeout: 2000 });
});

test('keeps a change that could not be saved, warns before leaving, and saves it on retry', async ({ page, baseURL }) => {
  const base = baseURL ?? '';
  const { token, modelId } = await open(page, base);
  const before = await positionOnDiagram(nodeOf(page, 'Worker'));

  await page.route(BATCH, (route) => route.abort('failed'));
  await dragBy(page, nodeOf(page, 'Worker'), 140, 80);

  // Not saved, with a way to retry; the change stays where the user put it.
  await expect(page.getByRole('alert')).toContainText('Not saved');
  const moved = await positionOnDiagram(nodeOf(page, 'Worker'));
  expect(moved.x).toBeGreaterThan(before.x + 40);
  expect((await stored(base, token, modelId)).byName.get('Worker')?.layout).toEqual({ x: 0, y: 0 });

  // Leaving the threat model asks first; staying keeps everything.
  await page.getByRole('link', { name: 'Scrylux' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading')).toHaveText('Leave without saving?');
  await dialog.getByRole('button', { name: 'Stay' }).click();
  await expect(page).toHaveURL(new RegExp(`/threat-models/${modelId}/diagram$`));
  expect(await positionOnDiagram(nodeOf(page, 'Worker'))).toEqual(moved);

  // Back online, Retry saves it, and a reload shows it where it was put.
  await page.unroute(BATCH);
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(saved(page)).toBeVisible();
  await expect.poll(async () => (await stored(base, token, modelId)).byName.get('Worker')?.layout).toEqual(moved);
  await page.reload();
  await untilStill(nodeOf(page, 'Worker'));
  expect(await positionOnDiagram(nodeOf(page, 'Worker'))).toEqual(moved);
});

test('undoes a change the server refuses, and says why', async ({ page, baseURL }) => {
  const base = baseURL ?? '';
  const { token, modelId } = await open(page, base);
  const before = await positionOnDiagram(nodeOf(page, 'Worker'));

  let refused = 0;
  await page.route(BATCH, (route) => {
    refused += 1;
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Operation 0: layout: Too big' }) });
  });
  // The server's refusal puts the node back where it was, so the drag worked if the save was sent, not if the
  // node stayed at its target.
  await dragBy(page, nodeOf(page, 'Worker'), 140, 80, () => expect.poll(() => refused, { timeout: 2000 }).toBeGreaterThan(0));

  await expect(page.getByRole('alert')).toContainText('That change was not saved: Operation 0: layout: Too big');
  await expect(saved(page)).toBeVisible();
  await expect.poll(async () => positionOnDiagram(nodeOf(page, 'Worker'))).toEqual(before);
  expect((await stored(base, token, modelId)).byName.get('Worker')?.layout).toEqual({ x: 0, y: 0 });
});

test('stops, and lets go, when the threat model was deleted elsewhere', async ({ page, baseURL }) => {
  const base = baseURL ?? '';
  const { token, modelId } = await open(page, base);
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/elements/batch')) requests.push(request.url());
  });

  expect((await apiRequest(base, token, 'DELETE', `/api/v1/threat-models/${modelId}`)).status).toBe(204);
  await dragBy(page, nodeOf(page, 'Worker'), 140, 80);

  await expect(page.getByRole('alert')).toContainText('This threat model no longer exists.');
  // Another move changes nothing: nothing more is sent.
  const count = requests.length;
  await dragBy(page, nodeOf(page, 'Worker'), -60, -30);
  await page.waitForTimeout(500);
  expect(requests.length).toBe(count);

  // Nothing is left to lose, so leaving is not blocked.
  // The way back goes to the model's project, by name (contracts/ui.md).
  await page.getByRole('link', { name: /^Back to m-p2-/ }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test.describe('a session that ends in the middle of editing', () => {
  // The same account signs in on another device and signs out everywhere, which ends this page's session.
  async function endSessionElsewhere(page: Page, account: { username: string; password: string }) {
    const other = await page.context().browser()!.newContext();
    const there = await other.newPage();
    await there.goto('/login');
    await there.getByLabel('Username').fill(account.username);
    await there.getByLabel('Password').fill(account.password);
    await there.getByRole('button', { name: 'Sign in' }).click();
    await expect(there).toHaveURL(/\/projects$/);
    await there.getByRole('button', { name: 'Sign out everywhere' }).click();
    await there.getByRole('dialog').getByRole('button', { name: 'Sign out everywhere' }).click();
    await expect(there).toHaveURL(/\/login$/);
    await other.close();
  }

  test('signs in again over the page, as the same account, and saves the change', async ({ page, baseURL }) => {
    const base = baseURL ?? '';
    const { token, modelId, account } = await open(page, base);

    await page.route(BATCH, (route) => route.abort('failed'));
    await dragBy(page, nodeOf(page, 'Worker'), 140, 80);
    await expect(page.getByRole('alert')).toContainText('Not saved');
    const moved = await positionOnDiagram(nodeOf(page, 'Worker'));
    await endSessionElsewhere(page, account);
    await page.unroute(BATCH);

    await page.getByRole('button', { name: 'Retry' }).click();

    // The page stays, with the change on it; a prompt asks for the password of this account only.
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading')).toHaveText('Your session ended');
    await expect(dialog).toContainText('Sign in again to save your 1 change.');
    await expect(dialog.getByLabel('Username')).toHaveValue(account.username);
    await expect(page).toHaveURL(new RegExp(`/threat-models/${modelId}/diagram$`));
    expect(await positionOnDiagram(nodeOf(page, 'Worker'))).toEqual(moved);

    await dialog.getByLabel('Password').fill(account.password);
    await dialog.getByRole('button', { name: 'Sign in and save' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(saved(page)).toBeVisible();
    await expect.poll(async () => (await stored(base, token, modelId)).byName.get('Worker')?.layout).toEqual(moved);

    await page.reload();
    await untilStill(nodeOf(page, 'Worker'));
    expect(await positionOnDiagram(nodeOf(page, 'Worker'))).toEqual(moved);
  });

  test('can be discarded instead, which signs out and says what was lost', async ({ page, baseURL }) => {
    const base = baseURL ?? '';
    const { token, modelId, account } = await open(page, base);

    await page.route(BATCH, (route) => route.abort('failed'));
    await dragBy(page, nodeOf(page, 'Worker'), 140, 80);
    await expect(page.getByRole('alert')).toContainText('Not saved');
    await endSessionElsewhere(page, account);
    await page.unroute(BATCH);
    await page.getByRole('button', { name: 'Retry' }).click();

    await page.getByRole('dialog').getByRole('button', { name: 'Discard changes and sign out' }).click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('Your session ended before 1 diagram change was saved. It was not saved.')).toBeVisible();
    expect((await stored(base, token, modelId)).byName.get('Worker')?.layout).toEqual({ x: 0, y: 0 });
  });
});
