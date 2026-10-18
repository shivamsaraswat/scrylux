import { RISK_LEVELS, THREAT_STATUSES } from '@scrylux/core';
import { htmlText } from './escape.js';
import { GAP_TEXT, STATUS_LABELS, contentsLine, crossingText, type BoundaryGroup, type Report, type ReportElement, type ReportMitigation, type ReportThreat } from './model.js';
import { REPORT_CSS, REPORT_CSS_HASH } from './report-css.js';
import { renderSvg } from './svg.js';

// The HTML report (contracts/report-format.md "HTML"): one file that opens and prints the same offline, from disk,
// with no Scrylux session. It says what the Markdown report says, in the same order and the same words, and it is
// inert: the policy in its first <meta> allows no script and nothing from outside but its own stylesheet, by hash, so
// even text that slipped past the escaping could neither run nor call out (FR-016). Every piece of user text goes
// through htmlText; everything else here is the report's own fixed wording.

const POLICY = `default-src 'none'; style-src '${REPORT_CSS_HASH}'; img-src 'none'; base-uri 'none'; form-action 'none'`;

const CAPTION = 'Data flow diagram. Every element and flow is listed under Elements below.';

// A status or a risk is a word in a bordered box; the border's style, from the stylesheet, is a second cue that does not
// depend on colour. The class is one of a fixed set of values, never user text.
const badge = (kind: string, value: string, label: string): string => `<span class="badge ${kind}-${value}">${htmlText(label)}</span>`;

function fact(label: string, valueHtml: string, classes = ''): string {
  return `<div><dt>${label}</dt><dd${classes === '' ? '' : ` class="${classes}"`}>${valueHtml}</dd></div>`;
}

function mitigationItem(mitigation: ReportMitigation): string {
  const ticket =
    mitigation.ticket === null
      ? ''
      : mitigation.ticket.href === null
        ? ` <span class="ticket">Ticket: ${htmlText(mitigation.ticket.text)}</span>`
        : ` <span class="ticket">Ticket: <a href="${htmlText(mitigation.ticket.href)}" rel="noopener noreferrer" target="_blank">${htmlText(mitigation.ticket.href)}</a></span>`;
  return `<li>${badge('mitigation', mitigation.status, mitigation.statusLabel)} <span class="text">${htmlText(mitigation.description)}</span>${ticket}</li>`;
}

function threatArticle(threat: ReportThreat): string[] {
  const facts = [
    fact('Category', htmlText(threat.category)),
    fact('Risk', `${badge('risk', threat.risk.toLowerCase(), threat.risk)} (likelihood ${threat.likelihood} × impact ${threat.impact})`),
    fact('Status', badge('status', threat.status, threat.statusLabel)),
  ];
  if (threat.statusReason !== null) facts.push(fact('Reason', htmlText(threat.statusReason), 'text'));
  facts.push(fact('Origin', htmlText(threat.originLabel)));
  if (threat.stale !== null) facts.push(fact('Stale', htmlText(threat.stale)));
  if (threat.gap !== null) facts.push(fact('Missing', GAP_TEXT[threat.gap]));
  return [
    '<article class="threat">',
    `<h5>${htmlText(threat.title)} — ${threat.risk}</h5>`,
    '<dl class="facts">',
    ...facts,
    '</dl>',
    ...(threat.description === '' ? [] : [`<p class="text">${htmlText(threat.description)}</p>`]),
    '<h6>Mitigations</h6>',
    ...(threat.mitigations.length === 0 ? ['<p>No mitigations.</p>'] : ['<ol class="mitigations">', ...threat.mitigations.map(mitigationItem), '</ol>']),
    '</article>',
  ];
}

function threatsOrNone(threats: readonly ReportThreat[], whenNone: string): string[] {
  return threats.length === 0 ? [`<p>${whenNone}</p>`] : threats.flatMap(threatArticle);
}

// What the element is, before its threats: the ends of a flow, the technology tags, and each security flag of its type.
function propertyFacts(element: ReportElement): string[] {
  const facts: string[] = [];
  if (element.flow !== null) {
    const end = (flowEnd: { ref: string; name: string }): string => `${flowEnd.ref} ${htmlText(flowEnd.name)}`;
    facts.push(fact('From', end(element.flow.source)), fact('To', end(element.flow.target)), fact('Crosses a trust boundary', crossingText(element.flow, htmlText)));
  }
  if (element.tags.length > 0) facts.push(fact('Tags', element.tags.map(htmlText).join(', ')));
  for (const flag of element.flags) facts.push(fact(htmlText(flag.label), flag.value));
  return facts.length === 0 ? [] : ['<dl class="facts">', ...facts, '</dl>'];
}

function elementArticle(element: ReportElement): string[] {
  return [
    '<article class="element">',
    `<h4>${element.ref} · ${element.typeLabel} · ${htmlText(element.name)}</h4>`,
    ...propertyFacts(element),
    ...threatsOrNone(element.threats, 'No threats.'),
    '</article>',
  ];
}

function groupSection(group: BoundaryGroup): string[] {
  const lines = ['<section class="group">'];
  if (group.boundary !== null) {
    lines.push(`<h3>${group.boundary.ref} · ${group.boundary.typeLabel} · ${group.path.map(htmlText).join(' › ')}</h3>`, ...propertyFacts(group.boundary));
    if (group.ownThreats.length > 0) lines.push('<h4>Threats of this boundary</h4>', ...group.ownThreats.flatMap(threatArticle));
  } else if (group.elements.length > 0) {
    lines.push('<h3>Outside any trust boundary</h3>');
  }
  for (const element of group.elements) lines.push(...elementArticle(element));
  for (const child of group.children) lines.push(...groupSection(child));
  lines.push('</section>');
  return lines;
}

function summaryTables(report: Report): string[] {
  const { summary } = report;
  return [
    '<table>',
    '<caption>Threats by status</caption>',
    '<thead><tr><th scope="col">Status</th><th scope="col">Threats</th></tr></thead>',
    '<tbody>',
    ...THREAT_STATUSES.map((status) => `<tr><th scope="row">${STATUS_LABELS[status]}</th><td>${summary.byStatus[status]}</td></tr>`),
    `<tr><th scope="row">Total</th><td>${summary.total}</td></tr>`,
    '</tbody>',
    '</table>',
    '<table>',
    '<caption>Open threats by risk</caption>',
    '<thead><tr><th scope="col">Risk</th><th scope="col">Open threats</th></tr></thead>',
    '<tbody>',
    ...[...RISK_LEVELS].reverse().map((risk) => `<tr><th scope="row">${risk}</th><td>${summary.openByRisk[risk]}</td></tr>`),
    `<tr><th scope="row">Total</th><td>${summary.byStatus.open}</td></tr>`,
    '</tbody>',
    '</table>',
  ];
}

export function renderHtml(report: Report): string {
  const { header } = report;
  const title = `Threat model report: ${htmlText(header.threatModelName)}`;
  const picture = renderSvg(report);
  const lines = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`,
    '<meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    `<style>${REPORT_CSS}</style>`,
    '</head>',
    '<body>',
    '<header>',
    `<h1>${title}</h1>`,
    '<dl class="facts">',
    fact('Project', htmlText(header.projectName)),
    fact('Methodology', htmlText(header.methodology)),
    fact('Threat model status', header.threatModelStatus),
    fact('Exported', header.exportedAt),
    fact('Contents', contentsLine(header.counts)),
    '</dl>',
    '</header>',
    '<main>',
    '<section aria-labelledby="summary">',
    '<h2 id="summary">Risk summary</h2>',
    ...summaryTables(report),
    '</section>',
    '<section aria-labelledby="diagram" class="diagram-section">',
    '<h2 id="diagram">Diagram</h2>',
    ...(picture === '' ? ['<p>No elements.</p>'] : ['<figure class="diagram-figure">', picture, `<figcaption id="diagram-caption">${CAPTION}</figcaption>`, '</figure>']),
    '</section>',
    '<section aria-labelledby="elements">',
    '<h2 id="elements">Elements</h2>',
    ...(header.counts.elements === 0 ? ['<p>No elements.</p>'] : []),
    ...report.groups.flatMap(groupSection),
    ...(report.outside.elements.length > 0 ? groupSection(report.outside) : []),
    '</section>',
    '<section aria-labelledby="unlinked">',
    '<h2 id="unlinked">Threats not linked to an element</h2>',
    ...threatsOrNone(report.unlinked, 'None.'),
    '</section>',
    '</main>',
    '</body>',
    '</html>',
  ];
  return `${lines.join('\n')}\n`;
}
