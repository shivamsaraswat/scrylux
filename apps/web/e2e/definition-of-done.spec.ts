import type { Locator, Page } from '@playwright/test';
import { createTestAccount, expect, test } from './fixtures.js';

// Phase 1's Definition of Done, in a real browser against the built app and a real database (spec
// FR-025, SC-001): sign in, create a project and a threat model, create, edit and delete a threat and a
// mitigation, and log out. Several steps are driven by keyboard only, with no mouse (FR-020): buttons,
// text fields and dialogs. A native <select> is set with selectOption: how a closed select reacts to
// the arrow keys differs by platform (macOS opens its menu), and that is the browser's, not the app's.
// After each write the page is reloaded, so what is asserted is what the server stored.

// The page is reloaded after each write, to assert what the server stored. A reload that starts while the
// write is still in flight can cancel it, so the reload waits for the network to go quiet first.
async function reloadWhenSaved(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.reload();
}

async function enter(page: Page, control: Locator): Promise<void> {
  await control.focus();
  await page.keyboard.press('Enter');
}

test('walks the whole Definition of Done', async ({ page, baseURL }) => {
  const account = await createTestAccount(baseURL ?? '');
  const stamp = Date.now();
  const projectName = `m6-dod-${stamp}`;
  const renamed = `m6-dod-renamed-${stamp}`;
  const modelName = `Checkout v2 ${stamp}`;

  // 1. Sign in, by keyboard only.
  await page.goto('/login');
  await page.getByLabel('Username').focus();
  await page.keyboard.type(account.username);
  await page.keyboard.press('Tab');
  await page.keyboard.type(account.password);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/projects$/);

  // 2. Create a project, by keyboard only, then rename it.
  await enter(page, page.getByRole('button', { name: 'New project' }));
  await page.getByLabel('Name').focus();
  await page.keyboard.type(projectName);
  await page.keyboard.press('Enter');
  await reloadWhenSaved(page);
  await expect(page.getByRole('link', { name: projectName })).toBeVisible();
  await page.getByRole('link', { name: projectName }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Name').fill(renamed);
  await page.getByRole('button', { name: 'Save' }).click();
  await reloadWhenSaved(page);
  await expect(page.getByRole('heading', { name: renamed })).toBeVisible();

  // 3. Create a threat model, and set its status to in review and back to draft.
  await page.getByRole('button', { name: 'New threat model' }).click();
  await page.getByLabel('Name').fill(modelName);
  await page.getByRole('button', { name: 'Create threat model' }).click();
  await reloadWhenSaved(page);
  await page.getByRole('link', { name: modelName }).click();
  await expect(page.getByRole('heading', { name: modelName })).toBeVisible();
  const status = page.locator('#threat-model-status');
  await status.selectOption('in_review');
  await expect(status).toHaveValue('in_review');
  await reloadWhenSaved(page);
  await expect(page.locator('#threat-model-status')).toHaveValue('in_review');
  await page.locator('#threat-model-status').selectOption('draft');
  await expect(page.locator('#threat-model-status')).toHaveValue('draft');

  // 4. Add a threat (Spoofing, High/High), with the keyboard for the button and the text, and read its
  // derived risk.
  await expect(page.getByText('No threats yet.')).toBeVisible();
  await enter(page, page.getByRole('button', { name: 'Add threat' }));
  const threatForm = page.getByRole('form', { name: 'Add threat' });
  await threatForm.getByLabel('Title').focus();
  await page.keyboard.type('Session token theft');
  await threatForm.getByLabel('Category').selectOption('Spoofing');
  await threatForm.getByLabel('Likelihood').selectOption('High');
  await threatForm.getByLabel('Impact').selectOption('High');
  await enter(page, threatForm.getByRole('button', { name: 'Add threat' }));
  await reloadWhenSaved(page);
  const row = page.getByRole('row', { name: /Session token theft/ });
  await expect(row).toContainText('Spoofing');
  await expect(row.getByRole('cell', { name: 'Critical' })).toBeVisible();

  // Edit the likelihood to Low: the risk follows, as the server derives it.
  await page.getByRole('button', { name: 'Edit threat Session token theft' }).click();
  await page.getByRole('form', { name: 'Edit threat' }).getByLabel('Likelihood').selectOption('Low');
  await page.getByRole('form', { name: 'Edit threat' }).getByRole('button', { name: 'Save' }).click();
  await reloadWhenSaved(page);
  await expect(page.getByRole('row', { name: /Session token theft/ }).getByRole('cell', { name: 'Medium' })).toBeVisible();

  // 5. Expand the mitigations by keyboard, add one with a ticket, set it to implemented, delete it.
  await enter(page, page.getByRole('button', { name: '0 mitigations' }));
  await expect(page.getByRole('button', { name: '0 mitigations' })).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: 'Add mitigation' }).click();
  await page.getByLabel('Description', { exact: true }).last().fill('Rotate refresh credentials');
  await page.getByLabel('Ticket URL').fill('https://tracker.example/SEC-1');
  await page.getByRole('button', { name: 'Save mitigation' }).click();
  await reloadWhenSaved(page);
  await page.getByRole('button', { name: '1 mitigation' }).click();
  const ticket = page.getByRole('link', { name: 'https://tracker.example/SEC-1' });
  await expect(ticket).toHaveAttribute('target', '_blank');
  await expect(ticket).toHaveAttribute('rel', 'noopener noreferrer');
  const mitigationItem = page.getByRole('listitem');
  await mitigationItem.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('form', { name: 'Edit mitigation' }).getByLabel('Status').selectOption('implemented');
  await page.getByRole('button', { name: 'Save mitigation' }).click();
  await reloadWhenSaved(page);
  await page.getByRole('button', { name: '1 mitigation' }).click();
  await expect(page.getByText('implemented')).toBeVisible();
  await mitigationItem.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('Delete this mitigation?')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await reloadWhenSaved(page);
  await expect(page.getByRole('button', { name: '0 mitigations' })).toBeVisible();

  // 6. Delete the threat. Escape cancels the confirmation and focus goes back to Delete; Enter confirms.
  const deleteThreat = page.getByRole('button', { name: 'Delete threat Session token theft' });
  await enter(page, deleteThreat);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(deleteThreat).toBeFocused();
  await enter(page, deleteThreat);
  await page.keyboard.press('Tab'); // from Cancel to Delete
  await page.keyboard.press('Enter');
  await reloadWhenSaved(page);
  await expect(page.getByText('No threats yet.')).toBeVisible();

  // 7. Delete the threat model, then the project, confirming each.
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText(`Delete threat model "${modelName}"? This permanently deletes its elements, threats, mitigations and documents.`)).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('No threat models yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText(`Delete project "${renamed}"? This permanently deletes its threat models and everything in them.`)).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await reloadWhenSaved(page);
  await expect(page.getByRole('link', { name: renamed })).toHaveCount(0);

  // 8. Log out.
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('shows markup in a title literally, and runs nothing', async ({ page, baseURL }) => {
  const account = await createTestAccount(baseURL ?? '');
  const payload = `<img src=x onerror="window.__pwned=1"> ${Date.now()}`;
  await page.goto('/login');
  await page.getByLabel('Username').fill(account.username);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill(payload);
  await page.getByRole('button', { name: 'Create project' }).click();

  await expect(page.getByRole('link', { name: payload })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await page.locator('img').count()).toBe(0);
});
