import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { apiRequest, apiToken, expect, seedElements, seedModel, signInAsNewAccount, test } from './fixtures.js';

// Phase 2 / Milestone 6 in a real browser against the built app and a real database (quickstart §1): export a threat
// model as a Scrylux file, import it into another project through the preview, and find everything there (US1). The
// diagram is seeded through the batch endpoint and the statuses through the API, as report.spec.ts does; the states the
// API refuses to create (an accepted threat with no reason, a stale one) are covered by the contract tests, which can
// reach the database.

test.use({ viewport: { width: 1400, height: 1500 } });

interface ExportedFile {
  threat_model: { name: string };
  elements: { id: string; name: string }[];
  threats: { id: string; title: string; status: string }[];
  mitigations: { id: string; description: string }[];
}

const create = (id: string, type: string, name: string, extra: Record<string, unknown> = {}) => ({ op: 'create', element: { id, type, name, ...extra } });

// What FR-004 compares: the file without its export time and its project, with every id replaced by its place in the
// file, so two exports are equal exactly when they are equal once ids are mapped.
function canonical(file: Record<string, unknown>): unknown {
  const text = JSON.stringify(file);
  const labels = new Map<string, string>();
  for (const [kind, key] of [['e', 'elements'], ['t', 'threats'], ['m', 'mitigations']] as const) {
    (file[key] as { id: string }[]).forEach((record, index) => labels.set(record.id, `${kind}${index}`));
  }
  const mapped = JSON.parse(text.replaceAll(/"[0-9a-f-]{36}"/g, (match) => `"${labels.get(match.slice(1, -1)) ?? match}"`)) as Record<string, unknown>;
  delete mapped.exported_at;
  delete mapped.project;
  return mapped;
}

async function seed(base: string, token: string, label: string): Promise<{ projectId: string; modelId: string }> {
  const seeded = await seedModel(base, token, label);
  const [boundary, api, store, browser, https, sql] = Array.from({ length: 6 }, () => randomUUID()) as [string, string, string, string, string, string];
  await seedElements(base, token, seeded.modelId, [
    create(browser, 'external_entity', 'Browser', { layout: { x: 20, y: 100 } }),
    create(boundary, 'trust_boundary', 'Internal network', { layout: { x: 300, y: 20, width: 560, height: 260 } }),
    create(api, 'process', 'API', { layout: { x: 20, y: 80 }, parent_boundary_id: boundary, properties: { tags: ['Node.js'], flags: { internet_facing: true } } }),
    create(store, 'data_store', 'Orders DB', { layout: { x: 320, y: 80 }, parent_boundary_id: boundary, properties: { flags: { encrypted_at_rest: false } } }),
    create(https, 'data_flow', 'HTTPS request', { source_element_id: browser, target_element_id: api }),
    create(sql, 'data_flow', 'SQL', { source_element_id: api, target_element_id: store }),
  ]);
  expect((await apiRequest(base, token, 'POST', `/api/v1/threat-models/${seeded.modelId}/threats/generate`, {})).status).toBe(200);
  const threats = (await apiRequest(base, token, 'GET', `/api/v1/threat-models/${seeded.modelId}/threats`)).body as { id: string }[];
  expect(threats.length).toBeGreaterThan(4);
  expect((await apiRequest(base, token, 'PATCH', `/api/v1/threats/${threats[0]?.id}`, { status: 'accepted', status_reason: 'Accepted by the platform team.' })).status).toBe(200);
  expect((await apiRequest(base, token, 'POST', '/api/v1/mitigations', { threat_id: threats[1]?.id, description: 'Fixed in the gateway', status: 'implemented', external_ref: 'https://tracker.example/SEC-1' })).status).toBe(201);
  expect((await apiRequest(base, token, 'PATCH', `/api/v1/threats/${threats[1]?.id}`, { status: 'mitigated' })).status).toBe(200);
  return seeded;
}

async function downloadScrylux(page: Page): Promise<{ file: ExportedFile & Record<string, unknown>; name: string; path: string }> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download Scrylux file' }).click()]);
  const saved = await download.path();
  return { file: JSON.parse(readFileSync(saved, 'utf8')) as ExportedFile & Record<string, unknown>, name: download.suggestedFilename(), path: saved };
}

async function importFile(page: Page, projectId: string, path: string): Promise<void> {
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('button', { name: 'Import threat model' }).click();
  await page.getByLabel('File to import').setInputFiles(path);
  await expect(page.getByRole('heading', { name: 'Ready to import' })).toBeVisible();
}

test('exports a threat model as a Scrylux file and imports it into another project without losing anything (US1, SC-001, SC-005)', async ({ page, baseURL }, testInfo) => {
  const base = baseURL ?? '';
  const token = await apiToken(base);
  const source = await seed(base, token, 'exchange');
  const target = await seedModel(base, token, 'target');

  await signInAsNewAccount(page, base);
  await page.goto(`/threat-models/${source.modelId}`);

  // 1. Export, from the Threats view. The file is named after the model and the date.
  const exportStarted = Date.now();
  const exported = await downloadScrylux(page);
  const exportSeconds = (Date.now() - exportStarted) / 1000;
  testInfo.annotations.push({ type: 'export seconds (SC-005)', description: exportSeconds.toFixed(2) });
  expect(exportSeconds).toBeLessThan(60);
  expect(exported.name).toMatch(/^exchange-\d+-[0-9a-f]{6}-\d{4}-\d{2}-\d{2}\.scrylux\.json$/);
  expect(exported.file.elements).toHaveLength(6);

  // 2. Import it into the other project, through the preview, which lists everything and says nothing is lost.
  const importStarted = Date.now();
  await importFile(page, target.projectId, exported.path);
  await expect(page.getByText('Everything in this file will be imported.')).toBeVisible();
  await expect(page.getByLabel('Name of threat model 1')).toHaveValue(exported.file.threat_model.name);
  await expect(page.getByText(new RegExp(`6 elements, ${exported.file.threats.length} threats, ${exported.file.mitigations.length} mitigations`))).toBeVisible();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page).toHaveURL(/\/threat-models\/[0-9a-f-]{36}$/);
  const importSeconds = (Date.now() - importStarted) / 1000;
  testInfo.annotations.push({ type: 'import seconds (SC-005)', description: importSeconds.toFixed(2) });
  expect(importSeconds).toBeLessThan(60);
  const importedId = /\/threat-models\/([0-9a-f-]{36})$/.exec(page.url())?.[1] ?? '';
  expect(importedId).not.toBe(source.modelId);
  await expect(page.getByRole('heading', { name: exported.file.threat_model.name })).toBeVisible();

  // 3. Everything is there: the elements and threats by name and title, with the statuses the work gave them.
  const stored = async (id: string, kind: string) => (await apiRequest(base, token, 'GET', `/api/v1/threat-models/${id}/${kind}`)).body as Record<string, unknown>[];
  const names = async (id: string) => (await stored(id, 'elements')).map((element) => element.name).sort();
  expect(await names(importedId)).toEqual(await names(source.modelId));
  const threatsOf = async (id: string) => (await stored(id, 'threats')).map((threat) => `${threat.title as string}|${threat.status as string}|${threat.origin as string}`).sort();
  expect(await threatsOf(importedId)).toEqual(await threatsOf(source.modelId));
  await expect(page.getByRole('region', { name: 'Threat summary' })).toBeVisible();

  // 4. Exported again, it is the same file once ids are mapped, and generating threats finds nothing to add.
  const again = await downloadScrylux(page);
  expect(canonical(again.file)).toEqual(canonical(exported.file));
  await page.getByRole('link', { name: 'Diagram' }).click();
  await page.getByRole('button', { name: 'Generate threats' }).click();
  await expect(page.locator('.generate-bar [role="status"]')).toHaveText(/^Generated threats: 0 created/);
});

test('says a name is taken in the preview, and imports once it is changed (US1 scenario 6)', async ({ page, baseURL }) => {
  const base = baseURL ?? '';
  const token = await apiToken(base);
  const source = await seed(base, token, 'twice');
  await signInAsNewAccount(page, base);
  await page.goto(`/threat-models/${source.modelId}`);
  const exported = await downloadScrylux(page);

  // Back into the project it came from: the default name is taken.
  await importFile(page, source.projectId, exported.path);
  await expect(page.getByText('A threat model with this name already exists in this project.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();

  const field = page.getByLabel('Name of threat model 1');
  await field.fill(`${exported.file.threat_model.name} (copy)`);
  await expect(page.getByText('A threat model with this name already exists in this project.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page).toHaveURL(/\/threat-models\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: `${exported.file.threat_model.name} (copy)` })).toBeVisible();
});

// ---- US3: a Threat Dragon file ----

const demoPath = (name: string): string => fileURLToPath(new URL(`../../api/test/exchange/fixtures/threat-dragon/${name}`, import.meta.url));

// The model page an import with something left out lands on (FR-013a, FR-016): the list is in a region of its own, only
// right after the import.
const leftOut = (page: Page) => page.getByRole('region', { name: 'What the import left out' });
async function expectLeftOutOnlyOnce(page: Page, modelName: string): Promise<void> {
  await expect(page).toHaveURL(/\/threat-models\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: modelName, exact: true })).toBeVisible();
  await expect(leftOut(page)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: modelName, exact: true })).toBeVisible();
  await expect(leftOut(page)).toHaveCount(0);
}

test('imports a Threat Dragon demo model, listing what it could not carry over (US3, SC-003)', async ({ page, baseURL }) => {
  const base = baseURL ?? '';
  const token = await apiToken(base);
  const target = await seedModel(base, token, 'td-demo');
  await signInAsNewAccount(page, base);

  await importFile(page, target.projectId, demoPath('v2-threat-model.json'));
  // The preview: the model, its counts, and that some parts of the file are left out (boundary lines, a text block...).
  await expect(page.getByText('Threat Dragon file')).toBeVisible();
  await expect(page.getByLabel('Name of threat model 1')).toHaveValue('Demo Threat Model');
  await expect(page.getByText(/16 elements, 14 threats, 14 mitigations/)).toBeVisible();
  await expect(page.getByText(/^\d+ parts of this file won't be carried over or were changed to fit\.$/)).toBeVisible();

  await page.getByRole('button', { name: 'Import', exact: true }).click();
  // The user is taken to the new model, which shows what was left out, from the import's own answer (FR-013a, FR-016).
  await expect(page).toHaveURL(/\/threat-models\/[0-9a-f-]{36}$/);
  const id = /\/threat-models\/([0-9a-f-]{36})$/.exec(page.url())?.[1] ?? '';
  await expect(page.getByRole('heading', { name: 'Demo Threat Model' })).toBeVisible();
  await expect(leftOut(page).getByRole('heading', { name: 'Trust boundary lines (not imported)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Imported', exact: true })).toHaveCount(0);
  await leftOut(page).getByRole('button', { name: 'Dismiss' }).click();
  await expect(leftOut(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Demo Threat Model' })).toBeFocused();

  // The threats are on the model, as manual ones, and the Threats view lists them.
  const threats = (await apiRequest(base, token, 'GET', `/api/v1/threat-models/${id}/threats`)).body as { origin: string }[];
  expect(threats).toHaveLength(14);
  expect(new Set(threats.map((threat) => threat.origin))).toEqual(new Set(['manual']));
  await expect(page.getByRole('region', { name: 'Threat summary' })).toBeVisible();
});

test('imports a Threat Dragon file with two diagrams as two threat models, renamed in the preview (US3, FR-013a)', async ({ page, baseURL }, testInfo) => {
  const base = baseURL ?? '';
  const token = await apiToken(base);
  const target = await seedModel(base, token, 'td-two');
  await signInAsNewAccount(page, base);

  const cms = JSON.parse(readFileSync(demoPath('generic-cms.json'), 'utf8')) as { summary: Record<string, unknown>; detail: { diagrams: Record<string, unknown>[] } };
  const stamp = randomUUID().slice(0, 8);
  const twoDiagrams = {
    ...cms,
    summary: { ...cms.summary, title: `Shop ${stamp}` },
    detail: { ...cms.detail, diagrams: [{ ...cms.detail.diagrams[0], title: 'Web' }, { ...cms.detail.diagrams[0], title: 'Batch' }] },
  };
  const file = testInfo.outputPath('two-diagrams.json');
  writeFileSync(file, JSON.stringify(twoDiagrams));

  await importFile(page, target.projectId, file);
  await expect(page.getByLabel('Name of threat model 1')).toHaveValue(`Shop ${stamp} – Web`);
  await expect(page.getByLabel('Name of threat model 2')).toHaveValue(`Shop ${stamp} – Batch`);
  await page.getByLabel('Name of threat model 2').fill(`Shop ${stamp} – Overnight batch`);
  await page.getByRole('button', { name: 'Import', exact: true }).click();

  // Several models: the user stays on the project page. The file left things out, so the result says what, and links to each
  // model; Done closes it, and the page lists both.
  await expect(page.getByRole('heading', { name: 'Imported', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: `Open Shop ${stamp} – Web` })).toBeVisible();
  await expect(page.getByRole('link', { name: `Open Shop ${stamp} – Overnight batch` })).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Imported 2 threat models.')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${target.projectId}$`));
  await expect(page.getByRole('link', { name: `Shop ${stamp} – Web` })).toBeVisible();
  await expect(page.getByRole('link', { name: `Shop ${stamp} – Overnight batch` })).toBeVisible();
  await expect(page.getByRole('link', { name: `Shop ${stamp} – Batch`, exact: true })).toHaveCount(0);
});

// ---- US4: what an import did ----

async function chooseFile(page: Page, projectId: string, path: string): Promise<void> {
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('button', { name: 'Import threat model' }).click();
  await page.getByLabel('File to import').setInputFiles(path);
}

const READS = 'Scrylux imports Scrylux files (version 1), OTM 0.2.0 files in JSON, and Threat Dragon version 2 files.';

test('refuses a file that cannot be imported, saying why, and leaves nothing behind (US4, SC-004)', async ({ page, baseURL }, testInfo) => {
  const base = baseURL ?? '';
  const token = await apiToken(base);
  const target = await seedModel(base, token, 'refused-target');
  await signInAsNewAccount(page, base);
  const models = async () => ((await apiRequest(base, token, 'GET', `/api/v1/projects/${target.projectId}/threat-models`)).body as unknown[]).length;
  const before = await models();
  const imports: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/imports')) imports.push(request.url());
  });

  // 1. A broken reference: a flow whose source is not in the file. The check names the rule and its place. The file is
  // written here, not taken from the app, so nothing the server sent is written to disk.
  const element = (id: string, type: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    type,
    name,
    properties: {},
    layout: null,
    parent_boundary_id: null,
    source_element_id: null,
    target_element_id: null,
    ...extra,
  });
  const flow = 2;
  const brokenFile = {
    format: 'scrylux',
    format_version: 1,
    exported_at: '2026-10-10T09:30:00.000Z',
    project: { name: 'Payments' },
    threat_model: { name: 'Broken reference', methodology: 'STRIDE', status: 'draft' },
    elements: [
      element('e-browser', 'external_entity', 'Browser'),
      element('p-api', 'process', 'API'),
      element('f-request', 'data_flow', 'Request', { source_element_id: 'nobody', target_element_id: 'p-api' }),
    ],
    threats: [],
    mitigations: [],
  };
  const broken = testInfo.outputPath('broken.json');
  writeFileSync(broken, JSON.stringify(brokenFile));
  await chooseFile(page, target.projectId, broken);
  await expect(page.getByText("This file can't be imported")).toBeVisible();
  await expect(page.getByText(`file.elements.${flow}.source_element_id: must refer to an external entity, process or data store in this file`)).toBeVisible();
  await page.getByRole('button', { name: 'Choose another file' }).click();
  await expect(page.getByLabel('File to import')).toBeVisible();

  // 2. Too large: refused on the spot, with nothing sent for it.
  const huge = testInfo.outputPath('huge.json');
  writeFileSync(huge, Buffer.alloc(64 * 1024 * 1024 + 1, 0x20));
  const sentBefore = imports.length;
  await page.getByLabel('File to import').setInputFiles(huge);
  await expect(page.getByText('This file is larger than 64 MiB, the most Scrylux can import.')).toBeVisible();
  expect(imports).toHaveLength(sentBefore);

  // 3. A file that is JSON but not in a format Scrylux reads, and one that is not JSON at all.
  const unknown = testInfo.outputPath('unknown.json');
  writeFileSync(unknown, JSON.stringify({ hello: 1 }));
  await page.getByLabel('File to import').setInputFiles(unknown);
  await expect(page.getByText(`This file isn't in a format Scrylux reads. ${READS}`)).toBeVisible();
  const notJson = testInfo.outputPath('notjson.json');
  writeFileSync(notJson, 'this is not json');
  await page.getByLabel('File to import').setInputFiles(notJson);
  await expect(page.getByText(`This file isn't JSON. ${READS}`)).toBeVisible();

  // None of the four created anything.
  expect(await models()).toBe(before);
});

test('lists, by kind, what a Threat Dragon import leaves out, and imports the rest (US4, SC-003)', async ({ page, baseURL }) => {
  const base = baseURL ?? '';
  const token = await apiToken(base);
  const target = await seedModel(base, token, 'td-notes');
  await signInAsNewAccount(page, base);

  await chooseFile(page, target.projectId, demoPath('iot-device.json'));
  await expect(page.getByRole('heading', { name: 'Ready to import' })).toBeVisible();
  // The boundary line and the text block of the diagram, each under its heading, with its place in the file.
  const lines = page.getByRole('heading', { name: 'Trust boundary lines (not imported)' }).locator('xpath=..');
  await expect(lines.locator('code')).toHaveCount(1);
  await expect(lines.locator('code')).toContainText('file.detail.diagrams.0.cells.');
  await expect(page.getByRole('heading', { name: 'Text blocks (not imported)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Items with no name (given a placeholder name)' })).toBeVisible();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  // The model opens, with the same list after the import, which a reload does not bring back.
  await expect(leftOut(page).getByRole('heading', { name: 'Trust boundary lines (not imported)' })).toBeVisible();
  await expect(leftOut(page).getByRole('heading', { name: 'Text blocks (not imported)' })).toBeVisible();
  await expectLeftOutOnlyOnce(page, 'Internet of Things (IoT) Device');
});

test('lists the threats of a CIA diagram one by one, and imports its diagram (US4)', async ({ page, baseURL }) => {
  const base = baseURL ?? '';
  const token = await apiToken(base);
  const target = await seedModel(base, token, 'td-cia');
  await signInAsNewAccount(page, base);

  await chooseFile(page, target.projectId, demoPath('cryptocurrency-wallet.json'));
  await expect(page.getByRole('heading', { name: 'Ready to import' })).toBeVisible();
  await expect(page.getByText(/33 elements, 0 threats, 0 mitigations/)).toBeVisible();
  const group = page.getByRole('heading', { name: 'Threats with no STRIDE category (not imported)' }).locator('xpath=..');
  await expect(group.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(leftOut(page).getByRole('heading', { name: 'Threats with no STRIDE category (not imported)' })).toBeVisible();
  await expectLeftOutOnlyOnce(page, 'Cryptocurrency Wallet');
});
