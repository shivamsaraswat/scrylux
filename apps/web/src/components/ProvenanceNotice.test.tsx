import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ProvenanceNotice } from './ProvenanceNotice.js';
import { MODEL_ID, citation } from '../test-utils.js';

// Where an accepted record, or a flag an accept set, came from (Phase 3 Milestone 5, US6; FR-017): who accepted it and when, why the model proposed it, and the
// passages, or "Source deleted". An element only some of whose flags came from the documents is not shown as AI's. Every text is text.

const mark = (over: Record<string, unknown> = {}) => ({
  id: '90909090-9090-4090-8090-909090909090',
  target: { kind: 'element', id: 'e0e0e0e0-e0e0-40e0-80e0-e0e0e0e0e0e0' },
  flag: null,
  rationale: 'The API serves the web application.',
  accepted_by: { id: 7, username: 'ada' },
  accepted_at: '2026-11-10T09:00:00.000Z',
  citations: [citation()],
  ...over,
});

const show = (marks: unknown[], flagValues: Record<string, boolean> = {}) =>
  render(
    <MemoryRouter>
      <ProvenanceNotice marks={marks as never} threatModelId={MODEL_ID} flagValues={flagValues} />
    </MemoryRouter>,
  );

describe('a record that came from a draft', () => {
  it('says it was proposed by AI and accepted, by whom and when, why it was proposed, and what it cited', () => {
    show([mark()]);
    const notice = screen.getByRole('region', { name: 'Where this came from' });
    expect(notice.textContent).toMatch(/Proposed by AI, accepted by ada on /);
    expect(within(notice).getByText('The API serves the web application.')).toBeTruthy();
    expect(within(notice).getByText('design.md')).toBeTruthy();
    expect(within(notice).getByText('The API is exposed to the internet')).toBeTruthy();
    expect(within(notice).getByRole('link', { name: 'Open in source' })).toBeTruthy();
  });

  it('says "Source deleted" for a citation whose source was deleted, and keeps the rest', () => {
    show([mark({ citations: [{ chunk: null, quote: null }, citation()] })]);
    const notice = screen.getByRole('region', { name: 'Where this came from' });
    expect(within(notice).getByText('Source deleted')).toBeTruthy();
    expect(within(notice).getByText('The API is exposed to the internet')).toBeTruthy();
  });

  it('says there is no remaining citation when every source was deleted', () => {
    show([mark({ citations: [{ chunk: null, quote: null }] })]);
    expect(screen.getByRole('region', { name: 'Where this came from' }).textContent).toContain('No remaining citation');
  });
});

describe('flags that an accept set', () => {
  const flagMark = (flag: string) => mark({ id: `91919191-9191-4191-8191-9191919191${flag === 'internet_facing' ? '91' : '92'}`, flag, citations: [citation({ quote: `quote for ${flag}` })] });

  it('shows only those flags, each with its value and its citations, and does not call the element AI’s', () => {
    show([flagMark('internet_facing')], { internet_facing: true, requires_authentication: false });
    const notice = screen.getByRole('region', { name: 'Where this came from' });
    expect(notice.textContent).not.toMatch(/Proposed by AI, accepted by ada on [^.]*\. [A-Z]/);
    expect(within(notice).getByRole('heading', { name: 'Flags set from the documents' })).toBeTruthy();
    expect(within(notice).getByText('Internet facing: Yes')).toBeTruthy();
    expect(within(notice).getByText('quote for internet_facing')).toBeTruthy();
    expect(within(notice).queryByText(/Requires authentication/)).toBeNull();
    expect(notice.textContent).not.toContain('Proposed by AI, accepted by ada on 11/10');
  });

  it('shows the record’s own mark and its flags together when both exist', () => {
    show([mark(), flagMark('internet_facing')], { internet_facing: false });
    const notice = screen.getByRole('region', { name: 'Where this came from' });
    expect(notice.textContent).toContain('Proposed by AI, accepted by ada');
    expect(within(notice).getByText('Internet facing: No')).toBeTruthy();
  });
});

describe('a record a person made', () => {
  it('shows nothing', () => {
    const { container } = show([]);
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('region', { name: 'Where this came from' })).toBeNull();
  });
});

describe('text', () => {
  it('is shown as text, never as markup', () => {
    show([mark({ rationale: '<img src=x onerror=alert(1)>', accepted_by: { id: 7, username: '<b>ada</b>' } })]);
    const notice = screen.getByRole('region', { name: 'Where this came from' });
    expect(notice.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(notice.textContent).toContain('<b>ada</b>');
    expect(notice.querySelector('img, b')).toBeNull();
  });
});
