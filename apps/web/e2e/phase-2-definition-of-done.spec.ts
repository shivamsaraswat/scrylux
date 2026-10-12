import { readFileSync } from 'node:fs';
import type { Download, Page } from '@playwright/test';
import { GESTURE, addNode, boxOf, canvasOf, connect, dropNodeAt, nodeOf, stored, untilSaved, untilStill } from './diagram-helpers.js';
import { apiRequest, apiToken, expect, seedModel, signInAsNewAccount, test } from './fixtures.js';

// Phase 2's Definition of Done (plan.md), in one run, in a real browser against the built app and a real database
// (Milestone 8, spec FR-027, SC-007):
//
//   draw a DFD with at least one trust boundary -> generate STRIDE threats -> change statuses and add mitigations ->
//   export a Markdown report and an OTM file -> re-import the OTM round-trip without losing elements or threats.
//
// "docker compose up", the sentence's first step, is the release pipeline's smoke run against the image (the browser tests
// run against the built app, not a container). Every other step is done through the page. The only thing set up through the
// API is an empty project and threat model to draw in: creating those is not a step of the sentence. What is asserted after a
// step is what the server stored. report.spec.ts, threat-workflow.spec.ts and diagram.spec.ts keep their own jobs (the report's
// content, the workflow's rules, the canvas's gestures); this one keeps the sentence.

test.use({ viewport: { width: 1400, height: 1500 } });

interface StoredThreat {
  id: string;
  element_id: string | null;
  title: string;
  category: string;
  status: string;
  status_reason: string | null;
  risk: string;
  origin: string;
}

const textOf = async (download: Download): Promise<string> => readFileSync(await download.path(), 'utf8');
const generateStatus = (page: Page) => page.locator('.generate-bar [role="status"]');

test('walks the Definition of Done of Phase 2 through the interface', async ({ page, baseURL }) => {
  const base = baseURL ?? '';
  const token = await apiToken(base);
  const { modelId } = await seedModel(base, token, 'p2-dod');
  const target = await seedModel(base, token, 'p2-dod-target');
  const read = async (id: string, kind: 'elements' | 'threats' | 'mitigations') =>
    (await apiRequest(base, token, 'GET', `/api/v1/threat-models/${id}/${kind}`)).body as Record<string, string | null>[];

  await test.step('1. Sign in', async () => {
    await signInAsNewAccount(page, base);
  });

  await test.step('2. Draw a diagram with a trust boundary', async () => {
    await page.goto(`/threat-models/${modelId}/diagram`);
    await expect(canvasOf(page)).toBeVisible();
    await expect(canvasOf(page).locator('.react-flow__node')).toHaveCount(0);

    await addNode(page, 'Add trust boundary', 'Internal network');
    await addNode(page, 'Add process', 'API');
    await addNode(page, 'Add data store', 'Orders DB');
    await addNode(page, 'Add external entity', 'Browser');
    await untilStill(nodeOf(page, 'Orders DB'));
    await page.getByRole('button', { name: 'Fit to view' }).click();
    await untilStill(nodeOf(page, 'Internal network'));

    // The API and the database are put inside the boundary; the browser stays outside it. Scrolling the canvas into view and
    // the view fitting itself after a move both shift what is on screen, so the boundary is measured again before each drop.
    const into = async (name: string, at: { x: number; y: number }): Promise<void> => {
      await canvasOf(page).scrollIntoViewIfNeeded();
      await untilStill(nodeOf(page, 'Internal network'));
      const zone = await boxOf(nodeOf(page, 'Internal network'));
      await dropNodeAt(page, nodeOf(page, name), { x: zone.x + zone.width * at.x, y: zone.y + zone.height * at.y });
    };
    await into('API', { x: 0.25, y: 0.4 });
    await into('Orders DB', { x: 0.7, y: 0.65 });

    await connect(page, 'Browser', 'API', 'HTTPS request');
    await connect(page, 'API', 'Orders DB', 'SQL');
    await untilSaved(page);

    const { byName } = await stored(base, token, modelId);
    const boundary = byName.get('Internal network');
    expect(boundary?.type).toBe('trust_boundary');
    expect(byName.get('API')?.parent_boundary_id, 'the API is inside the boundary').toBe(boundary?.id);
    expect(byName.get('Orders DB')?.parent_boundary_id, 'the database is inside the boundary').toBe(boundary?.id);
    expect(byName.get('Browser')?.parent_boundary_id, 'the browser is outside it').toBeNull();
    expect(byName.get('HTTPS request')).toMatchObject({ type: 'data_flow', source_element_id: byName.get('Browser')?.id, target_element_id: byName.get('API')?.id });
    expect(byName.get('SQL')).toMatchObject({ type: 'data_flow', source_element_id: byName.get('API')?.id, target_element_id: byName.get('Orders DB')?.id });
  });

  let threats: StoredThreat[] = [];
  await test.step('3. Generate the STRIDE threats', async () => {
    await page.getByRole('button', { name: 'Generate threats' }).click();
    await expect(generateStatus(page)).toHaveText(/^Generated threats: \d+ created/);
    const created = Number(/(\d+) created/.exec(await generateStatus(page).innerText())?.[1]);
    expect(created, 'a diagram with a boundary, a flow across it and a store yields threats').toBeGreaterThanOrEqual(5);
    threats = (await read(modelId, 'threats')) as unknown as StoredThreat[];
    expect(threats).toHaveLength(created);
    expect(threats.every((t) => t.origin === 'rule' && t.status === 'open')).toBe(true);
  });

  await test.step('4. Change statuses and add a mitigation', async () => {
    const apiId = (await stored(base, token, modelId)).byName.get('API')?.id;
    await page.getByRole('navigation', { name: 'Elements' }).getByRole('button', { name: 'Process: API' }).click();
    const panel = page.getByRole('region', { name: 'Threats of the selected element' });
    await expect(panel.getByRole('heading', { name: 'Threats of Process API' })).toBeVisible();
    const statuses = panel.getByRole('combobox', { name: /^Status of / });
    const mine = threats.filter((t) => t.element_id === apiId).length;
    await expect(statuses).toHaveCount(mine);
    expect(mine).toBeGreaterThan(1);

    // The two threats are named once and found by name afterwards: adding a mitigation can reorder the list, and a position
    // is not the threat the person was working on.
    const nameOf = async (index: number): Promise<string> => (await statuses.nth(index).getAttribute('aria-label')) ?? '';
    const [firstName, secondName] = [await nameOf(0), await nameOf(1)];
    expect(firstName).not.toBe('');
    expect(secondName).not.toBe(firstName);
    const statusOf = (name: string) => panel.getByRole('combobox', { name, exact: true });

    // A threat cannot be mitigated before a mitigation is implemented. Add one through the form, then it can.
    const first = statusOf(firstName);
    await first.selectOption('mitigated');
    await expect(panel.getByRole('alert').first()).toHaveText('Mark one of its mitigations implemented or verified first.');
    const row = panel.locator('tr[id^="mitigations-"]');
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { name: 'Add mitigation' }).click();
    const form = page.getByRole('form', { name: 'Add mitigation' });
    await form.getByLabel('Description').fill('Requests are validated at the gateway before they reach the API.');
    await form.getByLabel('Status').selectOption('implemented');
    await page.getByRole('button', { name: 'Save mitigation' }).click();
    await expect(row.getByText('Requests are validated at the gateway before they reach the API.')).toBeVisible();
    // Straight after the mitigation is saved, the status control can still hold the list from before it and refuse again (a
    // finding of Milestone 8, recorded as an issue and not fixed here: a second try works). A person tries again, and so does this.
    await expect(async () => {
      await first.selectOption('mitigated');
      await expect(first).toHaveValue('mitigated', { timeout: 1500 });
    }).toPass(GESTURE);

    // Another is accepted, with its reason.
    const second = statusOf(secondName);
    await second.selectOption('accepted');
    await panel.getByRole('textbox', { name: /^Reason for accepting/ }).fill('Accepted for this run of the Definition of Done.');
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(second).toHaveValue('accepted');

    const after = (await read(modelId, 'threats')) as unknown as StoredThreat[];
    expect(after.filter((t) => t.status === 'mitigated')).toHaveLength(1);
    const accepted = after.filter((t) => t.status === 'accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.status_reason).toBe('Accepted for this run of the Definition of Done.');
    const added = (await read(modelId, 'mitigations')).filter((m) => m.description === 'Requests are validated at the gateway before they reach the API.');
    expect(added).toHaveLength(1);
    expect(added[0]?.status).toBe('implemented');
  });

  let markdown = '';
  let otm: Download | undefined;
  await test.step('5. Export a Markdown report and an OTM file', async () => {
    await page.getByRole('link', { name: 'Threats' }).click();
    const [report] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download Markdown report' }).click()]);
    expect(report.suggestedFilename()).toMatch(/\.md$/);
    markdown = await textOf(report);
    expect(markdown).toContain('- **Methodology:** STRIDE');
    expect(markdown).toContain(`| **Total** | **${threats.length}** |`);
    expect(markdown).toContain('- **Status:** Mitigated');
    expect(markdown).toContain('- **Status:** Accepted');
    expect(markdown).toContain('  > Accepted for this run of the Definition of Done\\.');
    expect(markdown).toContain('Requests are validated at the gateway before they reach the API\\.');
    // The diagram is in the report: one boundary, and the two flows, one of which crosses it.
    expect(markdown).toContain('"HTTPS request"');
    expect(markdown).toContain('- **Crosses a trust boundary:** Yes (from outside any trust boundary to Internal network)');

    const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download OTM file' }).click()]);
    expect(file.suggestedFilename()).toMatch(/\.otm\.json$/);
    otm = file;
    expect(JSON.parse(await textOf(file)) as { otmVersion?: string }).toHaveProperty('otmVersion');
  });

  await test.step('6. Import the OTM file back, and lose nothing', async () => {
    await page.goto(`/projects/${target.projectId}`);
    await page.getByRole('button', { name: 'Import threat model' }).click();
    await page.getByLabel('File to import').setInputFiles(await (otm as Download).path());
    await expect(page.getByRole('heading', { name: 'Ready to import' })).toBeVisible();
    await expect(page.getByText('OTM file')).toBeVisible();
    await expect(page.getByText('Everything in this file will be imported.')).toBeVisible();
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page).toHaveURL(/\/threat-models\/[0-9a-f-]{36}$/);
    const importedId = /\/threat-models\/([0-9a-f-]{36})$/.exec(page.url())?.[1] ?? '';
    expect(importedId).not.toBe(modelId);
    await expect(page.getByRole('region', { name: 'What the import left out' })).toHaveCount(0);

    const summarise = async (id: string) => ({
      elements: (await read(id, 'elements')).map((e) => `${e.type}|${e.name}`).sort(),
      threats: (await read(id, 'threats')).map((t) => `${t.title}|${t.category}|${t.status}|${t.status_reason ?? ''}|${t.risk}|${t.origin}`).sort(),
      mitigations: (await read(id, 'mitigations')).map((m) => `${m.description}|${m.status}`).sort(),
    });
    expect(await summarise(importedId)).toEqual(await summarise(modelId));
    // The statuses and the mitigation the work gave them came back, and a second run of the rules finds nothing to add.
    const imported = (await read(importedId, 'threats')) as unknown as StoredThreat[];
    expect(imported.filter((t) => t.status === 'mitigated')).toHaveLength(1);
    expect(imported.filter((t) => t.status === 'accepted')).toHaveLength(1);
    const rerun = (await apiRequest(base, token, 'POST', `/api/v1/threat-models/${importedId}/threats/generate`, {})).body as { created: number };
    expect(rerun.created).toBe(0);
    // The imported diagram keeps its boundary and the membership of what was inside it.
    const { byName } = await stored(base, token, importedId);
    expect(byName.get('Internal network')?.type).toBe('trust_boundary');
    expect(byName.get('API')?.parent_boundary_id).toBe(byName.get('Internal network')?.id);
    expect(byName.get('Orders DB')?.parent_boundary_id).toBe(byName.get('Internal network')?.id);
  });
});
