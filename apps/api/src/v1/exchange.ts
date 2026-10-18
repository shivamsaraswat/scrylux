import {
  ExportQuery,
  IMPORT_MAX_BYTES,
  ImportInput,
  ImportResult,
  ImportSummary,
} from '@scrylux/core';
import { buildOtmFile } from '../exchange/otm-export.js';
import { buildScryluxFile, serializeExport } from '../exchange/scrylux-export.js';
import { exchangeFilename } from '../exchange/filename.js';
import { planImport } from '../exchange/import/parse.js';
import { checkImport, runImport } from '../exchange/import/write.js';
import { readSnapshot, withSnapshot } from '../snapshot.js';
import { orNotFound } from './errors.js';
import { DOWNLOAD_CSP, defineOperation, type Operation, type TextResult } from './operation.js';
import { logImport } from './write-log.js';

// Export and import (contracts/exchange-api.md). An export is a read, like a report. A check and an import take the same
// body; the check creates nothing, and the import runs the same pipeline and then writes (research #1, #6).

export const exchangeOperations: Operation<unknown>[] = [
  defineOperation<never, ExportQuery>({
    method: 'get',
    path: '/threat-models/:id/export',
    operationId: 'exportThreatModel',
    summary: 'Download a threat model as a file',
    description:
      'The whole threat model as one JSON file, lossless: its diagram, threats and mitigations, with every status, reason, origin and stale mark, in a fixed order. ' +
      '`format` chooses the file: `scrylux` (described by the published schema `docs/formats/scrylux-file-v1.schema.json`) or `otm` (Open Threat Model 0.2.0, with Scrylux\'s own fields in `attributes.scrylux` so Scrylux reads it back without loss). ' +
      'It is sent as an attachment, named after the threat model and the export date, and nothing may keep a copy of it (Cache-Control: no-store). ' +
      'The threat model is read in one snapshot. Two exports of an unchanged threat model differ only in the export time. The file holds no account name, account id or credential.',
    query: { name: 'ExportQuery', schema: ExportQuery },
    text: { mediaTypes: ['application/json'] },
    status: 200,
    errors: [400, 404],
    handler: async ({ id, query }): Promise<TextResult> => {
      const snapshot = orNotFound((await withSnapshot((trx) => readSnapshot(trx, id))) ?? undefined, 'Threat model');
      // One instant for the file and its name, so they cannot disagree near midnight.
      const exportedAt = new Date();
      return {
        body: serializeExport(query.format === 'otm' ? buildOtmFile(snapshot, exportedAt) : buildScryluxFile(snapshot, exportedAt)),
        contentType: 'application/json; charset=utf-8',
        filename: exchangeFilename(snapshot.model.name, query.format, exportedAt),
        csp: DOWNLOAD_CSP,
      };
    },
  }),
  defineOperation<ImportInput>({
    method: 'post',
    path: '/projects/:id/imports/check',
    operationId: 'checkImport',
    summary: 'Check a file for import, creating nothing',
    description:
      'Runs everything an import runs except the writing, and creates nothing. It answers what the import would create (the name, status and counts of each threat model) and everything in the file that would not be carried over or would be changed to fit. ' +
      'A name already used in the project, empty, too long or repeated in the file is reported on the model as name_issue, not refused. ' +
      'The body is `{ format, names?, file }`; `file` is the parsed file, up to 64 MiB, 64 levels deep and 2,000,000 values. A file that cannot be imported at all is a 400 naming the rule and its place in the file.',
    body: { name: 'ImportInput', schema: ImportInput },
    bodyLimit: IMPORT_MAX_BYTES,
    response: { name: 'ImportSummary', schema: ImportSummary },
    status: 200,
    errors: [404],
    handler: ({ id, body }) => checkImport(id, planImport(body.format, body.file), body.names),
  }),
  defineOperation<ImportInput>({
    method: 'post',
    path: '/projects/:id/imports',
    operationId: 'importThreatModel',
    summary: 'Import a file as new threat models of a project',
    description:
      'Creates a new threat model in the project from the file, all or nothing, in one transaction; it never changes an existing threat model. The body is the same as for checkImport. ' +
      'Every record gets a new id, so the same file can be imported twice. An imported threat keeps the status it carries, even without a reason or an implemented mitigation, and is then shown as missing what its status needs. ' +
      'Generated threats keep their rule and stale mark; a file with an AI-drafted threat is refused. A name with an issue is refused: 409 when it is taken, 400 otherwise. ' +
      'The response holds the created threat models and the same summary checkImport gives.',
    body: { name: 'ImportInput', schema: ImportInput },
    bodyLimit: IMPORT_MAX_BYTES,
    response: { name: 'ImportResult', schema: ImportResult },
    status: 201,
    errors: [404, 409],
    // No recordType: the router would log one line for the project. The handler logs the import.
    handler: async ({ id, body, accountId }) => {
      const { threatModels, summary } = await runImport(id, planImport(body.format, body.file), body.names);
      // The transaction has committed, so what is logged is stored.
      const total = (field: 'elements' | 'threats' | 'mitigations'): number => summary.models.reduce((sum, model) => sum + model[field], 0);
      logImport(accountId, id, threatModels.map((model) => model.id), {
        elements: total('elements'),
        threats: total('threats'),
        mitigations: total('mitigations'),
        notes: summary.notes.length,
      });
      return { threat_models: threatModels, summary };
    },
  }),
];
