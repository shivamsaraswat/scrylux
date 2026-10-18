import { describe, expect, it } from 'vitest';
import { mermaidLabel } from '../../src/report/escape.js';
import { renderMarkdown } from '../../src/report/markdown.js';
import { MERMAID_MAX_EDGES, MERMAID_MAX_TEXT, renderMermaid, type MermaidDiagram } from '../../src/report/mermaid.js';
import { buildReport, type Report } from '../../src/report/model.js';
import type { Snapshot } from '../../src/snapshot.js';
import { duplicateNames, element, elementId, empty, EXPORTED_AT, hostile, mitigation, threat, typical } from './fixtures.js';

// research #9, FR-007 and FR-007a: the flowchart a Markdown report carries, and the size above which it is left out.

function chart(report: Report): string {
  const drawn = renderMermaid(report);
  if (drawn.tooLarge) throw new Error('the diagram was too large');
  return drawn.text;
}

const decode = (label: string): string => label.replaceAll(/#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));

describe('mermaidLabel', () => {
  it('keeps letters, digits and spaces', () => {
    expect(mermaidLabel('Orders DB 2')).toBe('Orders DB 2');
  });

  it('writes every other character as a decimal entity, by code point', () => {
    expect(mermaidLabel('"')).toBe('#34;');
    expect(mermaidLabel('#')).toBe('#35;');
    expect(mermaidLabel('<script>')).toBe('#60;script#62;');
    expect(mermaidLabel('a`b')).toBe('a#96;b');
    expect(mermaidLabel('a\nb')).toBe('a#10;b');
    expect(mermaidLabel('😀')).toBe('#128512;');
    expect(mermaidLabel('é')).toBe('#233;');
  });

  it('round-trips any text through its entities', () => {
    for (const text of ['--> end subgraph', '"quotes" \'single\'', '#35; &amp;', '日本語', 'a|b[c](d){e}']) expect(decode(mermaidLabel(text))).toBe(text);
  });
});

describe('renderMermaid', () => {
  const report = buildReport(typical(), EXPORTED_AT);
  const text = chart(report);
  const lines = text.split('\n');

  it('is a left-to-right flowchart', () => {
    expect(lines[0]).toBe('flowchart LR');
  });

  it('shapes each element by its type, with ids from its reference', () => {
    expect(text).toContain('n2(["API"])');
    expect(text).toContain('n3(["Worker"])');
    expect(text).toContain('n7[("Orders DB")]');
    expect(text).toContain('n8["Browser"]');
  });

  it('nests a subgraph in the one around it, and ends each', () => {
    const outer = lines.findIndex((line) => line.trim() === 'subgraph b1["Internal network"]');
    const inner = lines.findIndex((line) => line.trim() === 'subgraph b6["DB zone"]');
    expect(outer).toBeGreaterThan(0);
    expect(inner).toBeGreaterThan(outer);
    expect(lines[inner]?.search(/\S/)).toBeGreaterThan(lines[outer]?.search(/\S/) ?? 0);
    expect(lines.filter((line) => line.trim() === 'end')).toHaveLength(2);
    // Orders DB is inside the inner one, Browser outside both.
    const ends = lines.map((line, i) => (line.trim() === 'end' ? i : -1)).filter((i) => i >= 0);
    const ordersDb = lines.findIndex((line) => line.includes('n7['));
    const browser = lines.findIndex((line) => line.includes('n8['));
    expect(ordersDb).toBeGreaterThan(inner);
    expect(ordersDb).toBeLessThan(ends[0] as number);
    expect(browser).toBeGreaterThan(ends[1] as number);
  });

  it('draws every flow as a labelled arrow, after the last subgraph, so no endpoint is pulled into a group', () => {
    const edges = lines.filter((line) => line.includes('-->'));
    expect(edges.map((line) => line.trim())).toEqual([
      'n2 -->|"Jobs"| n3',
      'n2 -->|"SQL"| n7',
      'n8 -->|"HTTPS request"| n2',
    ]);
    const lastEnd = Math.max(...lines.map((line, i) => (line.trim() === 'end' ? i : -1)));
    expect(lines.findIndex((line) => line.includes('-->'))).toBeGreaterThan(lastEnd);
  });

  it('uses only ids made from the order of the report', () => {
    const ids = [...text.matchAll(/^\s*(?:subgraph )?([nb]\d+)[[(]/gm)].map((match) => match[1]);
    expect(ids.length).toBe(report.header.counts.elements - report.diagram.flows.length);
    for (const id of ids) expect(id).toMatch(/^[nb][1-9]\d*$/);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('tells apart elements with the same name', () => {
    expect(chart(buildReport(duplicateNames(), EXPORTED_AT))).toMatch(/\["Worker #40;E\d#41;"\]/);
  });

  it('draws only elements, so it is the same whatever the threats, mitigations or export time (data-model.md §4, invariant 6)', () => {
    const snap = typical();
    const changed: Snapshot = {
      ...snap,
      threats: [threat(99, { element_id: elementId(3), title: 'Another' })],
      mitigations: [mitigation(99, 99)],
    };
    expect(chart(buildReport(changed, new Date('2030-01-01T00:00:00Z')))).toBe(text);
  });

  it('writes nothing outside a label that could end it, in a hostile model', () => {
    const hostileChart = chart(buildReport(hostile(), EXPORTED_AT));
    const labels = [...hostileChart.matchAll(/"([^"]*)"/g)].map((match) => match[1] as string);
    expect(labels.length).toBeGreaterThan(20);
    for (const label of labels) expect(label).toMatch(/^(?:[A-Za-z0-9 ]|#\d+;)*$/);
    // Every line is a structural line: a declaration, a subgraph, an end, or an edge.
    for (const line of hostileChart.split('\n').slice(1)) expect(line.trim()).toMatch(/^(?:subgraph [nb]\d+\["[^"]*"\]|end|n\d+(?:\["[^"]*"\]|\(\["[^"]*"\]\)|\[\("[^"]*"\)\])|n\d+ -->\|"[^"]*"\| n\d+)$/);
    // Every name comes back whole.
    const report = buildReport(hostile(), EXPORTED_AT);
    for (const node of report.diagram.nodes) expect(hostileChart).toContain(`"${mermaidLabel(node.displayName)}"`);
  });
});

// Builds a model of `nodes` processes joined by `flows` flows between the first two.
function crowded(nodes: number, flows: number, name = (i: number) => `Node ${i}`): Report {
  const elements = [
    ...Array.from({ length: nodes }, (_, i) => element(i + 1, { name: name(i + 1), layout: { x: i * 10, y: 0 } })),
    ...Array.from({ length: flows }, (_, i) =>
      element(nodes + i + 1, { type: 'data_flow', name: `Flow ${i + 1}`, layout: null, source_element_id: elementId(1), target_element_id: elementId(2) }),
    ),
  ];
  return buildReport({ ...empty(), elements }, EXPORTED_AT);
}

describe('the size above which the flowchart is left out (FR-007a)', () => {
  it('keeps the limits below what Mermaid draws by default', () => {
    expect(MERMAID_MAX_TEXT).toBe(40_000);
    expect(MERMAID_MAX_EDGES).toBe(400);
  });

  it('draws exactly the limit of edges, and leaves out one more', () => {
    expect(renderMermaid(crowded(2, MERMAID_MAX_EDGES)).tooLarge).toBe(false);
    const over = renderMermaid(crowded(2, MERMAID_MAX_EDGES + 1));
    expect(over).toEqual({ tooLarge: true, elementCount: 2 + MERMAID_MAX_EDGES + 1 });
  });

  it('leaves the flowchart out once its text passes the limit, and not before', () => {
    const wide = (i: number): string => `${'!'.repeat(150)}${i}`;
    let last: MermaidDiagram | undefined;
    let drawn = 0;
    for (let nodes = 1; nodes <= 100; nodes += 1) {
      const result = renderMermaid(crowded(nodes, 0, wide));
      if (result.tooLarge) {
        expect(result.elementCount).toBe(nodes);
        break;
      }
      expect(result.text.length).toBeLessThanOrEqual(MERMAID_MAX_TEXT);
      last = result;
      drawn = nodes;
    }
    expect(drawn).toBeGreaterThan(10);
    expect(drawn).toBeLessThan(100);
    // It was left out only when the next node would have crossed the limit: one node's line is under 700 characters.
    expect(last && !last.tooLarge ? last.text.length : 0).toBeGreaterThan(MERMAID_MAX_TEXT - 700);
  });

  it('decides from the diagram alone', () => {
    const a = renderMermaid(crowded(2, MERMAID_MAX_EDGES + 1));
    const b = renderMermaid(crowded(2, MERMAID_MAX_EDGES + 1));
    expect(a).toEqual(b);
  });
});

describe('the diagram in the Markdown report', () => {
  it('is a fenced block when it can be drawn', () => {
    const markdown = renderMarkdown(buildReport(typical(), EXPORTED_AT));
    expect(markdown.match(/^```mermaid$/gm)).toHaveLength(1);
    expect(markdown).not.toContain('too large to draw');
  });

  it('is a plain note, with no link, when it is too large', () => {
    const report = crowded(2, MERMAID_MAX_EDGES + 1);
    const markdown = renderMarkdown(report);
    expect(markdown).toContain(
      `## Diagram\n\n> The diagram has ${2 + MERMAID_MAX_EDGES + 1} elements and is too large to draw here. Its structure is listed under Elements below; the HTML report from Scrylux draws it in full.\n`,
    );
    expect(markdown).not.toContain('```mermaid');
    const note = markdown.split('\n').find((line) => line.includes('too large to draw')) as string;
    expect(note).not.toMatch(/\]\(|<http|https?:\/\//);
  });
});
