import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Download, Page } from '@playwright/test';
import { busiest, seed } from './bound.js';
import { apiToken, expect, seedElements, seedModel, signInAsNewAccount, test } from './fixtures.js';

// Phase 2 / Milestone 5, FR-022, SC-004 and FR-007a, in a real browser against the built app and a real database
// (quickstart §5): a report is ready quickly on a typical threat model and at the size Milestone 3 allows (1,000
// elements, about 15,000 threats and 49,000 mitigations), and the page stays usable while it is made. This is a
// regression guard on a shared runner. The authoritative numbers are taken against `docker compose`, and recorded in
// the pull request and in quickstart §5:
//   PLAYWRIGHT_BASE_URL=http://localhost:3000 pnpm --filter @scrylux/web test:e2e report-large
test.use({ viewport: { width: 1400, height: 1500 } });

const BUTTONS = { markdown: 'Download Markdown report', html: 'Download HTML report (print or save as PDF)' } as const;
type Format = keyof typeof BUTTONS;

const megabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;

// Clicks a download button and waits until the file is complete. Returns how long that took, and the file.
async function downloaded(page: Page, format: Format, label: string): Promise<{ ms: number; size: number; download: Download }> {
  const started = Date.now();
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.getByRole('button', { name: BUTTONS[format] }).click()]);
  const size = statSync(await download.path()).size;
  const ms = Date.now() - started;
  console.log(`report, ${label}, ${format}: ${ms} ms, ${megabytes(size)}`);
  test.info().annotations.push({ type: `${label} ${format}`, description: `${ms} ms, ${megabytes(size)}` });
  return { ms, size, download };
}

test('is ready within 2 seconds on a typical threat model (SC-004)', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const base = baseURL ?? '';
  const token = await apiToken(base);
  const { modelId, created } = await seed(base, token, 'report-typical', 50, 'process', {});
  await signInAsNewAccount(page, base);
  await page.goto(`/threat-models/${modelId}`);
  await expect(page.getByText(`Showing ${created} of ${created} threats`)).toBeVisible();
  for (const format of ['markdown', 'html'] as const) {
    const { ms } = await downloaded(page, format, 'typical');
    expect(ms, `${format} took ${ms} ms`).toBeLessThanOrEqual(2000);
  }
});

test('is ready within 15 seconds at 1,000 elements and about 15,000 threats, and the page stays usable (FR-022, SC-004)', async ({
  page,
  baseURL,
}) => {
  // Seeding is not timed, and takes far longer than Playwright's 30 s default.
  test.setTimeout(400_000);
  const base = baseURL ?? '';
  const token = await apiToken(base);
  const { type, flags, candidates } = busiest();
  const { modelId, created } = await seed(base, token, 'report-large', 1000, type, flags);
  // The load is the one claimed: every element has the most threats the library gives any.
  expect(created).toBe(1000 * candidates);
  await signInAsNewAccount(page, base);

  // A page of its own for each download, and nothing else going on in it, so the time is the time of the report.
  const open = async (): Promise<Page> => {
    const fresh = await page.context().newPage();
    await fresh.goto(`/threat-models/${modelId}`);
    await expect(fresh.getByText(`Showing ${created} of ${created} threats`)).toBeVisible({ timeout: 60_000 });
    return fresh;
  };

  for (const format of ['markdown', 'html'] as const) {
    const fresh = await open();
    const { ms, download } = await downloaded(fresh, format, 'large');
    expect(ms, `${format} took ${ms} ms`).toBeLessThanOrEqual(15_000);
    // Every threat once (SC-002) in a file of tens of megabytes.
    const body = readFileSync(await download.path(), 'utf8');
    const threats = format === 'markdown' ? body.match(/^##### /gm)?.length : body.match(/<article class="threat">/g)?.length;
    expect(threats).toBe(created);
    await fresh.close();
  }

  // While a report is being made the page still answers: another view opens. This is read from what the app says about
  // itself ("Report downloaded."), not from the browser's own download event, which is what the timings above are for.
  const busy = await open();
  await busy.getByRole('button', { name: BUTTONS.markdown }).click();
  await busy.getByRole('link', { name: 'Diagram' }).click();
  await expect(busy).toHaveURL(/\/diagram$/, { timeout: 10_000 });
  await expect(busy.locator('.report-bar [role="status"]')).toHaveText('Report downloaded.', { timeout: 60_000 });
  await busy.close();
});

test('leaves the flowchart out of a diagram with more than 400 flows, and the HTML report still draws every one (FR-007a)', async ({
  page,
  baseURL,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const base = baseURL ?? '';
  const token = await apiToken(base);
  const { modelId } = await seedModel(base, token, 'report-flows');
  const [a, b] = [randomUUID(), randomUUID()];
  const flows = 401;
  await seedElements(base, token, modelId, [
    { op: 'create', element: { id: a, type: 'process', name: 'A', layout: { x: 0, y: 0 } } },
    { op: 'create', element: { id: b, type: 'process', name: 'B', layout: { x: 400, y: 0 } } },
    ...Array.from({ length: flows }, (_, i) => ({
      op: 'create',
      element: { type: 'data_flow', name: `Flow ${i + 1}`, source_element_id: i % 2 === 0 ? a : b, target_element_id: i % 2 === 0 ? b : a },
    })),
  ]);
  await signInAsNewAccount(page, base);
  await page.goto(`/threat-models/${modelId}`);

  const markdown = readFileSync((await (await downloaded(page, 'markdown', 'flows')).download.path()), 'utf8');
  expect(markdown).not.toContain('```mermaid');
  expect(markdown).toContain(`> The diagram has ${2 + flows} elements and is too large to draw here. Its structure is listed under Elements below; the HTML report from Scrylux draws it in full.`);
  // The note points at the element sections, which are all there.
  expect(markdown.match(/^#### E\d+ · Data flow · /gm)).toHaveLength(flows);

  const { download } = await downloaded(page, 'html', 'flows');
  const file = testInfo.outputPath('flows.html');
  await download.saveAs(file);
  const context = await browser.newContext();
  const reader = await context.newPage();
  await reader.goto(pathToFileURL(file).href);
  await expect(reader.locator('svg g.flow')).toHaveCount(flows);
  await context.close();
});
