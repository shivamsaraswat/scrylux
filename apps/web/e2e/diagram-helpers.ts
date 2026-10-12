import type { Locator, Page } from '@playwright/test';
import { apiRequest, expect } from './fixtures.js';

// Shared by the diagram specs: reading the diagram, and gestures that check their own effect.

export interface Stored {
  id: string;
  type: string;
  name: string;
  layout: { x: number; y: number } | null;
  source_element_id: string | null;
  target_element_id: string | null;
  parent_boundary_id: string | null;
}

export const elementsOf = async (base: string, token: string, modelId: string): Promise<Stored[]> =>
  (await apiRequest(base, token, 'GET', `/api/v1/threat-models/${modelId}/elements`)).body as Stored[];

export const canvasOf = (page: Page) => page.getByRole('application', { name: 'Data-flow diagram' });
// Found by its label, not by all of its text: a node with open threats also carries the count (Phase 2 M4).
export const nodeOf = (page: Page, name: string) =>
  canvasOf(page)
    .locator('.react-flow__node')
    .filter({ has: page.locator('.diagram-node__label, .diagram-boundary__label', { hasText: new RegExp(`^${name}$`) }) });

// A node's position on the diagram itself, which does not change with panning or zooming.
export async function positionOnDiagram(node: Locator): Promise<{ x: number; y: number }> {
  return node.evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: Math.round(matrix.m41), y: Math.round(matrix.m42) };
  });
}

export async function centerOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Element has no box on screen');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// Pointer gestures on a busy machine are sometimes missed, as they can be for a person. Each helper below
// checks the effect it should have had and tries again if it did not, which is what a person would do. The
// assertions about what is stored are never retried.
export const GESTURE = { timeout: 20_000, intervals: [100, 300] };

// Drags a node or a boundary's label by (dx, dy) on the screen. A retry aims at the same end point, so a
// gesture that half worked does not move it twice. By default the drag has worked if the node ended up near
// its target. A test where the drag is undone on purpose (a save the server refuses) passes `effect`, which
// says instead what must have happened, and is the only check made.
export async function dragBy(page: Page, node: Locator, dx: number, dy: number, effect?: () => Promise<void>): Promise<void> {
  const handle = node.locator('.diagram-node__label, .diagram-boundary__label');
  await canvasOf(page).scrollIntoViewIfNeeded();
  const origin = await centerOf(handle);
  const target = { x: origin.x + dx, y: origin.y + dy };
  const near = Math.max(12, Math.hypot(dx, dy) * 0.3);
  await expect(async () => {
    const from = await centerOf(handle);
    if (!effect && Math.hypot(from.x - target.x, from.y - target.y) < near) return;
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + target.x) / 2, (from.y + target.y) / 2, { steps: 5 });
    await page.mouse.move(target.x, target.y, { steps: 5 });
    await page.mouse.up();
    if (effect) return effect();
    // It clearly moved toward the target. How exactly it lands is what the stored positions then assert.
    const now = await centerOf(handle);
    expect(Math.hypot(now.x - target.x, now.y - target.y)).toBeLessThan(near);
  }).toPass(GESTURE);
}

// Drags a node so that its middle ends at a point on the screen, trying again if it did not get there.
export async function dropNodeAt(page: Page, node: Locator, target: { x: number; y: number }): Promise<void> {
  const handle = node.locator('.diagram-node__label');
  await canvasOf(page).scrollIntoViewIfNeeded();
  await expect(async () => {
    const from = await centerOf(handle);
    if (Math.hypot(from.x - target.x, from.y - target.y) < 20) return;
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + target.x) / 2, (from.y + target.y) / 2, { steps: 6 });
    await page.mouse.move(target.x, target.y, { steps: 6 });
    await page.mouse.up();
    const now = await centerOf(handle);
    expect(Math.hypot(now.x - target.x, now.y - target.y)).toBeLessThan(20);
  }).toPass(GESTURE);
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const boxOf = async (locator: Locator): Promise<Box> => {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Element has no box on screen');
  return box;
};

// The view fits itself to the diagram once the nodes are measured, which is just after they first show.
// Waiting for a node to hold still means the next drag starts where the node really is.
export async function untilStill(node: Locator): Promise<void> {
  let last = '';
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await node.boundingBox());
        const same = now === last;
        last = now;
        return same;
      },
      { intervals: [200] },
    )
    .toBe(true);
}

export const stored = async (base: string, token: string, modelId: string) => {
  const list = await elementsOf(base, token, modelId);
  return { list, byName: new Map(list.map((e) => [e.name, e])), byId: new Map(list.map((e) => [e.id, e])) };
};


// Everything the user has done is on the server: no change is waiting or on its way. The editor says so
// itself, and reading stored state before it does can catch an action halfway.
export async function untilSaved(page: Page): Promise<void> {
  await expect(page.getByText('All changes saved')).toBeVisible();
}

// Draws a flow from one node to another, and names it. The new flow is selected with its name focused.
export async function connect(page: Page, from: string, to: string, name: string): Promise<void> {
  const edges = canvasOf(page).locator('.react-flow__edge');
  const before = await edges.count();
  await expect(async () => {
    // An earlier attempt may have worked after all.
    if ((await edges.count()) > before) return;
    await canvasOf(page).scrollIntoViewIfNeeded();
    const start = await centerOf(nodeOf(page, from).locator('.react-flow__handle[data-handleid="right"]'));
    const end = await centerOf(nodeOf(page, to).locator('.react-flow__handle[data-handleid="left"]'));
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 6 });
    await page.mouse.move(end.x, end.y, { steps: 6 });
    await page.mouse.up();
    await expect(edges).toHaveCount(before + 1, { timeout: 1500 });
  }).toPass(GESTURE);
  // The new flow, and not the one before it, is the selection before its name is typed.
  await expect(page.getByLabel('Name')).toHaveValue('New data flow');
  await page.getByLabel('Name').fill(name);
  await page.keyboard.press('Enter');
  // The flow is drawn, with its name, before the next gesture counts edges from.
  await expect(canvasOf(page).locator('.react-flow__edge-text', { hasText: name })).toBeVisible();
}

export async function addNode(page: Page, button: string, name: string): Promise<void> {
  const defaultName = button.replace('Add ', 'New ');
  await page.getByRole('button', { name: button }).click();
  // The new element, and not the one before it, is the selection before its name is typed.
  await expect(page.getByLabel('Name')).toHaveValue(defaultName);
  await page.getByLabel('Name').fill(name);
  await page.keyboard.press('Enter');
  await expect(nodeOf(page, name)).toBeVisible();
}


// Deletes an element chosen from the Elements list, with the keyboard: choose it, check that the selection and the
// focus have both arrived on the canvas (the Delete key only reaches the editor from there), press Delete. A gesture
// that missed is done again, as a person would.
export async function deleteFromList(page: Page, rowName: string, name: string): Promise<void> {
  const row = page.getByRole('navigation', { name: 'Elements' }).getByRole('button', { name: rowName });
  await expect(async () => {
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Name')).toHaveValue(name, { timeout: 1500 });
    await expect(canvasOf(page).locator('.react-flow__edge:focus, .react-flow__node:focus')).toHaveCount(1, { timeout: 1500 });
    await page.keyboard.press('Delete');
    await expect(row).toBeHidden({ timeout: 3000 });
  }).toPass(GESTURE);
}
