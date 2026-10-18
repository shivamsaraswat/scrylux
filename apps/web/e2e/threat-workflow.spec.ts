import { randomUUID } from 'node:crypto';
import { compareByRisk, type RiskLevel } from '@scrylux/core';
import type { Locator, Page } from '@playwright/test';
import { canvasOf, elementsOf } from './diagram-helpers.js';
import { apiRequest, apiToken, expect, seedElements, seedModel, signInAsNewAccount, test } from './fixtures.js';

// The canvas sits below the header, and the threats panel below the canvas: a taller window keeps both on screen.
test.use({ viewport: { width: 1400, height: 1500 } });

// Phase 2 / Milestone 4 in a real browser against the built app and a real database (quickstart §2): work through
// an element's threats from the diagram. The diagram is seeded through the batch endpoint, as the other specs do.

interface StoredThreat {
  id: string;
  element_id: string | null;
  title: string;
  status: string;
  status_reason: string | null;
  risk: RiskLevel;
  created_at: string;
}

const create = (id: string, type: string, name: string, extra: Record<string, unknown> = {}) => ({
  op: 'create',
  element: { id, type, name, ...extra },
});

const threatsOf = async (base: string, token: string, modelId: string): Promise<StoredThreat[]> =>
  (await apiRequest(base, token, 'GET', `/api/v1/threat-models/${modelId}/threats`)).body as StoredThreat[];

const generateStatus = (page: Page) => page.locator('.generate-bar [role="status"]');
const panelOf = (page: Page) => page.getByRole('region', { name: 'Threats of the selected element' });
const openThreatsText = (n: number): string => `${n} open ${n === 1 ? 'threat' : 'threats'}`;

// Draws the diagram of the scenarios below and generates its threats. Returns what the later steps refer to.
async function setUp(page: Page, base: string, label: string) {
  const token = await apiToken(base);
  const { modelId } = await seedModel(base, token, label);
  const [customer, api, store, flow] = Array.from({ length: 4 }, () => randomUUID()) as [string, string, string, string];
  await seedElements(base, token, modelId, [
    create(customer, 'external_entity', 'Customer', { layout: { x: 20, y: 100 } }),
    create(api, 'process', 'Orders API', { layout: { x: 320, y: 100 } }),
    create(store, 'data_store', 'Orders DB', { layout: { x: 620, y: 100 } }),
    create(flow, 'data_flow', 'Places order', { source_element_id: customer, target_element_id: api }),
  ]);
  await signInAsNewAccount(page, base);
  await page.goto(`/threat-models/${modelId}/diagram`);
  await page.getByRole('button', { name: 'Generate threats' }).click();
  await expect(generateStatus(page)).toHaveText(/^Generated threats: \d+ created/);
  const threats = await threatsOf(base, token, modelId);
  return { token, modelId, customer, api, store, flow, threats };
}

const apiNode = (page: Page) => page.locator('.react-flow__node[aria-label^="Process Orders API"]');

// The element's button in the elements list is the keyboard's way to select it (spec US2 scenario 9).
async function selectByKeyboard(page: Page, name: string): Promise<Locator> {
  const button = page.getByRole('navigation', { name: 'Elements' }).getByRole('button', { name });
  await button.focus();
  await page.keyboard.press('Enter');
  return button;
}

test('works through an element\'s threats from the diagram, and the counts follow (US1, US2)', async ({ page, baseURL }) => {
  const base = baseURL ?? '';
  const { token, modelId, api, threats } = await setUp(page, base, 'workflow');
  const mine = threats.filter((t) => t.element_id === api);
  const total = mine.length;
  expect(total).toBeGreaterThan(2);

  // Step 1: every element with open threats says how many, in its name and as a badge.
  await expect(apiNode(page)).toHaveAttribute('aria-label', `Process Orders API, ${openThreatsText(total)}`);
  await expect(apiNode(page).locator('.diagram-badge')).toHaveText(String(total));

  // Step 2: select it by keyboard. The panel below lists exactly its threats.
  const apiButton = await selectByKeyboard(page, 'Process: Orders API');
  const panel = panelOf(page);
  await expect(panel.getByRole('heading', { name: 'Threats of Process Orders API' })).toBeVisible();
  await expect(panel.getByRole('row')).toHaveCount(total + 1);
  await expect(apiButton).toHaveAttribute('aria-current', 'true');

  // What the diagram looked like before the user worked in the panel (spec FR-012).
  const viewport = page.locator('.react-flow__viewport');
  const viewportBefore = await viewport.getAttribute('style');
  const elementsBefore = (await elementsOf(base, token, modelId)).length;

  // Step 3: mitigated is refused for want of an implemented mitigation, and says what to do.
  const statuses = panel.getByRole('combobox', { name: /^Status of / });
  const first = statuses.nth(0);
  await first.selectOption('mitigated');
  await expect(panel.getByRole('alert').first()).toHaveText('Mark one of its mitigations implemented or verified first.');
  await expect(first).toHaveValue('open');
  const opened = panel.locator('tr[id^="mitigations-"]');
  await expect(opened).toHaveCount(1);

  // Set one mitigation to implemented; then the same change is accepted, and the count drops with no reload.
  await opened.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await page.getByRole('form', { name: 'Edit mitigation' }).getByLabel('Status').selectOption('implemented');
  await page.getByRole('button', { name: 'Save mitigation' }).click();
  await expect(opened.getByText('implemented')).toBeVisible();
  await first.selectOption('mitigated');
  await expect(first).toHaveValue('mitigated');
  await expect(apiNode(page)).toHaveAttribute('aria-label', `Process Orders API, ${openThreatsText(total - 1)}`);

  // Step 4: not applicable needs a reason, which shows with the threat; the count drops again.
  const second = statuses.nth(1);
  await second.selectOption('not_applicable');
  await panel.getByRole('textbox', { name: /^Reason it does not apply/ }).fill('Out of scope for this release');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(second).toHaveValue('not_applicable');
  await expect(panel.getByText('Out of scope for this release')).toBeVisible();
  await expect(apiNode(page)).toHaveAttribute('aria-label', `Process Orders API, ${openThreatsText(total - 2)}`);

  // What the server stored.
  const stored = await threatsOf(base, token, modelId);
  expect(stored.filter((t) => t.element_id === api && t.status === 'mitigated')).toHaveLength(1);
  const dismissed = stored.filter((t) => t.element_id === api && t.status === 'not_applicable');
  expect(dismissed).toHaveLength(1);
  expect(dismissed[0]?.status_reason).toBe('Out of scope for this release');

  // Working in the panel left the diagram alone: same selection, same viewport, same elements (spec FR-012).
  await expect(apiButton).toHaveAttribute('aria-current', 'true');
  expect(await viewport.getAttribute('style')).toBe(viewportBefore);
  expect((await elementsOf(base, token, modelId)).length).toBe(elementsBefore);

  // Step 5: while a reason is being typed, the diagram's keys do nothing to the diagram.
  await statuses.nth(2).selectOption('accepted');
  const reason = panel.getByRole('textbox', { name: /^Reason for accepting/ });
  await expect(reason).toBeFocused();
  await reason.pressSequentially('Typing, not editing the diagram');
  for (const key of ['Delete', 'Backspace', 'Control+z', 'Control+Shift+z', 'Control+y']) await page.keyboard.press(key);
  await expect(canvasOf(page).locator('.react-flow__node')).toHaveCount(3);
  await expect(apiButton).toHaveAttribute('aria-current', 'true');
  expect((await elementsOf(base, token, modelId)).length).toBe(elementsBefore);
  await panel.getByRole('button', { name: 'Cancel' }).click();
  await expect(statuses.nth(2)).toHaveValue('open');
});

test('adds a manual threat for an element from the diagram, and moves it to another element (US3)', async ({ page, baseURL }) => {
  const base = baseURL ?? '';
  const { token, modelId, api, store, threats } = await setUp(page, base, 'link');
  const openOnApi = threats.filter((t) => t.element_id === api && t.status === 'open').length;

  // Step 6: add a threat for the selected element, already accepted, with its reason.
  await selectByKeyboard(page, 'Process: Orders API');
  const panel = panelOf(page);
  await panel.getByRole('button', { name: 'Add threat for Orders API' }).click();
  const form = panel.getByRole('form', { name: 'Add threat' });
  await expect(form.getByLabel('Element')).toHaveValue(api);
  await form.getByLabel('Title').fill('Business logic abuse');
  await form.getByLabel('Category').selectOption('Tampering');
  await form.getByLabel('Likelihood').selectOption('Medium');
  await form.getByLabel('Impact').selectOption('High');
  await form.getByLabel('Status').selectOption('accepted');
  await form.getByLabel('Reason').fill('Reviewed with the product owner');
  await form.getByRole('button', { name: 'Add threat' }).click();

  // It is in the element's list, and the count does not change: it is not open.
  await expect(panel.getByText('Business logic abuse')).toBeVisible();
  await expect(apiNode(page)).toHaveAttribute('aria-label', `Process Orders API, ${openThreatsText(openOnApi)}`);
  const made = (await threatsOf(base, token, modelId)).find((t) => t.title === 'Business logic abuse');
  expect(made).toMatchObject({ element_id: api, status: 'accepted', status_reason: 'Reviewed with the product owner' });

  // Link it to the data store instead: it leaves this element's list and shows in the other's.
  await panel.getByRole('button', { name: 'Edit threat Business logic abuse' }).click();
  const edit = panel.getByRole('form', { name: 'Edit threat' });
  await edit.getByLabel('Element').selectOption({ label: 'Orders DB' });
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(panel.getByText('Business logic abuse')).toHaveCount(0);
  expect((await threatsOf(base, token, modelId)).find((t) => t.title === 'Business logic abuse')?.element_id).toBe(store);

  await selectByKeyboard(page, 'Data store: Orders DB');
  await expect(panelOf(page).getByText('Business logic abuse')).toBeVisible();
});

test('narrows the threat list from an element, keeps the filters in the address, and a changed row leaves the view (US4)', async ({ page, baseURL }) => {
  const base = baseURL ?? '';
  const { token, modelId, api, threats } = await setUp(page, base, 'filter');
  // One threat written by hand, so there is something to move in step 9.
  const manual = await apiRequest(base, token, 'POST', '/api/v1/threats', {
    threat_model_id: modelId,
    element_id: api,
    category: 'Tampering',
    title: 'Manual abuse case',
    likelihood: 'Low',
    impact: 'Low',
    origin: 'manual',
  });
  expect(manual.status).toBe(201);
  // Written behind the page's back, so the page reads its lists again.
  await page.reload();
  const all = await threatsOf(base, token, modelId);
  const onApi = all.filter((t) => t.element_id === api);
  const openOnApi = onApi.filter((t) => t.status === 'open');
  expect(openOnApi.length).toBeGreaterThan(2);
  expect(threats.length + 1).toBe(all.length);

  // Step 7: from the element's panel to the threat list already filtered to it.
  await selectByKeyboard(page, 'Process: Orders API');
  await panelOf(page).getByRole('link', { name: 'Open in the threat list' }).click();
  await expect(page).toHaveURL(new RegExp(`/threat-models/${modelId}\\?element=${api}$`));
  await expect(page.getByText(`Showing ${onApi.length} of ${all.length} threats`)).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(onApi.length + 1);

  // Open threats only, the most serious first. The filters are in the address.
  await page.getByRole('checkbox', { name: 'Open', exact: true }).check();
  await page.getByRole('combobox', { name: 'Order', exact: true }).selectOption('risk');
  await expect(page).toHaveURL(new RegExp(`element=${api}&status=open&sort=risk$`));
  await expect(page.getByText(`Showing ${openOnApi.length} of ${all.length} threats`)).toBeVisible();
  const mostSerious = [...openOnApi].sort(compareByRisk)[0];
  await expect(page.getByRole('row').nth(1)).toContainText(mostSerious?.title ?? '');

  // A reload, or a link opened elsewhere, shows the same list.
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`element=${api}&status=open&sort=risk$`));
  await expect(page.getByText(`Showing ${openOnApi.length} of ${all.length} threats`)).toBeVisible();
  await expect(page.getByRole('row').nth(1)).toContainText(mostSerious?.title ?? '');

  // Step 8: clear the filters; the summary is for the whole model and matches the list.
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).toHaveURL(new RegExp(`/threat-models/${modelId}$`));
  await expect(page.getByText(`Showing ${all.length} of ${all.length} threats`)).toBeVisible();
  const summary = page.getByRole('region', { name: 'Threat summary' });
  await expect(summary.locator('dt', { hasText: /^Open$/ }).locator('xpath=following-sibling::dd[1]')).toHaveText(String(all.filter((t) => t.status === 'open').length));

  // Step 9: on the element's list, link the manual threat to the data store. It leaves the view, focus moves on,
  // and the table says why the row went.
  await page.goto(`/threat-models/${modelId}?element=${api}`);
  await expect(page.getByRole('row')).toHaveCount(onApi.length + 1);
  await page.getByRole('button', { name: 'Edit threat Manual abuse case' }).click();
  const edit = page.getByRole('form', { name: 'Edit threat' });
  await edit.getByLabel('Element').selectOption({ label: 'Orders DB' });
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('row')).toHaveCount(onApi.length);
  await expect(page.getByText('Saved. The threat no longer matches this view.')).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')?.startsWith('Status of '))).toBe(true);
});
