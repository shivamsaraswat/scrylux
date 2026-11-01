import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SourcesNotice } from './SourcesNotice.js';
import { MODEL_ID, installFakeApi, json, jobsStatus, project, renderApp, sourceList, threatModel } from '../test-utils.js';

// The notice that text leaves the install (FR-070 to FR-072, contracts/ui.md §1). Sources are the first milestone's content that a
// provider receives, so the form says where it goes on every visit, and says what stays when nothing leaves.

const HOSTED = { provider: 'anthropic', model: 'claude-x', hosted: true } as const;
const LOCAL = { provider: 'openai-compatible', model: 'nomic-embed-text', hosted: false } as const;

describe('the wording', () => {
  it('names the provider that makes embeddings, and says the text leaves the install, when it is hosted', () => {
    render(<SourcesNotice ai={{ generation: null, embedding: HOSTED }} />);
    expect(screen.getByRole('note').textContent).toContain('Text you add here is sent to Anthropic outside this install, to make its embeddings.');
  });

  it('says the AI features of later releases send the text out, when generation is hosted', () => {
    render(<SourcesNotice ai={{ generation: { provider: 'gemini', model: 'g', hosted: true }, embedding: LOCAL }} />);
    const text = screen.getByRole('note').textContent;
    expect(text).toContain('When the AI features of later releases run, they send this text to Google Gemini outside this install.');
    // The embeddings are local, so nothing is said to be sent for them.
    expect(text).not.toContain('to make its embeddings');
  });

  it('says both when both are hosted', () => {
    render(<SourcesNotice ai={{ generation: { provider: 'bedrock', model: 'b', hosted: true }, embedding: HOSTED }} />);
    const text = screen.getByRole('note').textContent;
    expect(text).toContain('sent to Anthropic outside this install');
    expect(text).toContain('send this text to Amazon Bedrock outside this install');
  });

  it('says the text stays in the install when every configured provider is local', () => {
    render(<SourcesNotice ai={{ generation: { provider: 'openai-compatible', model: 'l', hosted: false }, embedding: LOCAL }} />);
    const text = screen.getByRole('note').textContent;
    expect(text).toContain('Text you add here stays in this install: the configured providers run locally.');
    expect(text).not.toContain('outside this install');
  });

  it('is silent about a hosted generation provider that is not configured (nothing to say)', () => {
    render(<SourcesNotice ai={{ generation: null, embedding: LOCAL }} />);
    expect(screen.getByRole('note').textContent).toContain('stays in this install');
  });

  it('renders the names of providers as text, never as markup', () => {
    render(<SourcesNotice ai={{ generation: null, embedding: { provider: 'anthropic', model: '<img src=x onerror=alert(1)>', hosted: true } }} />);
    expect(document.querySelector('img')).toBeNull();
  });
});

const TAB = `/threat-models/${MODEL_ID}/sources`;
function handlers(ai: Record<string, unknown>, sources: unknown[] = []) {
  return {
    'GET /api/v1/threat-models/:id': () => json(200, threatModel()),
    'GET /api/v1/projects/:id': () => json(200, project()),
    'GET /api/v1/threat-models/:id/elements': () => json(200, []),
    'GET /api/v1/threat-models/:id/threats': () => json(200, []),
    'GET /api/v1/threat-models/:id/mitigations': () => json(200, []),
    'GET /api/v1/threat-models/:id/sources': () => json(200, sourceList(sources)),
    'GET /api/v1/jobs/status': () => json(200, jobsStatus({ ai })),
  };
}
const follows = (a: Node, b: Node): boolean => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('on the Sources tab', () => {
  it('is inside each form, before its submit control, while a hosted provider is configured', async () => {
    installFakeApi(handlers({ generation: null, embedding: HOSTED }));
    renderApp(TAB);
    const upload = (await screen.findByRole('button', { name: 'Upload' })).closest('form')!;
    const paste = screen.getByRole('button', { name: 'Add text' }).closest('form')!;
    for (const form of [upload, paste]) {
      const note = within(form).getByRole('note');
      expect(note.textContent).toContain('sent to Anthropic outside this install');
      expect(follows(note, form.querySelector('button[type="submit"]')!)).toBe(true);
    }
  });

  it('is repeated above the list while a hosted provider is configured', async () => {
    installFakeApi(handlers({ generation: null, embedding: HOSTED }));
    renderApp(TAB);
    await screen.findByRole('button', { name: 'Upload' });
    const list = await screen.findByText('No documents yet.');
    const notes = screen.getAllByRole('note');
    const aboveList = notes.filter((note) => !note.closest('form'));
    expect(aboveList).toHaveLength(1);
    expect(follows(aboveList[0]!, list)).toBe(true);
  });

  it('is in the forms but not repeated above the list when only local providers are configured', async () => {
    installFakeApi(handlers({ generation: null, embedding: LOCAL }));
    renderApp(TAB);
    await screen.findByRole('button', { name: 'Upload' });
    await screen.findByText('No documents yet.');
    const notes = screen.getAllByRole('note');
    expect(notes.every((note) => note.closest('form') !== null)).toBe(true);
    expect(notes[0]!.textContent).toContain('stays in this install');
  });

  it('is shown above the list for a hosted generation provider even when no embedding provider is configured', async () => {
    installFakeApi(handlers({ generation: { provider: 'anthropic', model: 'c', hosted: true }, embedding: null }));
    renderApp(TAB);
    expect(await screen.findByText(/Adding documents needs an embedding provider/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
    const note = screen.getByRole('note');
    expect(note.textContent).toContain('send this text to Anthropic outside this install');
  });

  it('is on screen again on a later visit', async () => {
    installFakeApi(handlers({ generation: null, embedding: HOSTED }));
    const first = renderApp(TAB);
    await screen.findByRole('button', { name: 'Upload' });
    first.unmount();
    renderApp(TAB);
    await screen.findByRole('button', { name: 'Upload' });
    expect(screen.getAllByRole('note').length).toBeGreaterThan(0);
  });
});
