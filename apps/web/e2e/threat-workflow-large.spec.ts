import type { Page } from '@playwright/test';
import { busiest, seed, type NodeType } from './bound.js';
import { apiToken, expect, signInAsNewAccount, test } from './fixtures.js';

// Phase 2 / Milestone 4, SC-002 and SC-005, in a real browser against the built app and a real database: working
// through threats stays quick at the size Milestone 3 allows (1,000 elements, about 15,000 threats and 49,000
// mitigations), and on a typical model. This is a regression guard on a shared runner. The authoritative numbers
// are taken against `docker compose`, and recorded in the pull request:
//   PLAYWRIGHT_BASE_URL=http://localhost:3000 pnpm --filter @scrylux/web test:e2e threat-workflow-large
test.use({ viewport: { width: 1400, height: 1500 } });

const TYPE_LABELS: Record<NodeType, string> = { external_entity: 'External entity', process: 'Process', data_store: 'Data store' };

const elapsedSince = (started: number): number => Date.now() - started;
const report = (what: string, ms: number): void => console.log(`threat workflow, ${what}: ${ms} ms`);
const unitButton = (page: Page, n: number) =>
  page.getByRole('navigation', { name: 'Elements' }).getByRole('button', { name: new RegExp(`: Unit ${n}(?: · \\d+ open)?$`) });
const panelOf = (page: Page) => page.getByRole('region', { name: 'Threats of the selected element' });

test('stays quick at 1,000 elements and about 15,000 threats (SC-005)', async ({ page, baseURL }) => {
  // Seeding is not timed, and takes far longer than Playwright's 30 s default.
  test.setTimeout(300_000);
  const base = baseURL ?? '';
  const token = await apiToken(base);
  const { type, flags, candidates } = busiest();
  const { modelId, created } = await seed(base, token, 'workflow-large', 1000, type, flags);
  // The load is the one claimed: every element has the most threats the library gives any.
  expect(created).toBe(1000 * candidates);
  await signInAsNewAccount(page, base);

  // The Threats tab: the summary, the count line and the first page of rows.
  let started = Date.now();
  await page.goto(`/threat-models/${modelId}`);
  await expect(page.getByText(`Showing ${created} of ${created} threats`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('region', { name: 'Threat summary' })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(100);
  const openThreats = elapsedSince(started);
  report('open the Threats tab', openThreats);
  expect(openThreats, `opened in ${openThreats} ms`).toBeLessThanOrEqual(3000);

  // Filters: the result of each is shown within a second.
  started = Date.now();
  await page.getByRole('checkbox', { name: 'Open', exact: true }).check();
  await expect(page).toHaveURL(/status=open/);
  await expect(page.getByText(`Showing ${created} of ${created} threats`)).toBeVisible();
  const firstFilter = elapsedSince(started);
  report('first filter (status open)', firstFilter);
  expect(firstFilter).toBeLessThanOrEqual(1000);

  started = Date.now();
  await page.getByRole('checkbox', { name: 'Critical', exact: true }).check();
  await expect(page).toHaveURL(/risk=Critical/);
  await expect(page.getByText(/^Showing \d+ of \d+ threats$|^No threat matches these filters\.$/)).toBeVisible();
  const secondFilter = elapsedSince(started);
  report('second filter (risk Critical)', secondFilter);
  expect(secondFilter).toBeLessThanOrEqual(1000);

  // The Diagram tab: the canvas with its count badges.
  started = Date.now();
  await page.goto(`/threat-models/${modelId}/diagram`);
  await expect(page.locator('.react-flow__node .diagram-badge').first()).toBeVisible({ timeout: 30_000 });
  const openDiagram = elapsedSince(started);
  report('open the Diagram tab', openDiagram);
  expect(openDiagram, `opened in ${openDiagram} ms`).toBeLessThanOrEqual(3000);

  // A first selection, made at once and so before everything the panel needs may have arrived, then another.
  started = Date.now();
  await unitButton(page, 7).click();
  await expect(panelOf(page).getByRole('heading', { name: new RegExp(`^Threats of ${TYPE_LABELS[type]} Unit 7$`) })).toBeVisible({ timeout: 30_000 });
  await expect(panelOf(page).getByRole('row')).toHaveCount(candidates + 1);
  const coldSelect = elapsedSince(started);
  report('cold first selection', coldSelect);
  expect(coldSelect).toBeLessThanOrEqual(1000);

  started = Date.now();
  await unitButton(page, 8).click();
  await expect(panelOf(page).getByRole('heading', { name: new RegExp(`^Threats of ${TYPE_LABELS[type]} Unit 8$`) })).toBeVisible();
  await expect(panelOf(page).getByRole('row')).toHaveCount(candidates + 1);
  const nextSelect = elapsedSince(started);
  report('a further selection', nextSelect);
  expect(nextSelect).toBeLessThanOrEqual(1000);

  // One threat not applicable, with its reason: the element's badge follows within a second.
  const node = page.locator(`.react-flow__node[aria-label^="${TYPE_LABELS[type]} Unit 8,"]`);
  await expect(node).toHaveAttribute('aria-label', `${TYPE_LABELS[type]} Unit 8, ${candidates} open threats`);
  await panelOf(page).getByRole('combobox', { name: /^Status of / }).first().selectOption('not_applicable');
  await panelOf(page).getByRole('textbox', { name: /^Reason it does not apply/ }).fill('Out of scope');
  started = Date.now();
  await panelOf(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(node).toHaveAttribute('aria-label', `${TYPE_LABELS[type]} Unit 8, ${candidates - 1} open ${candidates - 1 === 1 ? 'threat' : 'threats'}`);
  const statusChange = elapsedSince(started);
  report('a status change until the badge follows', statusChange);
  expect(statusChange).toBeLessThanOrEqual(1000);
});

// SC-002: on a typical model, selecting an element shows its threats within a second.
test('shows an element\'s threats within a second on a typical model (SC-002)', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const base = baseURL ?? '';
  const token = await apiToken(base);
  const { modelId } = await seed(base, token, 'workflow-typical', 50, 'process', {});
  await signInAsNewAccount(page, base);

  await page.goto(`/threat-models/${modelId}/diagram`);
  await expect(page.locator('.react-flow__node .diagram-badge').first()).toBeVisible();
  const started = Date.now();
  await unitButton(page, 7).click();
  await expect(panelOf(page).getByRole('heading', { name: /^Threats of Process Unit 7$/ })).toBeVisible();
  await expect(panelOf(page).getByRole('row').nth(1)).toBeVisible();
  const elapsed = elapsedSince(started);
  report('typical model, selecting an element', elapsed);
  expect(elapsed, `shown in ${elapsed} ms`).toBeLessThanOrEqual(1000);
});
