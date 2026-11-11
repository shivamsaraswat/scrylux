import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DRAFT_API_ID,
  JOB_ID,
  MODEL_ID,
  SOURCE_ID,
  SOURCE_ID_2,
  DRAFT_ASSET_ID,
  DRAFT_ASSUMPTION_ID,
  DRAFT_BOUNDARY_ID,
  DRAFT_DB_ID,
  draftRecord,
  extractionStatus,
  itemReview,
  installFakeApi,
  job,
  jobsStatus,
  json,
  notOffered,
  project,
  readySource,
  renderApp,
  sourceList,
  threatModel,
} from '../test-utils.js';

// The Draft tab of a threat model (Phase 3 Milestone 4, contracts/ui.md "The Draft tab"; spec US1, US4, US5, US7; FR-004, FR-014,
// FR-024, FR-052, FR-053, FR-055, FR-060 to FR-063, FR-066, FR-070, FR-071): start an extraction, follow it, and read the draft it
// made, which is marked as a draft and is not part of the threat model.

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const TAB = `/threat-models/${MODEL_ID}/draft`;
const HOSTED = { provider: 'anthropic', model: 'claude-x', hosted: true };
const LOCAL = { provider: 'openai-compatible', model: 'llama3.3', hosted: false };

interface Setup {
  status?: Record<string, unknown>;
  draft?: Record<string, unknown> | null;
  generation?: typeof HOSTED | typeof LOCAL | null;
  workerAlive?: boolean;
  sources?: unknown[];
  extra?: Record<string, () => Response>;
}

function open({ status = extractionStatus(), draft = null, generation = LOCAL, workerAlive = true, sources = [readySource()], extra = {} }: Setup = {}) {
  const state = { status, draft };
  const api = installFakeApi({
    'GET /api/v1/threat-models/:id': () => json(200, threatModel()),
    'GET /api/v1/projects/:id': () => json(200, project()),
    'GET /api/v1/threat-models/:id/elements': () => json(200, []),
    'GET /api/v1/threat-models/:id/threats': () => json(200, []),
    'GET /api/v1/threat-models/:id/mitigations': () => json(200, []),
    'GET /api/v1/threat-models/:id/sources': () => json(200, sourceList(sources)),
    'GET /api/v1/jobs/status': () => json(200, jobsStatus({ worker_alive: workerAlive, ai: { generation, embedding: null } })),
    'GET /api/v1/threat-models/:id/extraction': () => json(200, state.status),
    'GET /api/v1/threat-models/:id/draft': () => (state.draft === null ? json(404, { error: 'This threat model has no draft.' }) : json(200, state.draft)),
    'POST /api/v1/threat-models/:id/extraction': () => json(201, job({ id: JOB_ID, kind: 'extract_system', state: 'queued', threat_model_id: MODEL_ID })),
    'DELETE /api/v1/threat-models/:id/draft': () => {
      state.draft = null;
      return json(204);
    },
    ...extra,
  });
  renderApp(TAB);
  return { api, state };
}

const running = (step: string) => job({ id: JOB_ID, kind: 'extract_system', state: 'running', threat_model_id: MODEL_ID, progress: { step } });

describe('the tab', () => {
  it('is reached from the threat model’s tabs, after Sources', async () => {
    open();
    const nav = await screen.findByRole('navigation', { name: 'Threat model views' });
    const links = within(nav).getAllByRole('link').map((a) => a.textContent);
    expect(links).toEqual(['Diagram', 'Assets and assumptions', 'Threats', 'Sources', 'Draft']);
    expect(within(nav).getByRole('link', { name: 'Draft' }).getAttribute('href')).toBe(TAB);
  });
});

describe('starting an extraction (FR-001 to FR-004, FR-070)', () => {
  it('offers the button, and starts an extraction when it is pressed', async () => {
    const { api } = open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Start extraction' }));
    await waitFor(() => expect(api.callsTo('POST', `/api/v1/threat-models/${MODEL_ID}/extraction`)).toHaveLength(1));
  });

  it('shows the notice before the button on every visit, naming a hosted provider (SC-010)', async () => {
    open({ generation: HOSTED });
    const button = await screen.findByRole('button', { name: 'Start extraction' });
    const notice = screen.getByRole('note', { name: 'Where the text of your sources goes' });
    expect(notice.textContent).toContain('sends the text of this threat model’s sources to Anthropic outside this install');
    expect(notice.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says the text stays in the install for a local provider', async () => {
    open({ generation: LOCAL });
    await screen.findByRole('button', { name: 'Start extraction' });
    expect(screen.getByRole('note', { name: 'Where the text of your sources goes' }).textContent).toContain('stays in this install');
  });

  it('shows no notice and no button when no generation provider is configured, and says what extraction needs', async () => {
    open({
      generation: null,
      status: extractionStatus({ start: notOffered('no_generation_provider', 'Extraction needs a generation provider. Ask the operator to set LLM_PROVIDER.') }),
    });
    expect(await screen.findByText('Extraction needs a generation provider. Ask the operator to set LLM_PROVIDER.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start extraction' })).toBeNull();
    expect(screen.queryByRole('note', { name: 'Where the text of your sources goes' })).toBeNull();
  });

  it.each([
    ['no_ready_source', 'Extraction needs at least one ready source. Add a document on the Sources tab.'],
    ['no_embedding_provider', 'These sources are larger than the extraction budget, and choosing among them needs an embedding provider. Ask the operator to set EMBEDDING_PROVIDER.'],
    ['embeddings_out_of_date', 'These sources are larger than the extraction budget, and 1 of them has embeddings from another model. Refresh its embeddings on the Sources tab.'],
    ['would_repeat', 'Retrying would reach the same cap. Ask the operator to raise JOB_TOKEN_CAP or JOB_COST_CAP.'],
  ])('says why when a start is refused: %s', async (reason, message) => {
    open({ status: extractionStatus({ start: notOffered(reason, message) }) });
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start extraction' })).toBeNull();
  });

  it('names the sources that are still being processed, from the sources the page already has, and says to wait (FR-004)', async () => {
    const waiting = readySource({ id: SOURCE_ID, name: 'architecture.md', status: 'processing', ready: null });
    const other = readySource({ id: SOURCE_ID_2, name: 'runbook.pdf', status: 'waiting', ready: null });
    open({
      sources: [waiting, other, readySource({ id: 'abababab-abab-4bab-8bab-abababababab', name: 'done.md' })],
      status: extractionStatus({ start: notOffered('sources_processing', '2 sources of this threat model are still being processed. Wait until they are ready.', [SOURCE_ID, SOURCE_ID_2]) }),
    });
    expect(await screen.findByText('2 sources of this threat model are still being processed. Wait until they are ready.')).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Sources still being processed' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['architecture.md', 'runbook.pdf']);
    expect(screen.queryByText('done.md')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start extraction' })).toBeNull();
  });

  it('says that the sources are larger than the budget, and that the chunks will be chosen by relevance (FR-012)', async () => {
    open({ status: extractionStatus({ start: { offered: true, path: 'retrieval', replaces_draft: false }, chunks_available: 412 }) });
    await screen.findByRole('button', { name: 'Start extraction' });
    expect(screen.getByText(/larger than the extraction budget/)).toBeTruthy();
    expect(screen.getByText(/chunks most relevant to a system model/)).toBeTruthy();
  });

  it('says before the start that a new draft replaces the one below (FR-052)', async () => {
    open({ draft: draftRecord(), status: extractionStatus({ start: { offered: true, path: 'whole', replaces_draft: true } }) });
    await screen.findByRole('button', { name: 'Start extraction' });
    expect(screen.getByText('When it succeeds, the new draft replaces the draft below.')).toBeTruthy();
  });

  it('does not say that when there is no draft to replace', async () => {
    open();
    await screen.findByRole('button', { name: 'Start extraction' });
    expect(screen.queryByText(/replaces the draft below/)).toBeNull();
  });

  it('shows the server’s refusal when a start is refused after all', async () => {
    const { api } = open({ extra: { 'POST /api/v1/threat-models/:id/extraction': () => json(409, { error: 'An extraction of this threat model is already queued or running.' }) } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Start extraction' }));
    expect(await screen.findByText('An extraction of this threat model is already queued or running.')).toBeTruthy();
    expect(api.callsTo('POST', /extraction$/)).toHaveLength(1);
  });
});

describe('following an extraction (FR-063)', () => {
  it('shows the step it is on, links to the job, and offers no second start', async () => {
    open({ status: extractionStatus({ latest: running('generate'), start: notOffered('extraction_active', 'An extraction of this threat model is already queued or running.') }) });
    expect(await screen.findByText('Asking the model for a draft')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the job' }).getAttribute('href')).toBe(`/jobs/${JOB_ID}`);
    expect(screen.queryByRole('button', { name: 'Start extraction' })).toBeNull();
    expect(screen.queryByText('An extraction of this threat model is already queued or running.')).toBeNull();
  });

  it('says it is queued, and that no worker is processing jobs when none is alive', async () => {
    open({
      workerAlive: false,
      status: extractionStatus({ latest: job({ id: JOB_ID, kind: 'extract_system', state: 'queued', threat_model_id: MODEL_ID }), start: notOffered('extraction_active', 'busy') }),
    });
    expect(await screen.findByText('Queued')).toBeTruthy();
    expect(screen.getByText('No worker is processing jobs. The extraction will run when an operator starts one.')).toBeTruthy();
  });

  it('reads again every 2 seconds while the extraction is active, and stops when it ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let latest: unknown = running('select');
    let reads = 0;
    open({
      extra: {
        'GET /api/v1/threat-models/:id/extraction': () => {
          reads += 1;
          return json(200, extractionStatus({ latest, start: notOffered('extraction_active', 'busy') }));
        },
      },
    });
    expect(await screen.findByText('Choosing the chunks to read')).toBeTruthy();
    latest = job({ id: JOB_ID, kind: 'extract_system', state: 'succeeded', threat_model_id: MODEL_ID });
    await vi.advanceTimersByTimeAsync(2100);
    await waitFor(() => expect(screen.queryByText('Choosing the chunks to read')).toBeNull());
    const settled = reads;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toBe(settled);
  });

  it('shows a failed extraction’s message and hint above the draft it left as it was (FR-052)', async () => {
    open({
      draft: draftRecord(),
      status: extractionStatus({
        latest: job({
          id: JOB_ID,
          kind: 'extract_system',
          state: 'failed',
          threat_model_id: MODEL_ID,
          failure: { category: 'invalid_output', message: 'The model did not return an answer that matches the required shape.', hint: 'Try again, or ask the operator to choose a larger model.' },
        }),
      }),
    });
    const failure = await screen.findByRole('alert');
    expect(failure.textContent).toContain('The model did not return an answer that matches the required shape.');
    expect(failure.textContent).toContain('Try again, or ask the operator to choose a larger model.');
    expect(screen.getByText('Draft proposed by AI. It is not part of this threat model. Nothing here changes the threat model’s diagram or threats.')).toBeTruthy();
  });

  it('says a cancelled extraction was cancelled, and that the earlier draft stays', async () => {
    open({ draft: draftRecord(), status: extractionStatus({ latest: job({ id: JOB_ID, kind: 'extract_system', state: 'cancelled', threat_model_id: MODEL_ID }) }) });
    expect(await screen.findByText('The last extraction was cancelled. The draft below is the one before it.')).toBeTruthy();
  });
});

describe('the draft (FR-060, FR-061)', () => {
  it('is marked, on every view, as a draft proposed by AI that is not part of the threat model', async () => {
    open({ draft: draftRecord() });
    const banner = await screen.findByRole('note', { name: 'Draft status' });
    expect(banner.textContent).toBe('Draft proposed by AI. It is not part of this threat model. Nothing here changes the threat model’s diagram or threats.');
  });

  it('shows the elements as a diagram, read-only: nothing can be dragged, connected or deleted', async () => {
    open({ draft: draftRecord() });
    const diagram = await screen.findByRole('region', { name: 'Draft diagram' });
    expect(within(diagram).getByText('API')).toBeTruthy();
    expect(within(diagram).getByText('Database')).toBeTruthy();
    expect(within(diagram).getByText('Private network')).toBeTruthy();
    expect(diagram.querySelectorAll('.react-flow__handle')).toHaveLength(0);
    expect(diagram.querySelectorAll('.react-flow__node.draggable')).toHaveLength(0);
    // The page’s own buttons (deleting the threat model, say) are not the diagram’s: the diagram offers none.
    expect(within(diagram).queryByRole('button')).toBeNull();
  });

  it('lists every item by kind, so the draft can be read without the diagram', async () => {
    open({ draft: draftRecord() });
    const list = await screen.findByRole('region', { name: 'Draft items' });
    for (const heading of ['Processes (1)', 'Data stores (1)', 'Data flows (1)', 'Trust boundaries (1)', 'Assets (1)', 'Assumptions (1)']) {
      expect(within(list).getByRole('heading', { name: heading }), heading).toBeTruthy();
    }
    expect(within(list).getByRole('button', { name: /API/ })).toBeTruthy();
    expect(within(list).getByRole('button', { name: /The network keeps outsiders away from the database\./ })).toBeTruthy();
  });

  it('shows every text of the draft as text, never as markup (FR-066)', async () => {
    const draft = draftRecord();
    (draft.elements as Array<Record<string, unknown>>)[0] = { ...(draft.elements as Array<Record<string, unknown>>)[0], name: '<b>API</b> **gateway**', rationale: '<img src=x onerror=alert(1)>' };
    open({ draft });
    const list = await screen.findByRole('region', { name: 'Draft items' });
    expect(within(list).getByText('<b>API</b> **gateway**')).toBeTruthy();
    expect(document.querySelector('b')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('shows the reason, in place of the diagram, when nothing was found (FR-024)', async () => {
    open({ draft: draftRecord({ elements: [], assets: [], assumptions: [], nothing_found: 'The documents describe no system.' }) });
    expect(await screen.findByText('The documents describe no system.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Draft diagram' })).toBeNull();
  });

  it('shows no draft section when there is none', async () => {
    open();
    await screen.findByRole('button', { name: 'Start extraction' });
    expect(screen.queryByRole('region', { name: 'Draft items' })).toBeNull();
    expect(screen.queryByRole('note', { name: 'Draft status' })).toBeNull();
  });

  it('shows the panel of an item when it is selected from the list', async () => {
    open({ draft: draftRecord() });
    const user = userEvent.setup();
    const list = await screen.findByRole('region', { name: 'Draft items' });
    await user.click(within(list).getByRole('button', { name: /API/ }));
    const panel = await screen.findByRole('region', { name: 'Selected item' });
    expect(within(panel).getByText('The API serves the web application.')).toBeTruthy();
    expect(DRAFT_API_ID).toBeTruthy();
  });
});

describe('what the draft read (FR-014, FR-062)', () => {
  it('says it read all the chunks, by whom it was started, with which model and when', async () => {
    open({ draft: draftRecord() });
    const read = await screen.findByRole('region', { name: 'What the draft read' });
    expect(read.textContent).toContain('Read all 18 chunks of 3 sources');
    expect(read.textContent).toContain('claude-test');
    expect(read.textContent).toContain('ada');
  });

  it('says it read part of the chunks, chosen by relevance, and how many of how many (SC-007)', async () => {
    open({
      draft: draftRecord({
        path: 'retrieval',
        chunks_read: 20,
        chunks_available: 412,
        sources: [
          { id: SOURCE_ID, name: 'design.md', read: true },
          { id: SOURCE_ID_2, name: 'notes.txt', read: true },
        ],
      }),
    });
    const read = await screen.findByRole('region', { name: 'What the draft read' });
    expect(read.textContent).toContain('Read 20 of 412 chunks of 2 sources, chosen by relevance');
  });

  it('names the sources it left out because they were not ready', async () => {
    open({
      draft: draftRecord({
        sources: [
          { id: SOURCE_ID, name: 'design.md', read: true },
          { id: SOURCE_ID_2, name: 'scan.pdf', read: false },
        ],
      }),
    });
    const read = await screen.findByRole('region', { name: 'What the draft read' });
    expect(read.textContent).toContain('Left out because it was not ready: scan.pdf');
    expect(read.textContent).toContain('Read all 18 chunks of 1 source');
  });
});

describe('when the sources change (FR-053, FR-054)', () => {
  it('says so, and says how many sources the draft read have been deleted', async () => {
    open({ draft: draftRecord({ sources_changed: true, sources_deleted: 2 }) });
    expect(await screen.findByText('The sources have changed since this draft was made.')).toBeTruthy();
    expect(screen.getByText('2 sources that the draft read have been deleted.')).toBeTruthy();
  });

  it('says nothing about it when they have not', async () => {
    open({ draft: draftRecord() });
    await screen.findByRole('region', { name: 'What the draft read' });
    expect(screen.queryByText(/sources have changed/)).toBeNull();
    expect(screen.queryByText(/have been deleted/)).toBeNull();
  });
});

describe('discarding the draft (FR-055)', () => {
  it('asks first, and deletes the draft when it is confirmed', async () => {
    const { api } = open({ draft: draftRecord() });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Discard draft' }));
    expect(api.callsTo('DELETE', /\/draft$/)).toHaveLength(0);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(api.callsTo('DELETE', `/api/v1/threat-models/${MODEL_ID}/draft`)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Draft items' })).toBeNull());
  });

  it('keeps the draft when it is not confirmed', async () => {
    const { api } = open({ draft: draftRecord() });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Discard draft' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(api.callsTo('DELETE', /\/draft$/)).toHaveLength(0);
    expect(screen.getByRole('region', { name: 'Draft items' })).toBeTruthy();
  });
});

describe('the review of the draft (Phase 3 Milestone 5, US1; FR-001 to FR-004)', () => {
  const decided = { decided_by: { id: 7, username: 'ada' }, decided_at: '2026-11-10T09:00:00.000Z' };
  const reviewed = () =>
    draftRecord({
      review: {
        ...draftRecord().review,
        [DRAFT_API_ID]: itemReview({ comparison: 'matched', matched_id: 'dddddddd-0000-4000-8000-000000000001', differences: { flags: [{ flag: 'internet_facing', proposed: true, current: null }], boundary: true, endpoints: false, holders_missing: 0 } }),
        [DRAFT_DB_ID]: itemReview({ state: 'rejected', ...decided, comparison: 'new', needs: [] }),
        [DRAFT_BOUNDARY_ID]: itemReview({ comparison: 'several' }),
        [DRAFT_ASSET_ID]: itemReview({ state: 'accepted', outcome: 'created', ...decided, comparison: null, needs: null }),
        [DRAFT_ASSUMPTION_ID]: itemReview({ state: 'accepted', outcome: 'matched', ...decided, comparison: null, needs: null }),
      },
    });

  it('shows each item’s state, or how it compares with the threat model, beside it in the list', async () => {
    open({ draft: reviewed() });
    const list = await screen.findByRole('region', { name: 'Draft items' });
    // The flow and the asset are both called Threat data: the flow is listed first.
    const row = (name: RegExp, at = 0) => within(list).getAllByRole('button', { name })[at]?.closest('li') as HTMLElement;
    expect(row(/^API$/).textContent).toContain('Already in the model');
    expect(row(/^Database$/).textContent).toContain('Rejected');
    expect(row(/^Private network$/).textContent).toContain('Several in the model');
    expect(row(/^Threat data$/, 1).textContent).toContain('Accepted');
    expect(row(/The network keeps outsiders/).textContent).toContain('Accepted');
    expect(row(/^Threat data$/, 1).textContent).not.toContain('New');
    expect(row(/^Threat data$/, 0).textContent).toContain('New');
  });

  it('says in the panel who decided an item and when, and how an undecided item compares', async () => {
    const user = userEvent.setup();
    open({ draft: reviewed() });
    const list = await screen.findByRole('region', { name: 'Draft items' });
    await user.click(within(list).getByRole('button', { name: /^Database$/ }));
    const panel = screen.getByRole('region', { name: 'Selected item' });
    expect(panel.textContent).toMatch(/Rejected by ada on /);
    await user.click(within(list).getByRole('button', { name: /^API$/ }));
    expect(panel.textContent).toContain('Already in the model');
  });

  it('lists what differs from a matched element: a flag not yet assessed, and a boundary', async () => {
    const user = userEvent.setup();
    open({ draft: reviewed() });
    await user.click(within(await screen.findByRole('region', { name: 'Draft items' })).getByRole('button', { name: /^API$/ }));
    const differences = within(screen.getByRole('region', { name: 'Selected item' })).getByRole('list', { name: 'Differences' });
    expect(differences.textContent).toContain('Internet facing: proposed Yes, not assessed');
    expect(differences.textContent).toContain('Boundary differs');
  });

  it('says what a flow needs before it can be accepted, naming the draft items', async () => {
    const user = userEvent.setup();
    open({ draft: draftRecord() });
    await user.click(within(await screen.findByRole('region', { name: 'Draft items' })).getAllByRole('button', { name: /^Threat data$/ })[0] as HTMLElement);
    const panel = screen.getByRole('region', { name: 'Selected item' });
    expect(panel.textContent).toContain('Needs API in the model first');
    expect(panel.textContent).toContain('Needs Database in the model first');
  });

  it('keeps the warnings of Milestone 4 beside a draft whose sources changed', async () => {
    open({ draft: draftRecord({ sources_changed: true, sources_deleted: 1 }) });
    expect(await screen.findByText('The sources have changed since this draft was made.')).toBeTruthy();
    expect(screen.getByText(/1 source that the draft read has been deleted\./)).toBeTruthy();
  });

  it('renders the name of an item as text, never as markup, in the list and the panel', async () => {
    const user = userEvent.setup();
    const draft = reviewed();
    (draft.elements[0] as { name: string }).name = '<img src=x onerror=alert(1)>';
    open({ draft });
    const list = await screen.findByRole('region', { name: 'Draft items' });
    await user.click(within(list).getByRole('button', { name: /<img src=x/ }));
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('deciding the items of the draft (Phase 3 Milestone 5, US2; FR-007, FR-009, FR-016, FR-025)', () => {
  const DECISIONS = `/api/v1/threat-models/${MODEL_ID}/draft/decisions`;
  const decided = { decided_by: { id: 7, username: 'ada' }, decided_at: '2026-11-10T09:00:00.000Z' };

  /** The draft as the API answers once the four elements are accepted. */
  const afterAccept = (unlinked: unknown[] = []) => ({
    draft: draftRecord({
      review: {
        ...draftRecord().review,
        [DRAFT_API_ID]: itemReview({ state: 'accepted', outcome: 'created', ...decided, comparison: null, needs: null }),
      },
    }),
    created: 4,
    changed: 0,
    unlinked_holders: unlinked,
  });

  const toolbar = () => screen.getByRole('toolbar', { name: 'Review' });
  const pick = async (user: ReturnType<typeof userEvent.setup>, ...names: string[]) => {
    const list = await screen.findByRole('region', { name: 'Draft items' });
    for (const name of names) await user.click(within(list).getByRole('checkbox', { name: `Select ${name}` }));
  };

  it('enables Accept only when every selected item is open to it and what the elements need is selected too, saying what is missing', async () => {
    const user = userEvent.setup();
    open({ draft: draftRecord() });
    await pick(user, 'Data flow: Threat data');
    expect(within(toolbar()).getByRole('button', { name: 'Accept' }).hasAttribute('disabled')).toBe(true);
    expect(toolbar().textContent).toContain('Needs API in the model first');
    expect(toolbar().textContent).toContain('Needs Database in the model first');
    await pick(user, 'Process: API', 'Data store: Database');
    expect(toolbar().textContent).toContain('Needs Private network in the model first');
    expect(within(toolbar()).getByRole('button', { name: 'Accept' }).hasAttribute('disabled')).toBe(true);
    await pick(user, 'Trust boundary: Private network');
    expect(within(toolbar()).getByRole('button', { name: 'Accept' }).hasAttribute('disabled')).toBe(false);
    expect(toolbar().textContent).toContain('4 selected');
  });

  it('sends the draft’s id and, for each selected item, its id and the comparison the page showed, and nothing else', async () => {
    const user = userEvent.setup();
    const { api } = open({ draft: draftRecord(), extra: { [`POST ${DECISIONS}`]: () => json(200, afterAccept()) } });
    await pick(user, 'Process: API', 'Trust boundary: Private network');
    await user.click(within(toolbar()).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(api.callsTo('POST', DECISIONS)).toHaveLength(1));
    expect(api.callsTo('POST', DECISIONS)[0]?.body).toEqual({
      action: 'accept',
      draft_id: draftRecord().id,
      items: [
        { id: DRAFT_API_ID, seen: 'new' },
        { id: DRAFT_BOUNDARY_ID, seen: 'new' },
      ],
    });
  });

  it('says how many records were created and changed, and names the holders that were left unlinked', async () => {
    const user = userEvent.setup();
    open({ draft: draftRecord(), extra: { [`POST ${DECISIONS}`]: () => json(200, afterAccept([{ asset_item_id: DRAFT_ASSET_ID, element_item_id: DRAFT_DB_ID }])) } });
    await pick(user, 'Process: API');
    await user.click(within(toolbar()).getByRole('button', { name: 'Accept' }));
    const status = await screen.findByRole('status', { name: 'Result of the last decision' });
    expect(status.textContent).toContain('Created 4 records and changed 0.');
    expect(status.textContent).toContain('Held by Database was not linked: it is not in the threat model.');
  });

  it('shows the refusal’s message and reads the draft again', async () => {
    const user = userEvent.setup();
    let reads = 0;
    open({
      draft: draftRecord(),
      extra: {
        'GET /api/v1/threat-models/:id/draft': () => {
          reads += 1;
          return json(200, draftRecord());
        },
        [`POST ${DECISIONS}`]: () => json(409, { error: 'This draft was replaced or discarded' }),
      },
    });
    await pick(user, 'Process: API');
    const before = reads;
    await user.click(within(toolbar()).getByRole('button', { name: 'Accept' }));
    expect((await screen.findByRole('alert', { name: 'Decision refused' })).textContent).toContain('This draft was replaced or discarded');
    await waitFor(() => expect(reads).toBeGreaterThan(before));
  });

  it('does not offer Accept for an item that is already accepted, and says so', async () => {
    const user = userEvent.setup();
    open({ draft: afterAccept().draft });
    await pick(user, 'Process: API');
    expect(within(toolbar()).getByRole('button', { name: 'Accept' }).hasAttribute('disabled')).toBe(true);
    expect(toolbar().textContent).toContain('Already accepted');
  });

  it('shows the warning of a draft whose sources changed and a deleted source’s citation, and still offers Accept (FR-005)', async () => {
    const user = userEvent.setup();
    const draft = draftRecord({ sources_changed: true, sources_deleted: 1 });
    (draft.elements[0] as { citations: unknown[] }).citations = [{ chunk: null, quote: null }];
    open({ draft });
    expect(await screen.findByText('The sources have changed since this draft was made.')).toBeTruthy();
    await pick(user, 'Process: API');
    expect(within(toolbar()).getByRole('button', { name: 'Accept' }).hasAttribute('disabled')).toBe(false);
  });

  it('says, before a new extraction, that it replaces the draft and its decisions and that accepted records stay', async () => {
    open({ draft: afterAccept().draft });
    expect(await screen.findByText('A new extraction replaces this draft and the decisions on it. Records you accepted stay in the threat model.')).toBeTruthy();
  });

  it('keeps the earlier wording when no decision has been made', async () => {
    open({ draft: draftRecord() });
    expect(await screen.findByText('When it succeeds, the new draft replaces the draft below.')).toBeTruthy();
  });

  it('accepts one item with changes from its panel, sending only the edits', async () => {
    const user = userEvent.setup();
    const { api } = open({
      draft: draftRecord(),
      extra: { [`POST ${DECISIONS}`]: () => json(200, afterAccept()) },
    });
    const list = await screen.findByRole('region', { name: 'Draft items' });
    await user.click(within(list).getByRole('button', { name: /^Database$/ }));
    await user.click(screen.getByRole('button', { name: 'Accept…' }));
    const form = screen.getByRole('form', { name: 'Accept with changes' });
    await user.clear(within(form).getByLabelText('Name'));
    await user.type(within(form).getByLabelText('Name'), 'Threat database');
    await user.selectOptions(within(form).getByLabelText('Boundary'), '');
    await user.click(within(form).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(api.callsTo('POST', DECISIONS)).toHaveLength(1));
    expect(api.callsTo('POST', DECISIONS)[0]?.body).toEqual({
      action: 'accept',
      draft_id: draftRecord().id,
      items: [{ id: DRAFT_DB_ID, seen: 'new', edits: { name: 'Threat database', boundary: null } }],
    });
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Accept with changes' })).toBeNull());
  });

  it('does not offer to accept with changes an item that is already in the model or already accepted', async () => {
    const user = userEvent.setup();
    const matched = draftRecord({ review: { ...draftRecord().review, [DRAFT_API_ID]: itemReview({ comparison: 'matched', matched_id: 'dddddddd-0000-4000-8000-000000000001' }) } });
    open({ draft: matched });
    const list = await screen.findByRole('region', { name: 'Draft items' });
    await user.click(within(list).getByRole('button', { name: /^API$/ }));
    expect(screen.queryByRole('button', { name: 'Accept…' })).toBeNull();
  });

  it('rejects the chosen items and returns rejected ones to undecided, with the buttons enabled only where they apply', async () => {
    const user = userEvent.setup();
    const rejectedDraft = draftRecord({ review: { ...draftRecord().review, [DRAFT_DB_ID]: itemReview({ state: 'rejected', ...decided, comparison: 'new', needs: [] }) } });
    const { api } = open({ draft: draftRecord(), extra: { [`POST ${DECISIONS}`]: () => json(200, { ...afterAccept(), created: 0, draft: rejectedDraft }) } });
    await pick(user, 'Process: API');
    expect(within(toolbar()).getByRole('button', { name: 'Reject' }).hasAttribute('disabled')).toBe(false);
    expect(within(toolbar()).getByRole('button', { name: 'Return to undecided' }).hasAttribute('disabled')).toBe(true);
    await user.click(within(toolbar()).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(api.callsTo('POST', DECISIONS)).toHaveLength(1));
    expect(api.callsTo('POST', DECISIONS)[0]?.body).toEqual({ action: 'reject', draft_id: draftRecord().id, items: [{ id: DRAFT_API_ID }] });
  });

  it('shows a rejected item dimmed and still selectable, and offers to return it', async () => {
    const user = userEvent.setup();
    const rejectedDraft = draftRecord({ review: { ...draftRecord().review, [DRAFT_DB_ID]: itemReview({ state: 'rejected', ...decided, comparison: 'new', needs: [] }) } });
    const { api } = open({ draft: rejectedDraft, extra: { [`POST ${DECISIONS}`]: () => json(200, { ...afterAccept(), created: 0 }) } });
    const list = await screen.findByRole('region', { name: 'Draft items' });
    const row = within(list).getByRole('button', { name: /^Database$/ }).closest('li') as HTMLElement;
    expect(row.className).toContain('draft-row--rejected');
    await user.click(within(list).getByRole('checkbox', { name: 'Select Data store: Database' }));
    expect(within(toolbar()).getByRole('button', { name: 'Reject' }).hasAttribute('disabled')).toBe(true);
    await user.click(within(toolbar()).getByRole('button', { name: 'Return to undecided' }));
    await waitFor(() => expect(api.callsTo('POST', DECISIONS)).toHaveLength(1));
    expect(api.callsTo('POST', DECISIONS)[0]?.body).toEqual({ action: 'undecide', draft_id: draftRecord().id, items: [{ id: DRAFT_DB_ID }] });
  });

  it('reads the draft again when a reject is refused', async () => {
    const user = userEvent.setup();
    let reads = 0;
    open({
      draft: draftRecord(),
      extra: {
        'GET /api/v1/threat-models/:id/draft': () => {
          reads += 1;
          return json(200, draftRecord());
        },
        [`POST ${DECISIONS}`]: () => json(409, { error: '1 of the items were already decided' }),
      },
    });
    await pick(user, 'Process: API');
    const before = reads;
    await user.click(within(toolbar()).getByRole('button', { name: 'Reject' }));
    expect((await screen.findByRole('alert', { name: 'Decision refused' })).textContent).toContain('already decided');
    await waitFor(() => expect(reads).toBeGreaterThan(before));
  });
});

// FR-025 and contracts/ui.md item 4 (T078): the whole review works from the keyboard. Every control is a native checkbox or button, so
// each of these steps uses only the keyboard: no pointer event reaches the page after it opens.
describe('reviewing the draft by keyboard (Phase 3 Milestone 5, FR-025)', () => {
  const DECISIONS = `/api/v1/threat-models/${MODEL_ID}/draft/decisions`;
  const toolbar = () => screen.getByRole('toolbar', { name: 'Review' });
  const check = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    const box = within(await screen.findByRole('region', { name: 'Draft items' })).getByRole('checkbox', { name: `Select ${name}` });
    box.focus();
    await user.keyboard(' ');
    expect((box as HTMLInputElement).checked).toBe(true);
  };

  it('chooses items with the space bar and accepts them with Enter', async () => {
    const user = userEvent.setup();
    const { api } = open({ draft: draftRecord(), extra: { [`POST ${DECISIONS}`]: () => json(200, { draft: draftRecord(), created: 2, changed: 0, unlinked_holders: [] }) } });
    await check(user, 'Process: API');
    await check(user, 'Trust boundary: Private network');
    expect(toolbar().textContent).toContain('2 selected');
    within(toolbar()).getByRole('button', { name: 'Accept' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(api.callsTo('POST', DECISIONS)).toHaveLength(1));
    expect((api.callsTo('POST', DECISIONS)[0]?.body as { items: unknown[] }).items).toHaveLength(2);
  });

  it('rejects the chosen items with Enter', async () => {
    const user = userEvent.setup();
    const { api } = open({ draft: draftRecord(), extra: { [`POST ${DECISIONS}`]: () => json(200, { draft: draftRecord(), created: 0, changed: 0, unlinked_holders: [] }) } });
    await check(user, 'Process: API');
    within(toolbar()).getByRole('button', { name: 'Reject' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(api.callsTo('POST', DECISIONS)).toHaveLength(1));
    expect((api.callsTo('POST', DECISIONS)[0]?.body as { action: string }).action).toBe('reject');
  });

  it('selects an item with Enter on its name and opens Accept… with Enter', async () => {
    const user = userEvent.setup();
    open({ draft: draftRecord() });
    const list = await screen.findByRole('region', { name: 'Draft items' });
    within(list).getByRole('button', { name: 'API' }).focus();
    await user.keyboard('{Enter}');
    const panel = screen.getByRole('region', { name: 'Selected item' });
    within(panel).getByRole('button', { name: 'Accept…' }).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('form', { name: 'Accept with changes' })).toBeTruthy();
  });
});

