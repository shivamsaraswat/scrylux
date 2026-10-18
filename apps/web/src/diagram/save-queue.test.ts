import type { ElementRecord } from '@scrylux/core';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors.js';
import { applyActions } from './operations.js';
import { SaveQueue, type SaveStatus } from './save-queue.js';
import type { DiagramAction } from './operations.js';

const MODEL = '33333333-3333-4333-8333-333333333333';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const move = (target: string, x: number): DiagramAction => ({
  label: `Move ${target}`,
  ops: [{ op: 'update', id: target, changes: { layout: { x, y: 0 } } }],
});

// A send function whose response the test releases by hand.
function manualSend() {
  const calls: { ops: unknown[]; resolve: () => void; reject: (err: unknown) => void }[] = [];
  const send = vi.fn(
    (ops: unknown[]) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ ops, resolve, reject });
      }),
  );
  return { send, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('SaveQueue, the success path (FR-019, FR-020, research #8)', () => {
  it('sends one batch request per action, with exactly that action’s operations', async () => {
    const { send, calls } = manualSend();
    const queue = new SaveQueue(send);

    const action = move(id(1), 10);
    queue.enqueue(action);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(action.ops);
    calls[0]?.resolve();
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends one request at a time, in order: a later action waits for the one in flight', async () => {
    const { send, calls } = manualSend();
    const queue = new SaveQueue(send);

    queue.enqueue(move(id(1), 1));
    queue.enqueue(move(id(2), 2));
    queue.enqueue(move(id(3), 3));
    expect(send).toHaveBeenCalledTimes(1);

    calls[0]?.resolve();
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toEqual([{ op: 'update', id: id(2), changes: { layout: { x: 2, y: 0 } } }]);

    calls[1]?.resolve();
    await flush();
    expect(send).toHaveBeenCalledTimes(3);
    calls[2]?.resolve();
    await flush();
    expect(queue.pendingCount()).toBe(0);
  });

  it('goes saving, then saved, and tells its subscribers', async () => {
    const { send, calls } = manualSend();
    const queue = new SaveQueue(send);
    const seen: SaveStatus[] = [queue.getSnapshot().status];
    queue.subscribe(() => seen.push(queue.getSnapshot().status));

    expect(queue.getSnapshot().status).toBe('saved');
    queue.enqueue(move(id(1), 1));
    expect(queue.getSnapshot().status).toBe('saving');
    expect(queue.pendingCount()).toBe(1);

    calls[0]?.resolve();
    await flush();
    expect(queue.getSnapshot().status).toBe('saved');
    expect(queue.pendingCount()).toBe(0);
    expect(seen).toContain('saving');
    expect(seen.at(-1)).toBe('saved');
  });

  it('keeps an action pending while it is in flight, so the screen still shows it', async () => {
    const { send, calls } = manualSend();
    const queue = new SaveQueue(send);
    queue.enqueue(move(id(1), 1));
    expect(queue.getSnapshot().pending.map((a) => a.label)).toEqual([`Move ${id(1)}`]);
    calls[0]?.resolve();
    await flush();
    expect(queue.getSnapshot().pending).toEqual([]);
  });

  it('stops at a failure and keeps the action and the ones behind it', async () => {
    const { send, calls } = manualSend();
    const queue = new SaveQueue(send);
    queue.enqueue(move(id(1), 1));
    queue.enqueue(move(id(2), 2));

    calls[0]?.reject(new Error('network down'));
    await flush();
    expect(queue.getSnapshot().status).toBe('failed');
    expect(queue.pendingCount()).toBe(2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retry resends the same request, then carries on with the rest', async () => {
    const { send, calls } = manualSend();
    const queue = new SaveQueue(send);
    queue.enqueue(move(id(1), 1));
    queue.enqueue(move(id(2), 2));
    calls[0]?.reject(new Error('network down'));
    await flush();

    queue.retry();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toEqual(send.mock.calls[0]?.[0]);
    calls[1]?.resolve();
    await flush();
    calls[2]?.resolve();
    await flush();
    expect(queue.getSnapshot().status).toBe('saved');
    expect(queue.pendingCount()).toBe(0);
  });
});

describe('the working copy is the server state with the queued actions on top (FR-020)', () => {
  const record = (n: number, overrides: Partial<ElementRecord> = {}): ElementRecord => ({
    id: id(n),
    threat_model_id: MODEL,
    type: 'process',
    name: `Element ${n}`,
    properties: {},
    layout: { x: 0, y: 0 },
    source_element_id: null,
    target_element_id: null,
    parent_boundary_id: null,
    created_at: '2026-10-07T10:00:00.000Z',
    updated_at: '2026-10-07T10:00:00.000Z',
    ...overrides,
  });

  it('shows a queued create and a queued update over the data the server just sent', () => {
    const fresh = [record(1)];
    const queued: DiagramAction[] = [
      { label: 'Add process', ops: [{ op: 'create', element: { id: id(2), type: 'process', name: 'New process' } }] },
      { label: 'Rename', ops: [{ op: 'update', id: id(1), changes: { name: 'Renamed' } }] },
    ];

    const working = applyActions(MODEL, fresh, queued);
    expect(working.map((e) => e.name)).toEqual(['Renamed', 'New process']);
    expect(working[1]).toMatchObject({ id: id(2), threat_model_id: MODEL, properties: {}, layout: null, parent_boundary_id: null });
  });

  it('applies an action again without harm once the server already has it', () => {
    const queued: DiagramAction[] = [
      { label: 'Add', ops: [{ op: 'create', element: { id: id(2), type: 'process', name: 'New process' } }] },
    ];
    const once = applyActions(MODEL, [record(1)], queued);
    const twice = applyActions(MODEL, once, queued);
    expect(twice.map((e) => e.id)).toEqual(once.map((e) => e.id));
  });

  it('leaves the server data alone when nothing is queued', () => {
    const fresh = [record(1), record(2)];
    expect(applyActions(MODEL, fresh, [])).toEqual(fresh);
  });
});

// ---- the failure paths (research #8, spec FR-020, FR-020b) ----

const apiError = (status: number, message: string) => new ApiError(status, message);
const THREATS_409 =
  'Operation 0: This element still has threats, or data flows that would be deleted with it have threats; delete those threats first';

function hooked() {
  const hooks = { onRejected: vi.fn(), onThreatsBlocked: vi.fn(), onGone: vi.fn() };
  const manual = manualSend();
  const queue = new SaveQueue(manual.send, hooks);
  return { queue, hooks, ...manual };
}

describe('SaveQueue: a change that could not be sent keeps its place', () => {
  it.each([
    ['the network is down', new Error('Failed to fetch')],
    ['the server fails (500)', apiError(500, 'An unexpected failure')],
    ['the server is unavailable (503)', apiError(503, 'Unavailable')],
    ['the session was refused after its one renewal (401)', apiError(401, 'Invalid or expired token')],
    ['sign-in is throttled (429)', apiError(429, 'Too many')],
  ])('stops, keeps the change and the ones behind it, and offers a retry when %s', async (_label, error) => {
    const { queue, hooks, send, calls } = hooked();
    queue.enqueue(move(id(1), 1));
    queue.enqueue(move(id(2), 2));

    calls[0]?.reject(error);
    await flush();

    expect(queue.getSnapshot().status).toBe('failed');
    expect(queue.pendingCount()).toBe(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(hooks.onRejected).not.toHaveBeenCalled();
  });

  it('holds a change made while one has failed, until the user retries', async () => {
    const { queue, send, calls } = hooked();
    queue.enqueue(move(id(1), 1));
    calls[0]?.reject(new Error('Failed to fetch'));
    await flush();

    queue.enqueue(move(id(2), 2));
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.pendingCount()).toBe(2);

    queue.retry();
    calls[1]?.resolve();
    await flush();
    calls[2]?.resolve();
    await flush();
    expect(queue.getSnapshot().status).toBe('saved');
  });
});

describe('SaveQueue: a change the server refuses is reverted, and the rest carry on', () => {
  it('drops a rejected (400) change, says why, and sends the next one', async () => {
    const { queue, hooks, send, calls } = hooked();
    const first = move(id(1), 1);
    queue.enqueue(first);
    queue.enqueue(move(id(2), 2));

    calls[0]?.reject(apiError(400, 'Operation 0: A data flow cannot start and end at the same element'));
    await flush();

    expect(hooks.onRejected).toHaveBeenCalledWith(first, 'Operation 0: A data flow cannot start and end at the same element', 'rejected');
    expect(queue.getSnapshot().pending.map((a) => a.label)).toEqual([`Move ${id(2)}`]);
    expect(send).toHaveBeenCalledTimes(2);

    calls[1]?.resolve();
    await flush();
    expect(queue.getSnapshot().status).toBe('saved');
    expect(queue.pendingCount()).toBe(0);
  });

  it('treats an element that is gone (404) the same way, for that change only, marking it as missing', async () => {
    const { queue, hooks, send, calls } = hooked();
    const first = move(id(1), 1);
    queue.enqueue(first);
    queue.enqueue(move(id(2), 2));

    calls[0]?.reject(apiError(404, 'Operation 0: Element not found'));
    await flush();

    expect(hooks.onRejected).toHaveBeenCalledWith(first, 'Operation 0: Element not found', 'missing');
    expect(send).toHaveBeenCalledTimes(2);
    expect(queue.getSnapshot().status).toBe('saving');
  });

  it('reports a reused id (409) as a refused change', async () => {
    const { queue, hooks, calls } = hooked();
    const first = move(id(1), 1);
    queue.enqueue(first);
    calls[0]?.reject(apiError(409, 'Operation 0: An element with this id already exists'));
    await flush();
    expect(hooks.onRejected).toHaveBeenCalledWith(first, 'Operation 0: An element with this id already exists', 'rejected');
    expect(queue.getSnapshot().status).toBe('saved');
  });

  it('hands a delete that would orphan threats (409) to the threats hook, and carries on', async () => {
    const { queue, hooks, send, calls } = hooked();
    const first = move(id(1), 1);
    queue.enqueue(first);
    queue.enqueue(move(id(2), 2));

    calls[0]?.reject(apiError(409, THREATS_409));
    await flush();

    expect(hooks.onThreatsBlocked).toHaveBeenCalledWith(first, THREATS_409);
    expect(hooks.onRejected).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('works through several refusals in a row', async () => {
    const { queue, hooks, calls } = hooked();
    queue.enqueue(move(id(1), 1));
    queue.enqueue(move(id(2), 2));
    queue.enqueue(move(id(3), 3));

    calls[0]?.reject(apiError(400, 'no'));
    await flush();
    calls[1]?.reject(apiError(400, 'no'));
    await flush();
    calls[2]?.resolve();
    await flush();

    expect(hooks.onRejected).toHaveBeenCalledTimes(2);
    expect(queue.getSnapshot().status).toBe('saved');
  });
});

describe('SaveQueue: the threat model was deleted elsewhere', () => {
  it('stops for good, with nothing pending to lose and nothing retried', async () => {
    const { queue, hooks, send, calls } = hooked();
    queue.enqueue(move(id(1), 1));
    queue.enqueue(move(id(2), 2));

    calls[0]?.reject(apiError(404, 'Threat model not found'));
    await flush();

    expect(queue.getSnapshot().status).toBe('gone');
    expect(hooks.onGone).toHaveBeenCalledTimes(1);
    expect(hooks.onRejected).not.toHaveBeenCalled();
    expect(queue.pendingCount()).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);

    queue.enqueue(move(id(3), 3));
    queue.retry();
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().status).toBe('gone');
  });
});

describe('SaveQueue: the on-screen copy never loses a change that is still going to be sent (FR-020)', () => {
  it('shows the changes behind a refused one all the while', async () => {
    const { queue, calls } = hooked();
    queue.enqueue(move(id(1), 1));
    queue.enqueue(move(id(2), 2));
    calls[0]?.reject(apiError(400, 'no'));
    await flush();
    // The refused change is gone from what is shown; the one behind it is still there.
    expect(queue.getSnapshot().pending.map((a) => a.label)).toEqual([`Move ${id(2)}`]);
  });
});

describe('SaveQueue.whenSettled (research #12, US1 scenario 6)', () => {
  it('resolves saved at once when nothing is pending', async () => {
    const queue = new SaveQueue(vi.fn(() => Promise.resolve()));
    await expect(queue.whenSettled()).resolves.toBe('saved');
  });

  it('waits for the pending action, then resolves saved', async () => {
    const { send, calls } = manualSend();
    const queue = new SaveQueue(send);
    queue.enqueue(move(id(1), 10));
    let settled: SaveStatus | undefined;
    void queue.whenSettled().then((status) => (settled = status));
    await flush();
    expect(settled).toBeUndefined();
    calls[0]?.resolve();
    await flush();
    expect(settled).toBe('saved');
  });

  it('does not resolve on the snapshot enqueue publishes before the save starts (saved, but one action pending)', async () => {
    const { send, calls } = manualSend();
    const queue = new SaveQueue(send);
    let settled: SaveStatus | undefined;
    let asked = false;
    // The first notification enqueue sends shows status "saved" with the action already pending.
    queue.subscribe(() => {
      if (asked) return;
      asked = true;
      expect(queue.getSnapshot().pending).toHaveLength(1);
      void queue.whenSettled().then((status) => (settled = status));
    });
    queue.enqueue(move(id(1), 10));
    await flush();
    expect(settled).toBeUndefined();
    calls[0]?.resolve();
    await flush();
    expect(settled).toBe('saved');
  });

  it('resolves failed when the save cannot be sent, so nothing is generated against unsaved work', async () => {
    const { send, calls } = manualSend();
    const queue = new SaveQueue(send);
    queue.enqueue(move(id(1), 10));
    let settled: SaveStatus | undefined;
    void queue.whenSettled().then((status) => (settled = status));
    calls[0]?.reject(new TypeError('network'));
    await flush();
    expect(settled).toBe('failed');
    await expect(queue.whenSettled()).resolves.toBe('failed');
  });

  it('resolves gone when the threat model no longer exists', async () => {
    const { send, calls } = manualSend();
    const queue = new SaveQueue(send);
    queue.enqueue(move(id(1), 10));
    let settled: SaveStatus | undefined;
    void queue.whenSettled().then((status) => (settled = status));
    calls[0]?.reject(new ApiError(404, 'Threat model not found'));
    await flush();
    expect(settled).toBe('gone');
  });
});
