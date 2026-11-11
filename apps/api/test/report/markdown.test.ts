import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { describe, expect, it } from 'vitest';
import { markdownInline, markdownText } from '../../src/report/escape.js';
import { renderMarkdown } from '../../src/report/markdown.js';
import { buildReport, type Report } from '../../src/report/model.js';
import { empty, EXPORTED_AT, HOSTILE, HOSTILE_MULTILINE, hostile, typical, withRecords } from './fixtures.js';

// contracts/report-format.md "Markdown", and FR-014 / SC-005: whatever the user typed reads back as typed.

const render = (report: Report): string => renderMarkdown(report);
const typicalMarkdown = render(buildReport(typical(), EXPORTED_AT));
const lines = typicalMarkdown.split('\n');
const headings = lines.filter((line) => /^#{1,6} /.test(line));

// What a Markdown viewer shows: the HTML of a CommonMark + GFM parser.
const toHtml = (markdown: string): string => micromark(markdown, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'" };
// Decoded once, so "&amp;amp;" reads "&amp;", not "&".
const textOf = (html: string): string => html.replaceAll(/<[^>]*>/g, ' ').replaceAll(/&(?:lt|gt|amp|quot|#39);/g, (e) => ENTITIES[e] as string);
const squash = (value: string): string => value.replaceAll(/\s+/g, ' ').trim();

describe('markdownText', () => {
  const PUNCTUATION = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

  it('escapes every ASCII punctuation character with a backslash', () => {
    for (const ch of PUNCTUATION) expect(markdownText(ch)).toBe(`\\${ch}`);
    expect(markdownText('a*b_c [d](e)')).toBe('a\\*b\\_c \\[d\\]\\(e\\)');
  });

  it('leaves letters, digits and spaces alone', () => {
    expect(markdownText('Hello World 123 é 日本')).toBe('Hello World 123 é 日本');
  });

  it('writes leading spaces and tabs as entities, so a line cannot become an indented code block', () => {
    expect(markdownText('    x')).toBe('&#32;&#32;&#32;&#32;x');
    expect(markdownText('\tx')).toBe('&#9;x');
    expect(markdownText('a  b')).toBe('a  b');
  });

  it('ends each line but the last with a backslash, a hard line break, and never leaves a blank line', () => {
    expect(markdownText('a\nb\nc')).toBe('a\\\nb\\\nc');
    expect(markdownText('a\r\nb\rc')).toBe('a\\\nb\\\nc');
    expect(markdownText('a\n\nb')).toBe('a\\\n\\\nb');
    for (const input of ['a\n\n\nb', '\n\nx', 'x\n\n', HOSTILE_MULTILINE]) expect(markdownText(input)).not.toMatch(/\n[ \t]*\n/);
  });

  it('escapes a backslash that ends a line before adding the hard break', () => {
    expect(markdownText('a\\\nb')).toBe('a\\\\\\\nb');
  });
});

describe('markdownInline', () => {
  it('escapes like markdownText but keeps one line, joining lines with a space', () => {
    expect(markdownInline('a\nb')).toBe('a b');
    expect(markdownInline('a*\r\n#b')).toBe('a\\* \\#b');
    expect(markdownInline('# x')).toBe('\\# x');
  });
});

describe('renderMarkdown', () => {
  it('opens with the header', () => {
    expect(lines.slice(0, 7)).toEqual([
      '# Threat model report: Payments API',
      '',
      '- **Project:** Checkout',
      '- **Methodology:** STRIDE',
      '- **Threat model status:** In review',
      '- **Exported:** 2026-10-10 14:03 UTC',
      '- **Contents:** 9 elements, 13 threats, 5 mitigations',
    ]);
  });

  it('follows the outline: summary, diagram, elements by trust boundary, then model-level threats', () => {
    const wanted = [
      '# Threat model report: Payments API',
      '## Risk summary',
      '## Diagram',
      '## Elements',
      '### E1 · Trust boundary · Internal network',
      '#### Threats of this boundary',
      '##### Boundary privilege escalation — Medium',
      '#### E2 · Process · API',
      '##### Request tampering — Critical',
      '#### E3 · Process · Worker',
      '#### E4 · Data flow · Jobs',
      '#### E5 · Data flow · SQL',
      '### E6 · Trust boundary · Internal network › DB zone',
      '#### E7 · Data store · Orders DB',
      '### Outside any trust boundary',
      '#### E8 · External entity · Browser',
      '#### E9 · Data flow · HTTPS request',
      '## Threats not linked to an element',
      '##### Provider outage — Medium',
    ];
    let from = 0;
    for (const heading of wanted) {
      const at = headings.indexOf(heading, from);
      expect(at, heading).toBeGreaterThanOrEqual(from);
      from = at + 1;
    }
  });

  it('shows both summary tables with a total row each', () => {
    const report = buildReport(typical(), EXPORTED_AT);
    expect(typicalMarkdown).toContain('| Status | Threats |\n|---|---:|');
    for (const [label, count] of [
      ['Open', report.summary.byStatus.open],
      ['Mitigated', report.summary.byStatus.mitigated],
      ['Accepted', report.summary.byStatus.accepted],
      ['Not applicable', report.summary.byStatus.not_applicable],
    ] as const) {
      expect(typicalMarkdown).toContain(`| ${label} | ${count} |`);
    }
    expect(typicalMarkdown).toContain(`| **Total** | **${report.summary.total}** |`);
    expect(typicalMarkdown).toContain('| Risk (open threats) | Threats |\n|---|---:|');
    for (const risk of ['Critical', 'High', 'Medium', 'Low'] as const) expect(typicalMarkdown).toContain(`| ${risk} | ${report.summary.openByRisk[risk]} |`);
  });

  it('shows what a threat is: category, risk, status, reason, origin, and its markers', () => {
    const block = (title: string): string => {
      const start = lines.findIndex((line) => line.startsWith('##### ') && line.includes(markdownInline(title)));
      expect(start, title).toBeGreaterThan(-1);
      const end = lines.findIndex((line, i) => i > start && /^#{1,5} /.test(line));
      return lines.slice(start, end === -1 ? undefined : end).join('\n');
    };
    const replay = block('Session token replay');
    expect(replay).toContain('- **Category:** Spoofing');
    expect(replay).toContain('- **Risk:** High (likelihood High × impact Medium)');
    expect(replay).toContain('- **Status:** Accepted');
    expect(replay).toContain('- **Reason:**\n  > Tokens expire after 5 minutes\\; residual risk accepted by the platform team\\.');
    expect(replay).toContain('- **Origin:** Rule-generated');
    expect(replay).not.toContain('**Stale:**');
    expect(replay).not.toContain('**Missing:**');

    expect(block('Stale rule threat')).toContain('- **Stale:** This rule is no longer in the library\\.');
    expect(block('Unattributed decisions')).toContain('- **Missing:** a reason for this status');
    expect(block('Queue flooding')).toContain('- **Missing:** an implemented or verified mitigation');
    expect(block('Disk theft')).not.toContain('**Missing:**');
    expect(block('AI-found tampering')).toContain('- **Origin:** AI-drafted');
    expect(typicalMarkdown.match(/\*\*Missing:\*\*/g)).toHaveLength(2);
    expect(typicalMarkdown.match(/\*\*Stale:\*\*/g)).toHaveLength(1);
  });

  describe('what an element is, before its threats (spec US3)', () => {
    // From a heading to the next one: what the report says about the element before its first threat.
    const sectionOf = (heading: string): string => {
      const start = lines.indexOf(heading);
      expect(start, heading).toBeGreaterThan(-1);
      const end = lines.findIndex((line, i) => i > start && /^#{1,5} /.test(line));
      return lines.slice(start, end === -1 ? undefined : end).join('\n');
    };

    it('lists the tags and each security flag of its type', () => {
      const api = sectionOf('#### E2 · Process · API');
      expect(api).toContain('- **Tags:** Node\\.js, Express');
      expect(api).toContain('- **Internet facing:** Yes\n- **Requires authentication:** Yes\n- **Handles sensitive data:** Not assessed\n- **Runs privileged:** No');
      expect(sectionOf('#### E7 · Data store · Orders DB')).toContain('- **Tags:** PostgreSQL');
      expect(sectionOf('#### E7 · Data store · Orders DB')).toContain('- **Stores sensitive data:** Yes');
    });

    it('leaves out a Tags line where there are no tags, and flags where the type has none', () => {
      expect(sectionOf('#### E8 · External entity · Browser')).not.toContain('**Tags:**');
      expect(sectionOf('#### E8 · External entity · Browser')).toContain('- **Authenticated:** Not assessed');
      const boundary = sectionOf('### E1 · Trust boundary · Internal network');
      expect(boundary).not.toContain('**Tags:**');
      expect(boundary).not.toContain('Not assessed');
    });

    it('names the two ends of a flow, and whether it crosses a trust boundary', () => {
      expect(sectionOf('#### E9 · Data flow · HTTPS request')).toContain(
        '- **From:** E8 Browser\n- **To:** E2 API\n- **Crosses a trust boundary:** Yes (from outside any trust boundary to Internal network)',
      );
      expect(sectionOf('#### E5 · Data flow · SQL')).toContain('- **Crosses a trust boundary:** Yes (from Internal network to DB zone)');
      expect(sectionOf('#### E4 · Data flow · Jobs')).toContain('- **From:** E2 API\n- **To:** E3 Worker\n- **Crosses a trust boundary:** No');
      expect(sectionOf('#### E9 · Data flow · HTTPS request')).toContain('- **Encrypted in transit:** Yes');
    });

    it('does not write the flow lines on anything but a flow', () => {
      expect(typicalMarkdown.match(/\*\*From:\*\*/g)).toHaveLength(3);
      expect(typicalMarkdown.match(/\*\*Crosses a trust boundary:\*\*/g)).toHaveLength(3);
    });

    it('writes a hostile tag as typed', () => {
      const tagLines = render(buildReport(hostile(), EXPORTED_AT)).split('\n').filter((line) => line.startsWith('- **Tags:** '));
      expect(tagLines).toHaveLength(HOSTILE.length);
      for (const hostileText of HOSTILE) expect(tagLines).toContain(`- **Tags:** ${markdownInline(hostileText.trim())}`);
    });
  });

  it('writes a description as a blockquote and a 300-character token whole', () => {
    expect(typicalMarkdown).toContain('> Description 1');
    expect(typicalMarkdown).toContain(`> ${'x'.repeat(300)}`);
  });

  it('lists mitigations with their status and ticket', () => {
    expect(typicalMarkdown).toContain('1. **Implemented** — Bind tokens to the session — Ticket: <https://tracker.example/SEC-13>');
    expect(typicalMarkdown).toContain('2. **Proposed** — Rotate signing keys — Ticket: JIRA\\-7');
    expect(typicalMarkdown).toContain('1. **Proposed** — Add a queue limit');
    expect(typicalMarkdown).not.toMatch(/Add a queue limit.*Ticket/);
  });

  it('says so where there is nothing', () => {
    expect(typicalMarkdown).toContain('No threats.');
    expect(typicalMarkdown).toContain('No mitigations.');
    const none = render(buildReport(empty(), EXPORTED_AT));
    const emptyHeadings = none.split('\n').filter((line) => /^#{1,6} /.test(line));
    expect(emptyHeadings).toEqual([
      '# Threat model report: Payments API',
      '## Risk summary',
      '## Diagram',
      '## Elements',
      '## Threats not linked to an element',
    ]);
    expect(none).toContain('## Elements\n\nNo elements.');
    expect(none).toContain('## Threats not linked to an element\n\nNone.');
    expect(none).toContain('## Diagram\n\nNo elements.');
  });

  it('draws the diagram as one Mermaid block', () => {
    expect(typicalMarkdown.match(/^```mermaid$/gm)).toHaveLength(1);
    expect(typicalMarkdown).toMatch(/```mermaid\nflowchart LR\n[\s\S]*\n```\n/);
  });

  it('is plain LF text with one final newline, and differs between exports only in the Exported line (FR-013)', () => {
    const snap = typical();
    const first = render(buildReport(snap, new Date('2026-10-10T14:03:30Z')));
    const second = render(buildReport(snap, new Date('2027-01-02T03:04:05Z')));
    expect(first).not.toContain('\r');
    expect(first.endsWith('\n')).toBe(true);
    expect(first.endsWith('\n\n')).toBe(false);
    const a = first.split('\n');
    const b = second.split('\n');
    expect(a).toHaveLength(b.length);
    const different = a.flatMap((line, i) => (line === b[i] ? [] : [line]));
    expect(different).toEqual(['- **Exported:** 2026-10-10 14:03 UTC']);
  });
});

describe('hostile text (FR-014, SC-005)', () => {
  const report = buildReport(hostile(), EXPORTED_AT);
  const markdown = render(report);
  // The report's own diagram is a fenced block, which a viewer draws as <pre><code>; everything else is the user's text.
  const html = toHtml(markdown).replace(/<pre><code class="language-mermaid">[\s\S]*?<\/code><\/pre>/, '');
  const text = squash(textOf(html));

  it('turns nothing the user typed into a link, image, script, markup or code', () => {
    expect(markdown.match(/^```mermaid$/gm)).toHaveLength(1);
    expect(html).not.toMatch(/<(img|script|iframe|b|i|em|code|pre|del)[\s>/]/i);
    expect(html).not.toMatch(/<\/(b|script)>/i);
  });

  it('links only the http and https tickets the report itself writes', () => {
    const links = [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((match) => match[1] as string);
    const expected = [...JSON.stringify(report).matchAll(/"href":"([^"]+)"/g)].length;
    expect(links).toHaveLength(expected);
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) expect(href).toMatch(/^https?:\/\/evil\.example\/a_b\*c\?x=1&amp;y=%3C2%3E$/);
    expect(html).not.toMatch(/href="(javascript|data):/i);
  });

  it('keeps the structure the report wrote and no more', () => {
    const rawHeadings = markdown.split('\n').filter((line) => /^#{1,6} /.test(line)).length;
    expect(html.match(/<h[1-6]>/g)).toHaveLength(rawHeadings);
    expect(html.match(/<table>/g)).toHaveLength(2);
    expect(html).not.toMatch(/<hr/);
  });

  it('shows every string exactly as typed', () => {
    for (const hostileText of HOSTILE) expect(text, hostileText).toContain(squash(hostileText));
    expect(text).toContain(squash(HOSTILE_MULTILINE));
    // The tickets that are not web addresses read as text.
    expect(text).toContain('javascript:alert(1)');
    expect(text).toContain('data:text/html,<script>alert(1)</script>');
  });

  it('shows the model and project names as typed', () => {
    expect(squash(textOf(html.split('</h1>')[0] ?? ''))).toContain(squash(report.header.threatModelName));
    expect(text).toContain(squash(report.header.projectName));
  });
});

describe('a ticket link', () => {
  it('is written as an autolink with <, > and spaces percent-encoded', () => {
    const report = buildReport(hostile(), EXPORTED_AT);
    expect(render(report)).toContain('<https://evil.example/a_b*c?x=1&y=%3C2%3E>');
  });
});

// Assets and assumptions (Phase 3 Milestone 5, FR-023): two sections after the elements, only when there is something to list, with the same escapers as
// every other text of a report, and the contents line unchanged.
describe('assets and assumptions', () => {
  const withMarkdown = render(buildReport(withRecords(), EXPORTED_AT));
  const sections = withMarkdown.split('\n').filter((line) => /^## /.test(line));

  it('writes none when the threat model has none: the report is as it was, and the contents line is unchanged', () => {
    expect(headings.filter((line) => /^## (Assets|Assumptions)$/.test(line))).toEqual([]);
    expect(typicalMarkdown).not.toContain('Held by');
    expect(withMarkdown.split('\n').find((line) => line.startsWith('- **Contents:**'))).toBe(lines.find((line) => line.startsWith('- **Contents:**')));
  });

  it('writes Assets and then Assumptions after the elements and before the threats that belong to no element', () => {
    expect(sections).toEqual(['## Risk summary', '## Diagram', '## Elements', '## Assets', '## Assumptions', '## Threats not linked to an element']);
  });

  it('writes an asset as a heading with its description quoted, and the elements that hold it by reference and name', () => {
    const at = withMarkdown.indexOf('## Assets');
    const block = withMarkdown.slice(at, withMarkdown.indexOf('## Assumptions'));
    expect(block).toContain('### Customer data');
    expect(block).toContain('> Names and addresses\\.');
    expect(block).toMatch(/- \*\*Held by:\*\* E\d+ API, E\d+ Orders DB/);
    expect(block).toContain('### Session tokens');
    expect(block.match(/\*\*Held by:\*\*/g)).toHaveLength(1);
  });

  it('writes each assumption as a list item, in the order of the report', () => {
    const block = withMarkdown.slice(withMarkdown.indexOf('## Assumptions'), withMarkdown.indexOf('## Threats not linked'));
    // By code point: "Staff" comes before "The".
    expect(block).toContain('1. Staff are trusted\\.');
    expect(block).toContain('2. The database is not exposed\\.');
  });

  it('reads back as typed through a CommonMark parser: a hostile name, description and statement stay text', () => {
    const report = buildReport(hostile(), EXPORTED_AT);
    const markdown = render(report);
    const html = toHtml(markdown).replace(/<pre><code class="language-mermaid">[\s\S]*?<\/code><\/pre>/, '');
    const shown = squash(textOf(html));
    expect(markdown).toContain('## Assets');
    expect(markdown).toContain('## Assumptions');
    expect(html).not.toMatch(/<(img|script|iframe|b|i|em|code|pre|del)[\s>/]/i);
    for (const text of HOSTILE.slice(0, 7)) expect(shown, text).toContain(squash(text));
    expect(shown).toContain(squash(HOSTILE_MULTILINE));
    const rawHeadings = markdown.split('\n').filter((line) => /^#{1,6} /.test(line)).length;
    expect(html.match(/<h[1-6]>/g)).toHaveLength(rawHeadings);
  });

  it('holds no provenance, rationale or citation', () => {
    for (const absent of ['rationale', 'citation', 'provenance', 'Proposed by AI']) expect(withMarkdown.toLowerCase()).not.toContain(absent.toLowerCase());
  });
});

