import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { htmlText } from '../../src/report/escape.js';
import { renderHtml } from '../../src/report/html.js';
import { buildReport, type Report } from '../../src/report/model.js';
import { EXPORTED_AT, HOSTILE, HOSTILE_MULTILINE, LONG_TOKEN, empty, hostile, typical, withMarkers, withRecords } from './fixtures.js';

// contracts/report-format.md "HTML", research #10: a file that opens offline, runs nothing and loads nothing, and
// says what the Markdown report says.

const render = (report: Report): string => renderHtml(report);
const html = render(buildReport(typical(), EXPORTED_AT));
// The picture is checked in svg.test.ts; the words are checked here.
const withoutSvg = (document: string): string => document.replace(/<svg[\s\S]*?<\/svg>/g, '');
const count = (text: string, needle: string): number => text.split(needle).length - 1;
// Every tag in the document. User text is escaped, so a `<` that is really there starts real markup.
const tagsOf = (document: string): string[] => document.match(/<[^>]*>/g) ?? [];
const text = (document: string): string =>
  withoutSvg(document)
    .replace(/<style>[\s\S]*?<\/style>/, '')
    .replaceAll(/<[^>]*>/g, ' ')
    .replaceAll(/&(?:lt|gt|amp|quot|#39);/g, (e) => ({ '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'" })[e] as string)
    .replaceAll(/\s+/g, ' ');

describe('htmlText', () => {
  it('escapes the five characters that matter in text and in an attribute', () => {
    expect(htmlText(`<a href="x" onclick='y'>&amp;</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;');
  });

  it('leaves everything else, and writes line breaks as LF', () => {
    expect(htmlText('Plain text, 123 é 日本 😀')).toBe('Plain text, 123 é 日本 😀');
    expect(htmlText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });
});

describe('the document', () => {
  it('starts with the doctype, and the first thing in the head is the policy', () => {
    expect(html.startsWith('<!doctype html>\n<html lang="en">\n<head>\n<meta http-equiv="Content-Security-Policy" content="')).toBe(true);
  });

  it('allows no script, no outside resource, and only its own stylesheet, by hash', () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
    expect(count(html, '<style>')).toBe(1);
    const hash = `sha256-${createHash('sha256').update(style, 'utf8').digest('base64')}`;
    const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1];
    expect(policy).toBe(`default-src 'none'; style-src '${hash}'; img-src 'none'; base-uri 'none'; form-action 'none'`);
  });

  it('has the other head elements a file opened from disk needs', () => {
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('<title>Threat model report: Payments API</title>');
  });

  it('runs nothing and loads nothing', () => {
    for (const forbidden of ['<script', '<link', '<img', '<iframe', '<object', '<embed', '<base', '<form', '<input']) expect(html.toLowerCase()).not.toContain(forbidden);
    for (const tag of tagsOf(html)) expect(tag).not.toMatch(/\s(on[a-z]+|style)\s*=/i);
    expect(html).not.toMatch(/@import|@font-face/);
    // The one reference is the arrowhead in the same document.
    const urls = [...html.matchAll(/url\(([^)]*)\)/g)].map((match) => match[1]);
    expect(urls.length).toBeGreaterThan(0);
    expect(new Set(urls)).toEqual(new Set(['#arrow']));
    expect(html).not.toMatch(/(?:href|src)="(?!https?:\/\/)/);
  });

  it('is plain LF text with one final newline, and differs between exports only in the Exported line (FR-013)', () => {
    const snap = typical();
    const first = render(buildReport(snap, new Date('2026-10-10T14:03:30Z')));
    const second = render(buildReport(snap, new Date('2027-01-02T03:04:05Z')));
    expect(first).not.toContain('\r');
    expect(first.endsWith('</html>\n')).toBe(true);
    const a = first.split('\n');
    const b = second.split('\n');
    expect(a).toHaveLength(b.length);
    expect(a.flatMap((line, i) => (line === b[i] ? [] : [line]))).toEqual(['<div><dt>Exported</dt><dd>2026-10-10 14:03 UTC</dd></div>']);
  });
});

describe('what it says (the same as the Markdown report)', () => {
  const headings = [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map((match) => `${match[1]}:${match[2]}`);

  it('follows the outline: summary, diagram, elements by trust boundary, then model-level threats', () => {
    const wanted = [
      '1:Threat model report: Payments API',
      '2:Risk summary',
      '2:Diagram',
      '2:Elements',
      '3:E1 · Trust boundary · Internal network',
      '4:Threats of this boundary',
      '5:Boundary privilege escalation — Medium',
      '4:E2 · Process · API',
      '5:Request tampering — Critical',
      '4:E3 · Process · Worker',
      '4:E4 · Data flow · Jobs',
      '4:E5 · Data flow · SQL',
      '3:E6 · Trust boundary · Internal network › DB zone',
      '4:E7 · Data store · Orders DB',
      '3:Outside any trust boundary',
      '4:E8 · External entity · Browser',
      '4:E9 · Data flow · HTTPS request',
      '2:Threats not linked to an element',
      '5:Provider outage — Medium',
    ];
    let from = 0;
    for (const heading of wanted) {
      const at = headings.indexOf(heading, from);
      expect(at, heading).toBeGreaterThanOrEqual(from);
      from = at + 1;
    }
  });

  it('shows the header', () => {
    for (const [label, value] of [
      ['Project', 'Checkout'],
      ['Methodology', 'STRIDE'],
      ['Threat model status', 'In review'],
      ['Exported', '2026-10-10 14:03 UTC'],
      ['Contents', '9 elements, 13 threats, 5 mitigations'],
    ]) {
      expect(html).toContain(`<div><dt>${label}</dt><dd>${value}</dd></div>`);
    }
  });

  it('shows both summary tables with headers, captions and a total each', () => {
    const report = buildReport(typical(), EXPORTED_AT);
    expect(count(html, '<table')).toBe(2);
    expect(count(html, '<caption>')).toBe(2);
    expect(html).toContain('<th scope="col">Status</th>');
    expect(html).toContain('<th scope="row">Open</th><td>');
    expect(html).toContain(`<th scope="row">Total</th><td>${report.summary.total}</td>`);
    for (const risk of ['Critical', 'High', 'Medium', 'Low'] as const) expect(html).toContain(`<th scope="row">${risk}</th><td>${report.summary.openByRisk[risk]}</td>`);
  });

  it('shows what a threat is: category, risk, status, reason, origin and its markers, as words', () => {
    const t = text(html);
    expect(t).toContain('Category Spoofing');
    expect(t).toContain('Risk High (likelihood High × impact Medium)');
    expect(t).toContain('Status Accepted');
    expect(t).toContain('Reason Tokens expire after 5 minutes; residual risk accepted by the platform team.');
    expect(t).toContain('Origin Rule-generated');
    expect(t).toContain('Origin AI-drafted');
    expect(t).toContain('Stale This rule is no longer in the library.');
    expect(t).toContain('Missing a reason for this status');
    expect(t).toContain('Missing an implemented or verified mitigation');
    expect(count(html, '<dt>Missing</dt>')).toBe(2);
    expect(count(html, '<dt>Stale</dt>')).toBe(1);
  });

  it('gives status and risk a word and a class, so the look can differ without colour', () => {
    expect(html).toContain('<span class="badge risk-high">High</span>');
    expect(html).toContain('<span class="badge status-accepted">Accepted</span>');
    expect(html).toContain('<span class="badge status-mitigated">Mitigated</span>');
    expect(html).toContain('<span class="badge status-open">Open</span>');
    expect(html).toContain('<span class="badge status-not_applicable">Not applicable</span>');
  });

  it('lists mitigations with their status and ticket, a web address as a link and the rest as text', () => {
    expect(html).toContain('<a href="https://tracker.example/SEC-13" rel="noopener noreferrer" target="_blank">https://tracker.example/SEC-13</a>');
    const t = text(html);
    expect(t).toContain('Implemented Bind tokens to the session');
    expect(t).toContain('Proposed Rotate signing keys');
    expect(t).toContain('Ticket: JIRA-7');
    expect(count(html, '<a ')).toBe(2);
    expect(t).toContain('No mitigations.');
    expect(t).toContain('No threats.');
  });

  describe('what an element is, before its threats (spec US3)', () => {
    // The facts of an element: from its heading to its first threat, or to the end of its article.
    const articleOf = (heading: string): string => {
      const start = html.indexOf(`<h4>${heading}</h4>`);
      expect(start, heading).toBeGreaterThan(-1);
      return html.slice(start, html.indexOf('</article>', start));
    };

    it('lists the tags and each security flag of its type, before the first threat', () => {
      const api = articleOf('E2 · Process · API');
      expect(api).toContain('<div><dt>Tags</dt><dd>Node.js, Express</dd></div>');
      expect(api).toContain('<div><dt>Internet facing</dt><dd>Yes</dd></div>');
      expect(api).toContain('<div><dt>Handles sensitive data</dt><dd>Not assessed</dd></div>');
      expect(api).toContain('<div><dt>Runs privileged</dt><dd>No</dd></div>');
      expect(api.indexOf('<dt>Tags</dt>')).toBeLessThan(api.indexOf('<article class="threat">'));
      expect(articleOf('E8 · External entity · Browser')).not.toContain('<dt>Tags</dt>');
    });

    it('names the two ends of a flow, and whether it crosses a trust boundary', () => {
      const https = articleOf('E9 · Data flow · HTTPS request');
      expect(https).toContain('<div><dt>From</dt><dd>E8 Browser</dd></div>');
      expect(https).toContain('<div><dt>To</dt><dd>E2 API</dd></div>');
      expect(https).toContain('<div><dt>Crosses a trust boundary</dt><dd>Yes (from outside any trust boundary to Internal network)</dd></div>');
      expect(articleOf('E5 · Data flow · SQL')).toContain('<dd>Yes (from Internal network to DB zone)</dd>');
      expect(articleOf('E4 · Data flow · Jobs')).toContain('<div><dt>Crosses a trust boundary</dt><dd>No</dd></div>');
      expect(count(html, '<dt>From</dt>')).toBe(3);
    });

    it('shows a boundary’s tags under its heading', () => {
      const snap = typical();
      snap.elements[0] = { ...snap.elements[0], properties: { tags: ['Corporate LAN'] } } as (typeof snap.elements)[number];
      const page = render(buildReport(snap, EXPORTED_AT));
      const start = page.indexOf('<h3>E1 · Trust boundary · Internal network</h3>');
      expect(page.slice(start, page.indexOf('<h4>', start))).toContain('<div><dt>Tags</dt><dd>Corporate LAN</dd></div>');
    });

    it('writes a hostile tag as typed, escaped', () => {
      const page = render(buildReport(hostile(), EXPORTED_AT));
      expect(page).toContain('<div><dt>Tags</dt><dd>&lt;script&gt;window.__ran = 1&lt;/script&gt;</dd></div>');
      expect(count(page, '<dt>Tags</dt>')).toBe(HOSTILE.length);
    });
  });

  it('keeps a 300-character token whole', () => {
    expect(html).toContain(LONG_TOKEN);
  });

  it('says so where there is nothing', () => {
    const none = render(buildReport(empty(), EXPORTED_AT));
    const emptyHeadings = [...none.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/g)].map((match) => match[1]);
    expect(emptyHeadings).toEqual(['Threat model report: Payments API', 'Risk summary', 'Diagram', 'Elements', 'Threats not linked to an element']);
    expect(text(none)).toContain('Diagram No elements. Elements No elements.');
    expect(text(none)).toContain('Threats not linked to an element None.');
    expect(none).not.toContain('<svg');
  });

  it('has every threat and mitigation once, outside the picture (SC-002)', () => {
    const marked = withoutSvg(render(buildReport(withMarkers(), EXPORTED_AT)));
    // withMarkers() numbers the 9 elements first, then the 13 threats, then the 5 mitigations.
    for (let n = 10; n <= 27; n += 1) {
      const marker = `Tmk${String(n).padStart(4, '0')}`;
      expect(count(marked, marker), marker).toBe(1);
    }
  });

  it('is readable by a screen reader: a text alternative that points to the listing', () => {
    expect(html).toContain('<svg ');
    expect(html).toMatch(/<svg [^>]*role="img"[^>]*aria-labelledby="diagram-caption"/);
    expect(count(html, 'id="diagram-caption"')).toBe(1);
    expect(html).toContain('<figcaption id="diagram-caption">Data flow diagram. Every element and flow is listed under Elements below.</figcaption>');
    expect(count(html, '<main>')).toBe(1);
    expect(html).toContain('<html lang="en">');
  });
});

describe('hostile text (FR-014, SC-005)', () => {
  const report = buildReport(hostile(), EXPORTED_AT);
  const document = render(report);
  const body = withoutSvg(document);

  it('turns nothing the user typed into markup', () => {
    for (const forbidden of ['<script', '<img', '<b>', '</b>', '<i>', '<https', '<iframe']) expect(document.toLowerCase()).not.toContain(forbidden);
    for (const tag of tagsOf(document)) expect(tag).not.toMatch(/\s(on[a-z]+|style)\s*=/i);
    expect(document).toContain('&lt;script&gt;window.__ran = 1&lt;/script&gt;');
    expect(document).toContain('&lt;img src=x onerror=&quot;window.__ran=1&quot;&gt;');
    expect(document).toContain('&quot;quotes&quot; &#39;single&#39;');
    expect(document).toContain('#35; &amp;amp; &amp;lt;');
  });

  it('shows every string as typed', () => {
    const shown = text(document);
    for (const hostileText of HOSTILE) expect(shown, hostileText).toContain(hostileText.trim());
    expect(shown).toContain('line one line two paragraph after a blank line');
  });

  it('links only the web addresses of the tickets, safely, with the address as the text', () => {
    const links = [...body.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)];
    expect(links.length).toBeGreaterThan(0);
    for (const [, attributes, linkText] of links) {
      expect(attributes).toMatch(/^href="https:\/\/evil\.example\/a_b\*c\?x=1&amp;y=&lt;2&gt;" rel="noopener noreferrer" target="_blank"$/);
      expect(linkText).toBe('https://evil.example/a_b*c?x=1&amp;y=&lt;2&gt;');
    }
    expect(body).not.toMatch(/href="(javascript|data):/i);
    expect(text(document)).toContain('javascript:alert(1)');
    expect(text(document)).toContain('data:text/html,<script>alert(1)</script>');
  });

  it('keeps its own policy in the head, first, whatever the text', () => {
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(document.indexOf('<title>'));
    expect(document).toContain('<title>Threat model report: &lt;b&gt;bold&lt;/b&gt;</title>');
  });
});

// Assets and assumptions (Phase 3 Milestone 5, FR-023): two sections after the elements, escaped as every other text, and the contents line unchanged.
describe('assets and assumptions', () => {
  const documentWith = render(buildReport(withRecords(), EXPORTED_AT));
  const sectionIds = [...documentWith.matchAll(/<section aria-labelledby="([a-z-]+)"/g)].map((match) => match[1]);

  it('has neither section when the threat model has neither, and the same contents line', () => {
    expect(html).not.toContain('id="assets"');
    expect(html).not.toContain('id="assumptions"');
    expect(documentWith).toContain(html.match(/<dt>Contents<\/dt><dd>[^<]*<\/dd>/)?.[0] as string);
  });

  it('has Assets and then Assumptions after the elements and before the unlinked threats', () => {
    expect(sectionIds).toEqual(['summary', 'diagram', 'elements', 'assets', 'assumptions', 'unlinked']);
  });

  it('writes an asset with its description and the elements that hold it, and each assumption', () => {
    const shown = text(documentWith);
    expect(shown).toContain('Customer data');
    expect(shown).toContain('Names and addresses.');
    expect(shown).toMatch(/Held by E\d+ API, E\d+ Orders DB/);
    expect(shown).toContain('The database is not exposed.');
    expect(shown).toContain('Staff are trusted.');
  });

  it('shows hostile text as text and nothing else: no markup, no script, the same tags as without it', () => {
    const hostileDocument = render(buildReport(hostile(), EXPORTED_AT));
    const shown = text(hostileDocument);
    for (const hostileText of HOSTILE.slice(0, 7)) expect(shown, hostileText).toContain(hostileText.replaceAll(/\s+/g, ' '));
    expect(shown).toContain(HOSTILE_MULTILINE.replaceAll(/\s+/g, ' '));
    expect(tagsOf(withoutSvg(hostileDocument)).filter((tag) => /^<(script|img|iframe|b|i)[\s>/]/i.test(tag))).toEqual([]);
  });

  it('holds no provenance, rationale or citation', () => {
    for (const absent of ['rationale', 'citation', 'provenance', 'Proposed by AI']) expect(documentWith.toLowerCase()).not.toContain(absent.toLowerCase());
  });
});

