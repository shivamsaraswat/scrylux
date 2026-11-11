import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ItemPanel } from './ItemPanel.js';
import type { DraftItem } from './draft-items.js';
import { MODEL_ID, SOURCE_ID, citation, citedChunk, itemReview } from '../test-utils.js';

// The panel of the selected item (Phase 3 Milestone 4, US2, FR-054, FR-062): why it was proposed, the flags it proposed with the
// passages behind each, and the passages it came from, each naming its source and place, showing the quote, and linking to the
// source at that chunk. Everything is text (FR-066).

const item = (over: Partial<DraftItem> = {}): DraftItem => ({
  id: 'item-1',
  group: 'process',
  typeLabel: 'Process',
  title: 'API',
  rationale: 'The API serves the web application.',
  citations: [citation()],
  flags: [],
  facts: [],
  status: 'Undecided',
  comparison: 'New',
  differences: [],
  needs: [],
  review: itemReview() as DraftItem['review'],
  ...over,
});

const show = (value: DraftItem | null) =>
  render(
    <MemoryRouter>
      <ItemPanel item={value} threatModelId={MODEL_ID} />
    </MemoryRouter>,
  );

describe('nothing selected', () => {
  it('says to select an item', () => {
    show(null);
    expect(screen.getByRole('region', { name: 'Selected item' }).textContent).toContain('Select an item');
  });
});

describe('an item', () => {
  it('names its kind and title, and says why it was proposed', () => {
    show(item({ facts: ['In Private network'] }));
    const panel = screen.getByRole('region', { name: 'Selected item' });
    expect(within(panel).getByRole('heading', { level: 3, name: 'Process: API' })).toBeTruthy();
    expect(within(panel).getByText('The API serves the web application.')).toBeTruthy();
    expect(within(panel).getByText('In Private network')).toBeTruthy();
  });

  it('shows each citation with its source, its place, its quoted passage, and a link to the source at that chunk', () => {
    show(item({ citations: [citation({ chunk: citedChunk({ source_id: SOURCE_ID, source_name: 'design.md', position: 3, line_first: 10, line_last: 24, heading: 'Architecture' }) })] }));
    const panel = screen.getByRole('region', { name: 'Selected item' });
    expect(within(panel).getByText('design.md')).toBeTruthy();
    expect(panel.textContent).toContain('lines 10-24, section: Architecture');
    expect(within(panel).getByText('The API is exposed to the internet')).toBeTruthy();
    const link = within(panel).getByRole('link', { name: 'Open in source' });
    expect(link.getAttribute('href')).toBe(`/threat-models/${MODEL_ID}/sources/${SOURCE_ID}?offset=3`);
    expect(within(panel).queryByText('No remaining citation')).toBeNull();
  });

  it('names the pages of a PDF, one or several', () => {
    show(item({ citations: [citation({ chunk: citedChunk({ page_first: 4, page_last: 4, line_first: null, line_last: null, heading: null }) }), citation({ chunk: citedChunk({ page_first: 4, page_last: 5, line_first: null, line_last: null, heading: null }) })] }));
    expect(screen.getByRole('region', { name: 'Selected item' }).textContent).toMatch(/page 4(?!-).*pages 4-5/s);
  });

  it('shows each flag with its value and its own citations', () => {
    show(
      item({
        flags: [
          { flag: 'internet_facing', value: true, citations: [citation({ quote: 'exposed to the internet' })] },
          { flag: 'requires_authentication', value: false, citations: [citation({ quote: 'no sign in is needed' })] },
        ],
      }),
    );
    const panel = screen.getByRole('region', { name: 'Selected item' });
    expect(within(panel).getByText('Internet facing: Yes')).toBeTruthy();
    expect(within(panel).getByText('Requires authentication: No')).toBeTruthy();
    expect(within(panel).getByText('exposed to the internet')).toBeTruthy();
    expect(within(panel).getByText('no sign in is needed')).toBeTruthy();
  });

  it('shows no flags section for an item with no flag', () => {
    show(item());
    expect(screen.queryByText('Proposed flags')).toBeNull();
  });
});

describe('a source that was deleted (FR-054)', () => {
  it('shows its citation as "Source deleted" instead of dropping it, and says no citation remains', () => {
    show(item({ citations: [{ chunk: null, quote: null }] }));
    const panel = screen.getByRole('region', { name: 'Selected item' });
    expect(within(panel).getByText('Source deleted')).toBeTruthy();
    expect(within(panel).getByText('No remaining citation')).toBeTruthy();
  });

  it('keeps the citations that remain, and does not say none remain', () => {
    show(item({ citations: [{ chunk: null, quote: null }, citation()] }));
    const panel = screen.getByRole('region', { name: 'Selected item' });
    expect(within(panel).getByText('Source deleted')).toBeTruthy();
    expect(within(panel).getByText('The API is exposed to the internet')).toBeTruthy();
    expect(within(panel).queryByText('No remaining citation')).toBeNull();
  });

  it('says it of an item with no citation at all', () => {
    show(item({ citations: [] }));
    expect(screen.getByText('No remaining citation')).toBeTruthy();
  });

  it('says it of a flag whose citations are gone, apart from the item’s own', () => {
    show(item({ flags: [{ flag: 'internet_facing', value: true, citations: [{ chunk: null, quote: null }] }] }));
    const flags = screen.getAllByText('No remaining citation');
    expect(flags).toHaveLength(1);
    expect(screen.getByText('Source deleted')).toBeTruthy();
  });
});

describe('what is shown is text (FR-066)', () => {
  it('never renders a title, a rationale, a quote or a source name as markup', () => {
    show(
      item({
        title: '<b>API</b>',
        rationale: '<img src=x onerror=alert(1)>',
        citations: [citation({ quote: '<script>alert(1)</script>', chunk: citedChunk({ source_name: '<i>design</i>.md' }) })],
      }),
    );
    expect(document.querySelector('b')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('i')).toBeNull();
    expect(screen.getByText('<script>alert(1)</script>')).toBeTruthy();
  });
});

describe('the review of an item (Phase 3 Milestone 5, FR-001 to FR-003)', () => {
  it('says where the item stands and how it compares with the threat model', () => {
    show(item({ status: 'Rejected by ada on 11/10/2026', comparison: 'Already in the model' }));
    const panel = screen.getByRole('region', { name: 'Selected item' });
    expect(within(panel).getByText('Rejected by ada on 11/10/2026')).toBeTruthy();
    expect(within(panel).getByText('Already in the model')).toBeTruthy();
  });

  it('lists what differs from the record it matched, and what the item needs first', () => {
    show(item({ comparison: 'Already in the model', differences: ['Internet facing: proposed Yes, not assessed', 'Boundary differs'], needs: ['Needs Database in the model first'] }));
    const panel = screen.getByRole('region', { name: 'Selected item' });
    expect(within(panel).getByRole('list', { name: 'Differences' }).textContent).toContain('Internet facing: proposed Yes, not assessed');
    expect(within(panel).getByText('Boundary differs')).toBeTruthy();
    expect(within(panel).getByText('Needs Database in the model first')).toBeTruthy();
  });

  it('shows no comparison for an item that was accepted, and every text as text', () => {
    show(item({ status: 'Accepted by <b>ada</b>', comparison: null }));
    const panel = screen.getByRole('region', { name: 'Selected item' });
    expect(within(panel).getByText('Accepted by <b>ada</b>')).toBeTruthy();
    expect(panel.querySelector('b')).toBeNull();
    expect(within(panel).queryByText('New')).toBeNull();
  });
});

// An item that matched a record links to it (Phase 3 Milestone 5, contracts/ui.md item 2, T077); one that matched none, or several, links to nothing.
describe('a match', () => {
  const matched = (group: DraftItem['group'], matchedId: string) => item({ group, comparison: 'Already in the model', review: itemReview({ comparison: 'matched', matched_id: matchedId }) as DraftItem['review'] });

  it('links an element to it on the diagram', () => {
    show(matched('process', 'element-9'));
    expect(within(screen.getByRole('region', { name: 'Selected item' })).getByRole('link', { name: 'Open the matching record' }).getAttribute('href')).toBe(`/threat-models/${MODEL_ID}/diagram?element=element-9`);
  });

  it('links an asset and an assumption to the Assets and assumptions tab', () => {
    for (const group of ['asset', 'assumption'] as const) {
      const { unmount } = show(matched(group, 'record-1'));
      expect(within(screen.getByRole('region', { name: 'Selected item' })).getByRole('link', { name: 'Open the matching record' }).getAttribute('href')).toBe(`/threat-models/${MODEL_ID}/assets`);
      unmount();
    }
  });

  it('gives no link for a new item, for several matches, or for an accepted one', () => {
    for (const value of [item(), item({ comparison: 'Several in the model; treated as new', review: itemReview({ comparison: 'several' }) as DraftItem['review'] }), item({ comparison: null, review: itemReview({ state: 'accepted', comparison: null }) as DraftItem['review'] })]) {
      const { unmount } = show(value);
      expect(screen.queryByRole('link', { name: 'Open the matching record' })).toBeNull();
      unmount();
    }
  });
});
