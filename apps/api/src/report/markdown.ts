import { RISK_LEVELS, THREAT_STATUSES } from '@scrylux/core';
import { markdownAutolink, markdownInline, markdownLines } from './escape.js';
import { renderMermaid } from './mermaid.js';
import { GAP_TEXT, STATUS_LABELS, contentsLine, crossingText, type BoundaryGroup, type Report, type ReportElement, type ReportMitigation, type ReportThreat } from './model.js';

// The Markdown report (contracts/report-format.md "Markdown"). Everything the user typed goes through exactly one of
// the escapers in escape.ts; everything else here is the report's own fixed wording. Tables hold only fixed labels and
// numbers, and text of more than one line is always in a block quote or a list item, never loose.

type Block = string[];

const quote = (text: string, prefix: string): string[] => markdownLines(text).map((line) => `${prefix}> ${line}`);

function mitigationBlock(mitigations: readonly ReportMitigation[]): Block {
  if (mitigations.length === 0) return ['No mitigations.'];
  const lines: string[] = [];
  mitigations.forEach((mitigation, i) => {
    const marker = `${i + 1}. `;
    const body = markdownLines(mitigation.description);
    const ticket =
      mitigation.ticket === null
        ? ''
        : ` — Ticket: ${mitigation.ticket.href === null ? markdownInline(mitigation.ticket.text) : markdownAutolink(mitigation.ticket.href)}`;
    body.forEach((line, n) => {
      const last = n === body.length - 1;
      const head = n === 0 ? `${marker}**${mitigation.statusLabel}** — ` : ' '.repeat(marker.length);
      lines.push(`${head}${line}${last ? ticket : ''}`);
    });
  });
  return lines;
}

function threatBlocks(threat: ReportThreat): Block[] {
  const facts: string[] = [
    `- **Category:** ${threat.category}`,
    `- **Risk:** ${threat.risk} (likelihood ${threat.likelihood} × impact ${threat.impact})`,
    `- **Status:** ${threat.statusLabel}`,
  ];
  if (threat.statusReason !== null) facts.push('- **Reason:**', ...quote(threat.statusReason, '  '));
  facts.push(`- **Origin:** ${threat.originLabel === threat.origin ? markdownInline(threat.originLabel) : threat.originLabel}`);
  if (threat.stale !== null) facts.push(`- **Stale:** ${markdownInline(threat.stale)}`);
  if (threat.gap !== null) facts.push(`- **Missing:** ${GAP_TEXT[threat.gap]}`);

  const blocks: Block[] = [[`##### ${markdownInline(threat.title)} — ${threat.risk}`], facts];
  if (threat.description !== '') blocks.push(quote(threat.description, ''));
  blocks.push(['**Mitigations**'], mitigationBlock(threat.mitigations));
  return blocks;
}

function threatsBlocks(threats: readonly ReportThreat[], whenNone: string): Block[] {
  return threats.length === 0 ? [[whenNone]] : threats.flatMap(threatBlocks);
}

// What the element is, before its threats: the ends of a flow, the technology tags, and each security flag of its type.
function propertyBlocks(element: ReportElement): Block[] {
  const lines: string[] = [];
  if (element.flow !== null) {
    const end = (flowEnd: { ref: string; name: string }): string => `${flowEnd.ref} ${markdownInline(flowEnd.name)}`;
    lines.push(
      `- **From:** ${end(element.flow.source)}`,
      `- **To:** ${end(element.flow.target)}`,
      `- **Crosses a trust boundary:** ${crossingText(element.flow, markdownInline)}`,
    );
  }
  if (element.tags.length > 0) lines.push(`- **Tags:** ${element.tags.map(markdownInline).join(', ')}`);
  for (const flag of element.flags) lines.push(`- **${flag.label}:** ${flag.value}`);
  return lines.length === 0 ? [] : [lines];
}

function elementBlocks(element: ReportElement): Block[] {
  return [
    [`#### ${element.ref} · ${element.typeLabel} · ${markdownInline(element.name)}`],
    ...propertyBlocks(element),
    ...threatsBlocks(element.threats, 'No threats.'),
  ];
}

function groupBlocks(group: BoundaryGroup): Block[] {
  const blocks: Block[] = [];
  if (group.boundary !== null) {
    blocks.push([`### ${group.boundary.ref} · ${group.boundary.typeLabel} · ${group.path.map(markdownInline).join(' › ')}`], ...propertyBlocks(group.boundary));
    if (group.ownThreats.length > 0) blocks.push(['#### Threats of this boundary'], ...group.ownThreats.flatMap(threatBlocks));
  } else if (group.elements.length > 0) {
    blocks.push(['### Outside any trust boundary']);
  }
  for (const element of group.elements) blocks.push(...elementBlocks(element));
  for (const child of group.children) blocks.push(...groupBlocks(child));
  return blocks;
}

function summaryBlocks(report: Report): Block[] {
  const { summary } = report;
  const open = summary.byStatus.open;
  return [
    [
      '| Status | Threats |',
      '|---|---:|',
      ...THREAT_STATUSES.map((status) => `| ${STATUS_LABELS[status]} | ${summary.byStatus[status]} |`),
      `| **Total** | **${summary.total}** |`,
    ],
    [
      '| Risk (open threats) | Threats |',
      '|---|---:|',
      ...[...RISK_LEVELS].reverse().map((risk) => `| ${risk} | ${summary.openByRisk[risk]} |`),
      `| **Total** | **${open}** |`,
    ],
  ];
}

function diagramBlock(report: Report): Block {
  if (report.header.counts.elements === 0) return ['No elements.'];
  const drawn = renderMermaid(report);
  if (drawn.tooLarge) {
    return [
      `> The diagram has ${drawn.elementCount} elements and is too large to draw here. Its structure is listed under Elements below; the HTML report from Scrylux draws it in full.`,
    ];
  }
  return ['```mermaid', drawn.text, '```'];
}

export function renderMarkdown(report: Report): string {
  const { header } = report;
  const blocks: Block[] = [
    [`# Threat model report: ${markdownInline(header.threatModelName)}`],
    [
      `- **Project:** ${markdownInline(header.projectName)}`,
      `- **Methodology:** ${markdownInline(header.methodology)}`,
      `- **Threat model status:** ${header.threatModelStatus}`,
      `- **Exported:** ${header.exportedAt}`,
      `- **Contents:** ${contentsLine(header.counts)}`,
    ],
    ['## Risk summary'],
    ...summaryBlocks(report),
    ['## Diagram'],
    diagramBlock(report),
    ['## Elements'],
  ];
  if (header.counts.elements === 0) blocks.push(['No elements.']);
  for (const group of report.groups) blocks.push(...groupBlocks(group));
  blocks.push(...groupBlocks(report.outside));
  blocks.push(['## Threats not linked to an element'], ...threatsBlocks(report.unlinked, 'None.'));
  return `${blocks.map((block) => block.join('\n')).join('\n\n')}\n`;
}
