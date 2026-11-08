import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ExtractionNotice } from './ExtractionNotice.js';

// The notice beside the control that starts an extraction (Phase 3 Milestone 4, FR-070, FR-071, SC-010). An extraction is the
// first thing that sends a threat model's document text to a generation model, so the page says where it goes on every visit,
// before the button can be used, and says what stays when nothing leaves.

const HOSTED = { provider: 'anthropic', model: 'claude-x', hosted: true } as const;
const LOCAL = { provider: 'openai-compatible', model: 'llama3.3', hosted: false } as const;

describe('a hosted generation provider (FR-070)', () => {
  it('names the provider, says the text leaves the install, and says it goes to the generation model', () => {
    render(<ExtractionNotice generation={HOSTED} />);
    expect(screen.getByRole('note').textContent).toBe(
      'Starting an extraction sends the text of this threat model’s sources to Anthropic outside this install, to the generation model.',
    );
  });

  it.each([
    ['openai-compatible', 'an OpenAI-compatible service'],
    ['bedrock', 'Amazon Bedrock'],
    ['gemini', 'Google Gemini'],
  ])('names %s as %s', (provider, label) => {
    render(<ExtractionNotice generation={{ provider: provider as 'bedrock', model: 'm', hosted: true }} />);
    expect(screen.getByRole('note').textContent).toContain(`to ${label} outside this install`);
  });

  it('has a name a screen reader announces', () => {
    render(<ExtractionNotice generation={HOSTED} />);
    expect(screen.getByRole('note', { name: 'Where the text of your sources goes' })).toBeTruthy();
  });
});

describe('a local generation provider (FR-071)', () => {
  it('says the text stays in the install', () => {
    render(<ExtractionNotice generation={LOCAL} />);
    const text = screen.getByRole('note').textContent;
    expect(text).toBe('Extraction runs on a local model: the text of this threat model’s sources stays in this install.');
    expect(text).not.toContain('outside this install');
  });
});

describe('no generation provider', () => {
  it('shows no notice: there is nothing to send text to, and the page says extraction needs a provider', () => {
    render(<ExtractionNotice generation={null} />);
    expect(screen.queryByRole('note')).toBeNull();
  });
});

describe('what is shown is text', () => {
  it('never renders a provider’s name or model as markup', () => {
    render(<ExtractionNotice generation={{ provider: 'anthropic', model: '<img src=x onerror=alert(1)>', hosted: true }} />);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByRole('note').textContent).not.toContain('<img');
  });
});
