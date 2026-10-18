import { ReportQuery, type ReportFormat } from '@scrylux/core';
import { buildReport, type Report } from '../report/model.js';
import { reportFilename } from '../report/filename.js';
import { renderHtml } from '../report/html.js';
import { renderMarkdown } from '../report/markdown.js';
import { readSnapshot, withSnapshot } from '../snapshot.js';
import { orNotFound } from './errors.js';
import { DOWNLOAD_CSP, defineOperation, type Operation, type TextResult } from './operation.js';

// One renderer per format core's ReportQuery allows. Typed by that list, so a format without a renderer, or a
// renderer without a format, is a type error.
interface Renderer {
  contentType: string;
  render(report: Report): string;
  // Replaces the app's Content-Security-Policy on this response only.
  csp?: string;
}

const RENDERERS: Record<ReportFormat, Renderer> = {
  markdown: { contentType: 'text/markdown; charset=utf-8', render: renderMarkdown },
  html: { contentType: 'text/html; charset=utf-8', render: renderHtml, csp: DOWNLOAD_CSP },
};

const mediaTypes = Object.values(RENDERERS).map(({ contentType }) => contentType.split(';')[0] as string);

export const reportOperations: Operation<unknown>[] = [
  defineOperation<never, ReportQuery>({
    method: 'get',
    path: '/threat-models/:id/report',
    operationId: 'getThreatModelReport',
    summary: 'Download a report of one threat model',
    description:
      'The whole threat model as a document: its header, risk summary, diagram, every element grouped by trust boundary with its threats and their mitigations, and the threats not linked to an element. ' +
      '`format` chooses the document. It is sent as an attachment, named after the threat model and the export date, and nothing may keep a copy of it (Cache-Control: no-store). ' +
      'The threat model is read in one snapshot. Two exports of an unchanged threat model differ only in the export time in their header.',
    query: { name: 'ReportQuery', schema: ReportQuery },
    text: { mediaTypes },
    status: 200,
    errors: [400, 404],
    handler: async ({ id, query }): Promise<TextResult> => {
      const snapshot = orNotFound((await withSnapshot((trx) => readSnapshot(trx, id))) ?? undefined, 'Threat model');
      // One instant for the header and the file name, so they cannot disagree near midnight.
      const exportedAt = new Date();
      const renderer = RENDERERS[query.format];
      return {
        body: renderer.render(buildReport(snapshot, exportedAt)),
        contentType: renderer.contentType,
        filename: reportFilename(snapshot.model.name, query.format, exportedAt),
        ...(renderer.csp === undefined ? {} : { csp: renderer.csp }),
      };
    },
  }),
];
