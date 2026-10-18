import type { BrowserContext, Page } from '@playwright/test';
import { createTestAccount, expect, test, watchPage, type TestAccount } from './fixtures.js';

// Browser sessions end to end, against the built app and a real database (spec FR-002 to FR-005f). Each
// test signs in as its own account, so a test that logs out never ends another test's session.

async function signInViaUi(page: Page, account: TestAccount): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username').fill(account.username);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

async function sessionCookie(context: BrowserContext) {
  const cookie = (await context.cookies()).find((c) => c.name === 'scrylux_session');
  if (!cookie) throw new Error('no session cookie');
  return cookie;
}

test('the session cookie is HttpOnly and path-scoped, and no credential is readable by scripts', async ({
  page,
  context,
  baseURL,
}) => {
  const urls: string[] = [];
  page.on('framenavigated', (frame) => urls.push(frame.url()));
  await signInViaUi(page, await createTestAccount(baseURL ?? ''));

  const cookie = await sessionCookie(context);
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe('Strict');
  expect(cookie.path).toBe('/api/session');

  const stored = await page.evaluate(() => ({
    local: localStorage.length,
    session: sessionStorage.length,
    cookies: document.cookie,
  }));
  expect(stored).toEqual({ local: 0, session: 0, cookies: '' });
  // No URL the page visited carries a token (a JWT starts with "eyJ").
  expect(urls.filter((url) => url.includes('eyJ'))).toEqual([]);
});

test('stays signed in across a reload', async ({ page, baseURL }) => {
  const account = await createTestAccount(baseURL ?? '');
  await signInViaUi(page, account);

  await page.reload();

  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await expect(page.getByText(account.username)).toBeVisible();
});

test('stays signed in after the browser is closed and reopened', async ({ browser, baseURL }) => {
  const account = await createTestAccount(baseURL ?? '');
  const first = await browser.newContext();
  const firstPage = await first.newPage();
  const firstWatch = await watchPage(firstPage, new URL(baseURL ?? '').origin);
  await signInViaUi(firstPage, account);
  const state = await first.storageState();
  // The first context is closed before the second opens. Two live cookie jars holding one credential
  // is the stolen-cookie case, and would correctly trip reuse detection.
  await first.close();
  firstWatch.assertClean();

  const second = await browser.newContext({ storageState: state });
  const secondPage = await second.newPage();
  const secondWatch = await watchPage(secondPage, new URL(baseURL ?? '').origin);
  await secondPage.goto('/projects');

  await expect(secondPage.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await expect(secondPage.getByText(account.username)).toBeVisible();
  secondWatch.assertClean();
  await second.close();
});

test('logging out returns to sign-in and makes the old credential useless', async ({ page, context, request, baseURL }) => {
  await signInViaUi(page, await createTestAccount(baseURL ?? ''));
  const before = await sessionCookie(context);

  await page.getByRole('button', { name: 'Log out' }).click();

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page.getByText(/session has ended/)).toHaveCount(0);
  // The replay carries the Origin and JSON headers, so it reaches the session check instead of 403 or 415.
  const replay = await request.post('/api/session/refresh', {
    headers: { Origin: new URL(baseURL ?? '').origin, 'Content-Type': 'application/json', Cookie: `scrylux_session=${before.value}` },
    data: {},
  });
  expect(replay.status()).toBe(401);
});

test('signing out everywhere ends the session on another device, with two independent sign-ins', async ({
  browser,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? '').origin;
  const account = await createTestAccount(baseURL ?? '');
  const laptop = await browser.newContext();
  const phone = await browser.newContext();
  const laptopPage = await laptop.newPage();
  const phonePage = await phone.newPage();
  const watches = [await watchPage(laptopPage, origin), await watchPage(phonePage, origin)];
  await signInViaUi(laptopPage, account);
  await signInViaUi(phonePage, account);

  await laptopPage.getByRole('button', { name: 'Sign out everywhere' }).click();
  await laptopPage.getByRole('dialog').getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(laptopPage).toHaveURL(/\/login$/);

  // A fresh load of the other device finds no session. That is "not signed in", so no ended message.
  await phonePage.reload();
  await expect(phonePage).toHaveURL(/\/login$/);
  await expect(phonePage.getByLabel('Username')).toBeVisible();

  for (const watch of watches) watch.assertClean();
  await laptop.close();
  await phone.close();
});

test('a session ended on another device shows the ended message on the next action', async ({ browser, baseURL }) => {
  const origin = new URL(baseURL ?? '').origin;
  const account = await createTestAccount(baseURL ?? '');
  const laptop = await browser.newContext();
  const phone = await browser.newContext();
  const laptopPage = await laptop.newPage();
  const phonePage = await phone.newPage();
  const watches = [await watchPage(laptopPage, origin), await watchPage(phonePage, origin)];
  await signInViaUi(laptopPage, account);
  await signInViaUi(phonePage, account);
  await expect(phonePage.getByRole('button', { name: 'New project' })).toBeVisible();

  await laptopPage.getByRole('button', { name: 'Sign out everywhere' }).click();
  await laptopPage.getByRole('dialog').getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(laptopPage).toHaveURL(/\/login$/);

  // The phone's page is still open and signed in as far as it knows. Its next action reaches the API,
  // is refused, cannot be renewed, and ends up on the sign-in page with the reason.
  await phonePage.getByRole('button', { name: 'New project' }).click();
  await phonePage.getByLabel('Name').fill(`m6-ended-${Date.now()}`);
  await phonePage.getByRole('button', { name: 'Create project' }).click();

  await expect(phonePage).toHaveURL(/\/login$/);
  await expect(phonePage.getByText("Your session has ended. Anything you hadn't saved was not kept.")).toBeVisible();

  for (const watch of watches) watch.assertClean();
  await laptop.close();
  await phone.close();
});

test('a deep link opened while signed out returns there after signing in', async ({ page, baseURL }) => {
  const account = await createTestAccount(baseURL ?? '');
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/login$/);
  expect(new URL(page.url()).search).toBe('');

  await page.getByLabel('Username').fill(account.username);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
});

test('shows one generic message for a wrong password, and keeps the username', async ({ page, baseURL }) => {
  const account = await createTestAccount(baseURL ?? '');
  await page.goto('/login');
  await page.getByLabel('Username').fill(account.username);
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('alert')).toHaveText('Invalid username or password.');
  await expect(page.getByLabel('Username')).toHaveValue(account.username);
  await expect(page.getByLabel('Password')).toHaveValue('');
});
