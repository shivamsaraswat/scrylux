import { randomBytes } from 'node:crypto';
import { fillPlaceholders, loadPrompt } from './data.js';

export interface PromptInput {
  /** Trusted text written by Scrylux. It goes in the provider's instruction position. */
  instructions: string;
  /** Untrusted. It goes only inside the marked content section (FR-040). */
  content?: string | undefined;
}

export interface BuiltPrompt {
  system: string;
  user: string;
}

const MAX_DRAWS = 8;

/**
 * Keeps instructions and untrusted content apart. The content sits in the user text between two marker lines that
 * carry a random 128-bit nonce drawn for this request, so a document cannot close its own section by typing an end
 * marker: it cannot know the nonce. If the content happens to contain the nonce, a new one is drawn (research #10).
 * The fixed wording lives in prompts/content-section.md: the preamble, the start marker and the end marker, in that
 * order, separated by a `%%%` line.
 */
export function buildPrompt(input: PromptInput, random: (bytes: number) => Buffer = randomBytes): BuiltPrompt {
  const { instructions, content } = input;
  if (content === undefined || content === '') {
    return { system: instructions, user: loadPrompt('empty-turn.md').trim() };
  }

  let nonce = '';
  for (let draw = 0; draw < MAX_DRAWS; draw++) {
    const candidate = random(16).toString('hex');
    if (!content.includes(candidate)) {
      nonce = candidate;
      break;
    }
  }
  if (nonce === '') throw new Error('could not draw a content nonce that the content does not contain');

  const parts = fillPlaceholders(loadPrompt('content-section.md'), { nonce }).split(/\n%%%\n/);
  const [preamble, start, end] = parts.map((p) => p.trim());
  if (parts.length !== 3 || !preamble || !start || !end) {
    throw new Error('prompts/content-section.md must hold the preamble, the start marker and the end marker, separated by %%% lines');
  }
  return { system: `${instructions}\n\n${preamble}`, user: `${start}\n${content}\n${end}` };
}
