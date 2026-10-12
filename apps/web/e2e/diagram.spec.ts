import type { Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { GESTURE, addNode, boxOf, canvasOf, connect, centerOf, dragBy, dropNodeAt, elementsOf, nodeOf, positionOnDiagram, stored, untilSaved, untilStill, type Stored } from './diagram-helpers.js';
import { apiRequest, apiToken, expect, seedElements, seedModel, signInAsNewAccount, test } from './fixtures.js';

// The canvas sits below the threat model's header, so a window of the usual height shows only part of it.
// A taller window, and scrolling it into view before each drag, keep the pointer on screen.
test.use({ viewport: { width: 1400, height: 1100 } });

// The diagram editor in a real browser against the built app and a real database (quickstart §1, §2).
// What is asserted after a reload is what the server stored, read back through the API as well as
// from the screen.

test('draws a diagram, and it is there after a reload', async ({ page, baseURL }) => {
  const base = baseURL ?? '';
  const token = await apiToken(base);
  const { modelId } = await seedModel(base, token, 'draw');
  await signInAsNewAccount(page, base);
  await page.goto(`/threat-models/${modelId}/diagram`);

  // An empty diagram, with a way to add each kind of element (US1 scenario 1).
  await expect(canvasOf(page)).toBeVisible();
  await expect(canvasOf(page).locator('.react-flow__node')).toHaveCount(0);
  for (const name of ['Add external entity', 'Add process', 'Add data store']) {
    await expect(page.getByRole('button', { name })).toBeEnabled();
  }

  await addNode(page, 'Add external entity', 'Customer');
  await addNode(page, 'Add external entity', 'Partner');
  await addNode(page, 'Add process', 'Web');
  await addNode(page, 'Add process', 'Worker');
  await addNode(page, 'Add data store', 'DB');

  // A connection let go on empty space makes nothing, and says why (FR-003). The view fits itself to the new
  // nodes first, and the handle is only where it seems to be once they have stopped moving.
  await untilStill(nodeOf(page, 'DB'));
  await untilStill(nodeOf(page, 'Customer'));
  await expect(async () => {
    await canvasOf(page).scrollIntoViewIfNeeded();
    const start = await centerOf(nodeOf(page, 'Customer').locator('.react-flow__handle[data-handleid="top"]'));
    const canvasBox = await boxOf(canvasOf(page));
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    // Empty canvas, clear of the edge: near the edge the view scrolls as you hold a connection there, which
    // can slide an element under the pointer. The elements are in the middle, so this corner is empty.
    await page.mouse.move(canvasBox.x + 90, canvasBox.y + 90, { steps: 12 });
    await page.mouse.up();
    await expect(page.getByRole('alert')).toContainText('A data flow must connect two different external entities, processes or data stores.', { timeout: 3000 });
  }).toPass(GESTURE);
  // Fit to view brings every element back into view (FR-005).
  await page.getByRole('button', { name: 'Fit to view' }).click();

  await connect(page, 'Customer', 'Web', 'HTTPS');
  await connect(page, 'Partner', 'Web', 'Webhook');
  await connect(page, 'Web', 'Worker', 'Job');
  await connect(page, 'Worker', 'DB', 'SQL');

  await dragBy(page, nodeOf(page, 'Customer'), 0, 140);
  await dragBy(page, nodeOf(page, 'DB'), 160, 60);
  await dragBy(page, nodeOf(page, 'Partner'), -120, -60);

  // Worker becomes a data store; its name and its flows stay.
  await nodeOf(page, 'Worker').locator('.diagram-node__label').click();
  await expect(page.getByLabel('Name')).toHaveValue('Worker');
  await page.getByLabel('Type').selectOption('data_store');

  // Saves are queued, so the server catches up shortly after the last action.
  const summary = async () => {
    const stored = await elementsOf(base, token, modelId);
    return Object.fromEntries(stored.map((e) => [e.name, `${e.type}${e.type === 'data_flow' ? '' : e.layout ? ' placed' : ' UNPLACED'}`]));
  };
  // About twenty-five saves go one after another, so under load this takes a while; what matters is that
  // all of it arrives, in the end, and none is lost.
  await expect
    .poll(summary, { timeout: 30_000 })
    .toEqual({
      Customer: 'external_entity placed',
      Partner: 'external_entity placed',
      Web: 'process placed',
      Worker: 'data_store placed',
      DB: 'data_store placed',
      HTTPS: 'data_flow',
      Webhook: 'data_flow',
      Job: 'data_flow',
      SQL: 'data_flow',
    });

  const before = await elementsOf(base, token, modelId);
  const byName = new Map(before.map((e) => [e.name, e]));
  const idOf = (name: string) => byName.get(name)?.id;
  expect(byName.get('HTTPS')).toMatchObject({ source_element_id: idOf('Customer'), target_element_id: idOf('Web') });
  expect(byName.get('Webhook')).toMatchObject({ source_element_id: idOf('Partner'), target_element_id: idOf('Web') });
  expect(byName.get('Job')).toMatchObject({ source_element_id: idOf('Web'), target_element_id: idOf('Worker') });
  expect(byName.get('SQL')).toMatchObject({ source_element_id: idOf('Worker'), target_element_id: idOf('DB') });

  await page.reload();
  await expect(canvasOf(page)).toBeVisible();

  // After the reload, every node is where the server says it is, and the flows are all drawn.
  for (const element of before.filter((e) => e.type !== 'data_flow')) {
    const node = nodeOf(page, element.name);
    await expect(node).toBeVisible();
    expect(await positionOnDiagram(node), `${element.name} position`).toEqual(element.layout);
  }
  await expect(canvasOf(page).locator('.react-flow__edge')).toHaveCount(4);
  for (const label of ['HTTPS', 'Webhook', 'Job', 'SQL']) {
    await expect(canvasOf(page).locator('.react-flow__edge-text', { hasText: label })).toBeVisible();
  }
  expect(await elementsOf(base, token, modelId)).toEqual(before);
});

// A stored element's position on the diagram itself: its own plus those of the boundaries around it.
function absoluteOf(element: Stored, byId: Map<string, Stored>): { x: number; y: number } {
  let { x, y } = element.layout ?? { x: 0, y: 0 };
  for (let parent = element.parent_boundary_id; parent; parent = byId.get(parent)?.parent_boundary_id ?? null) {
    const at = byId.get(parent)?.layout;
    x += at?.x ?? 0;
    y += at?.y ?? 0;
  }
  return { x, y };
}

test('nests trust boundaries, and a boundary carries what it holds', async ({ page, baseURL }) => {
  const base = baseURL ?? '';
  const token = await apiToken(base);
  const { modelId } = await seedModel(base, token, 'boundaries');
  const id = { vpc: randomUUID(), subnet: randomUUID(), web: randomUUID(), api: randomUUID(), store: randomUUID(), partner: randomUUID() };
  await seedElements(base, token, modelId, [
    { op: 'create', element: { id: id.vpc, type: 'trust_boundary', name: 'VPC', layout: { x: 0, y: 0, width: 700, height: 500 } } },
    // Wholly inside the VPC, but stored with no boundary: it takes its place in the VPC when first moved.
    { op: 'create', element: { id: id.subnet, type: 'trust_boundary', name: 'Subnet', layout: { x: 360, y: 260, width: 260, height: 200 } } },
    { op: 'create', element: { id: id.web, type: 'process', name: 'Web', layout: { x: 1000, y: 40 } } },
    { op: 'create', element: { id: id.api, type: 'process', name: 'API', layout: { x: 1000, y: 160 } } },
    { op: 'create', element: { id: id.store, type: 'data_store', name: 'Store', layout: { x: 1000, y: 300 } } },
    { op: 'create', element: { id: id.partner, type: 'external_entity', name: 'Partner', layout: { x: 1000, y: 460 } } },
    { op: 'create', element: { type: 'data_flow', name: 'Calls', source_element_id: id.api, target_element_id: id.partner } },
  ]);

  await signInAsNewAccount(page, base);
  await page.goto(`/threat-models/${modelId}/diagram`);
  await expect(nodeOf(page, 'VPC')).toBeVisible();
  await canvasOf(page).scrollIntoViewIfNeeded();
  await untilStill(nodeOf(page, 'VPC'));

  // The subnet is nudged: it is wholly inside the VPC, so it becomes a member (US2 scenario 3).
  await dragBy(page, nodeOf(page, 'Subnet'), 12, 12);
  await expect.poll(async () => (await stored(base, token, modelId)).byName.get('Subnet')?.parent_boundary_id).toBe(id.vpc);

  // Web and API are dropped into the VPC (scenario 2), and the store into the subnet inside it.
  const vpc = await boxOf(nodeOf(page, 'VPC'));
  await dropNodeAt(page, nodeOf(page, 'Web'), { x: vpc.x + vpc.width * 0.22, y: vpc.y + vpc.height * 0.2 });
  await dropNodeAt(page, nodeOf(page, 'API'), { x: vpc.x + vpc.width * 0.22, y: vpc.y + vpc.height * 0.5 });
  const subnet = await boxOf(nodeOf(page, 'Subnet'));
  await dropNodeAt(page, nodeOf(page, 'Store'), { x: subnet.x + subnet.width / 2, y: subnet.y + subnet.height / 2 });
  await expect
    .poll(async () => {
      const { byName } = await stored(base, token, modelId);
      return [byName.get('Web')?.parent_boundary_id, byName.get('API')?.parent_boundary_id, byName.get('Store')?.parent_boundary_id];
    })
    .toEqual([id.vpc, id.vpc, id.subnet]);
  await untilSaved(page);

  // The flow from API (in the VPC) to Partner (outside it) is drawn across the VPC's edge (scenario 6).
  const vpcNow = await boxOf(nodeOf(page, 'VPC'));
  const flowBox = await boxOf(canvasOf(page).locator('.react-flow__edge-path').first());
  expect(flowBox.x).toBeLessThan(vpcNow.x + vpcNow.width);
  expect(flowBox.x + flowBox.width).toBeGreaterThan(vpcNow.x + vpcNow.width);

  // Moving the VPC moves what it holds, and saves the VPC alone (scenario 4).
  const before = await stored(base, token, modelId);
  const webOnScreen = await boxOf(nodeOf(page, 'Web'));
  await dragBy(page, nodeOf(page, 'VPC'), 60, 40);
  await expect.poll(async () => (await stored(base, token, modelId)).byName.get('VPC')?.layout).not.toEqual(before.byName.get('VPC')?.layout);
  await untilSaved(page);
  const moved = await stored(base, token, modelId);
  for (const name of ['Web', 'API', 'Subnet', 'Store']) {
    const was = before.byName.get(name);
    const now = moved.byName.get(name);
    expect(
      { layout: now?.layout, parent: now?.parent_boundary_id },
      `${name} keeps its place inside the VPC (was ${JSON.stringify({ layout: was?.layout, parent: was?.parent_boundary_id })})`,
    ).toEqual({ layout: was?.layout, parent: was?.parent_boundary_id });
  }
  const webAfter = await boxOf(nodeOf(page, 'Web'));
  expect(webAfter.x - webOnScreen.x).toBeGreaterThan(20);
  expect(webAfter.y - webOnScreen.y).toBeGreaterThan(10);

  // Shrinking the subnet so the store is outside it hands the store to the VPC (scenario 5).
  await nodeOf(page, 'Subnet').locator('.diagram-boundary__label').click();
  await expect(page.getByLabel('Name')).toHaveValue('Subnet');
  await expect(async () => {
    const corner = await centerOf(nodeOf(page, 'Subnet').locator('.react-flow__resize-control.handle.bottom.right'));
    await page.mouse.move(corner.x, corner.y);
    await page.mouse.down();
    await page.mouse.move(corner.x - 40, corner.y - 30, { steps: 6 });
    await page.mouse.move(corner.x - 110, corner.y - 90, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(async () => (await stored(base, token, modelId)).byName.get('Store')?.parent_boundary_id, { timeout: 2500 })
      .toBe(id.vpc);
  }).toPass(GESTURE);

  // After a reload everything is where the server says, nesting included.
  await untilSaved(page);
  const settled = await stored(base, token, modelId);
  await page.reload();
  await expect(nodeOf(page, 'VPC')).toBeVisible();
  for (const element of settled.list.filter((e) => e.type !== 'data_flow')) {
    expect(await positionOnDiagram(nodeOf(page, element.name)), `${element.name} on the diagram`).toEqual(absoluteOf(element, settled.byId));
  }
  expect((await stored(base, token, modelId)).list).toEqual(settled.list);
});

// One choice of one flag. The name is matched exactly, since "No" is also part of "Not assessed".
const flag = (panel: Locator, group: string, option: 'Yes' | 'No' | 'Not assessed') =>
  panel.getByRole('radiogroup', { name: group }).getByRole('radio', { name: option, exact: true });

test('sets tags and flags, and they are there after a reload', async ({ page, baseURL }) => {
  const base = baseURL ?? '';
  const token = await apiToken(base);
  const { modelId } = await seedModel(base, token, 'properties');
  const id = { db: randomUUID(), api: randomUUID(), tls: randomUUID() };
  await seedElements(base, token, modelId, [
    { op: 'create', element: { id: id.api, type: 'process', name: 'API', layout: { x: 0, y: 0 } } },
    { op: 'create', element: { id: id.db, type: 'data_store', name: 'Database', layout: { x: 400, y: 0 } } },
    { op: 'create', element: { id: id.tls, type: 'data_flow', name: 'Queries', source_element_id: id.api, target_element_id: id.db } },
  ]);
  await signInAsNewAccount(page, base);
  await page.goto(`/threat-models/${modelId}/diagram`);
  await untilStill(nodeOf(page, 'Database'));
  const panel = page.getByRole('complementary', { name: 'Properties' });
  const propertiesOf = async (name: string) => (await stored(base, token, modelId)).byName.get(name) as (Stored & { properties: unknown }) | undefined;

  // A data store: two flags set, one left alone, and a tag.
  await nodeOf(page, 'Database').locator('.diagram-node__label').click();
  await expect(page.getByLabel('Name')).toHaveValue('Database');
  await flag(panel, 'Stores sensitive data', 'Yes').check();
  await flag(panel, 'Encrypted at rest', 'No').check();
  await panel.getByLabel('Add a technology tag').fill('PostgreSQL 16');
  await panel.getByRole('button', { name: 'Add tag' }).click();

  // A data flow, selected by clicking on its line. Its hit area is a stroke of a path with no height, which
  // Playwright counts as not visible, so the click is aimed at the middle of the line itself.
  await canvasOf(page).scrollIntoViewIfNeeded();
  const line = await boxOf(canvasOf(page).locator('.react-flow__edge').filter({ hasText: 'Queries' }).locator('.react-flow__edge-interaction'));
  await page.mouse.click(line.x + line.width / 2, line.y + line.height / 2);
  await expect(page.getByLabel('Name')).toHaveValue('Queries');
  await flag(panel, 'Encrypted in transit', 'Yes').check();

  // "No" is stored as false, and a flag left alone is not stored at all (FR-015a).
  await expect.poll(async () => (await propertiesOf('Database'))?.properties).toEqual({
    tags: ['PostgreSQL 16'],
    flags: { stores_sensitive_data: true, encrypted_at_rest: false },
  });
  await expect.poll(async () => (await propertiesOf('Queries'))?.properties).toEqual({ flags: { encrypted_in_transit: true } });
  expect(Object.hasOwn(((await propertiesOf('Database'))?.properties as { flags: object }).flags, 'internet_facing')).toBe(false);

  await page.reload();
  await untilStill(nodeOf(page, 'Database'));
  await nodeOf(page, 'Database').locator('.diagram-node__label').click();
  await expect(page.getByLabel('Name')).toHaveValue('Database');
  await expect(flag(panel, 'Stores sensitive data', 'Yes')).toBeChecked();
  await expect(flag(panel, 'Encrypted at rest', 'No')).toBeChecked();
  await expect(flag(panel, 'Internet facing', 'Not assessed')).toBeChecked();
  await expect(panel.getByText('PostgreSQL 16')).toBeVisible();

  // Making it a process asks first, because "Stores sensitive data" and "Encrypted at rest" do not apply to
  // one, and says which flags would go.
  await panel.getByLabel('Type').selectOption('process');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Stores sensitive data');
  await expect(dialog).toContainText('Encrypted at rest');
  await dialog.getByRole('button', { name: 'Change type' }).click();
  await expect.poll(async () => (await propertiesOf('Database'))?.properties).toEqual({ tags: ['PostgreSQL 16'] });
  await expect.poll(async () => (await propertiesOf('Database'))?.type).toBe('process');
});

test('deletes safely: flows go with their node after a question, linked threats stop it, boundaries keep what they hold', async ({ page, baseURL }) => {
  const base = baseURL ?? '';
  const token = await apiToken(base);
  const { modelId } = await seedModel(base, token, 'deleting');
  const id = { outer: randomUUID(), inner: randomUUID(), worker: randomUUID(), hub: randomUUID(), cache: randomUUID(), client: randomUUID() };
  await seedElements(base, token, modelId, [
    { op: 'create', element: { id: id.outer, type: 'trust_boundary', name: 'Outer', layout: { x: 0, y: 0, width: 640, height: 420 } } },
    { op: 'create', element: { id: id.inner, type: 'trust_boundary', name: 'Inner', parent_boundary_id: id.outer, layout: { x: 40, y: 60, width: 320, height: 240 } } },
    { op: 'create', element: { id: id.worker, type: 'process', name: 'Worker', parent_boundary_id: id.inner, layout: { x: 60, y: 80 } } },
    { op: 'create', element: { id: id.hub, type: 'process', name: 'Hub', layout: { x: 800, y: 40 } } },
    { op: 'create', element: { id: id.cache, type: 'data_store', name: 'Cache', layout: { x: 800, y: 220 } } },
    { op: 'create', element: { id: id.client, type: 'external_entity', name: 'Client', layout: { x: 800, y: 400 } } },
    { op: 'create', element: { type: 'data_flow', name: 'Reads', source_element_id: id.hub, target_element_id: id.cache } },
    { op: 'create', element: { type: 'data_flow', name: 'Calls', source_element_id: id.client, target_element_id: id.hub } },
  ]);
  const made = await apiRequest(base, token, 'POST', '/api/v1/threats', {
    threat_model_id: modelId,
    element_id: id.cache,
    category: 'Tampering',
    title: 'Cache poisoning',
    likelihood: 'High',
    impact: 'High',
    origin: 'manual',
  });
  expect(made.status).toBe(201);

  await signInAsNewAccount(page, base);
  await page.goto(`/threat-models/${modelId}/diagram`);
  await untilStill(nodeOf(page, 'Cache'));
  const dialog = page.getByRole('dialog');
  const panel = page.getByRole('complementary', { name: 'Properties' });
  const select = async (name: string) => {
    await canvasOf(page).scrollIntoViewIfNeeded();
    await nodeOf(page, name).locator('.diagram-node__label').click();
    await expect(page.getByLabel('Name')).toHaveValue(name);
  };

  // A threat is linked to the cache: the delete is refused, the threat is named, and nothing is sent (scenario 3).
  await select('Cache');
  await panel.getByRole('button', { name: 'Delete element' }).click();
  await expect(dialog).toContainText("This element can't be deleted yet");
  await expect(dialog).toContainText('Cache poisoning');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await expect(nodeOf(page, 'Cache')).toBeVisible();
  expect((await stored(base, token, modelId)).byName.has('Cache')).toBe(true);

  // The hub has two flows: the question says so, and Cancel changes nothing (scenario 1).
  await select('Hub');
  await panel.getByRole('button', { name: 'Delete element' }).click();
  await expect(dialog).toContainText('Delete Hub and its 2 data flows?');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(nodeOf(page, 'Hub')).toBeVisible();
  expect((await stored(base, token, modelId)).byName.has('Hub')).toBe(true);

  await panel.getByRole('button', { name: 'Delete element' }).click();
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(nodeOf(page, 'Hub')).toBeHidden();
  await expect(canvasOf(page).locator('.react-flow__edge')).toHaveCount(0);
  await untilSaved(page);
  const afterHub = await stored(base, token, modelId);
  expect([afterHub.byName.has('Hub'), afterHub.byName.has('Reads'), afterHub.byName.has('Calls')]).toEqual([false, false, false]);
  // The threat is not touched, and neither is the cache it is linked to.
  expect(afterHub.byName.has('Cache')).toBe(true);

  // Deleting the inner boundary keeps the worker where it is on the diagram, now inside the outer one (scenario 2).
  const workerBefore = await positionOnDiagram(nodeOf(page, 'Worker'));
  await canvasOf(page).scrollIntoViewIfNeeded();
  await nodeOf(page, 'Inner').locator('.diagram-boundary__label').click();
  await expect(page.getByLabel('Name')).toHaveValue('Inner');
  await panel.getByRole('button', { name: 'Delete element' }).click();
  await expect(dialog).toBeHidden();
  await expect(nodeOf(page, 'Inner')).toBeHidden();
  await untilSaved(page);
  const afterInner = await stored(base, token, modelId);
  expect(afterInner.byName.has('Inner')).toBe(false);
  expect(afterInner.byName.get('Worker')?.parent_boundary_id).toBe(id.outer);
  expect(await positionOnDiagram(nodeOf(page, 'Worker'))).toEqual(workerBefore);

  // After a reload the diagram is what the server holds, and the worker has not moved.
  await page.reload();
  await untilStill(nodeOf(page, 'Worker'));
  expect(await positionOnDiagram(nodeOf(page, 'Worker'))).toEqual(workerBefore);
  expect((await stored(base, token, modelId)).list).toEqual(afterInner.list);
});
