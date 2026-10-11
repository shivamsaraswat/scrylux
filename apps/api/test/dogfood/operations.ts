import type { ExportedFile } from '../../src/exchange/specter-export.js';
import { client, uniqueName, type ApiRecord, type V1Client } from '../contract/v1/helpers.js';
import { specterBody, type ExchangeFile } from '../exchange/fixtures.js';
import type { Regeneration, SummaryLike } from './checks.js';

// The calls the checks make to the app, and nothing else: each is an existing operation behind the sign-in, called as a
// user's script would call it (contracts/checks.md, "What they read and what they call"). checks.ts stays free of I/O.
// Nothing here writes a committed file: the models are scratch, made in a project of their own with a unique name (a
// project cannot be called `Specter`: names are unique across the install, research #5), and the suite's teardown
// deletes every project created during the run.

export interface Session {
  baseUrl: string;
  token: string;
  c: V1Client;
}

export const session = (baseUrl: string, token: string): Session => ({ baseUrl, token, c: client(baseUrl, token) });

export interface Answer {
  status: number;
  body: unknown;
}

const asBody = (data: ExportedFile, names?: string[]) => specterBody(data as unknown as ExchangeFile, names);

export async function newProject(s: Session): Promise<string> {
  const made = await s.c.post<ApiRecord>('/projects', { name: uniqueName('Dogfood') });
  if (made.status !== 201) throw new Error(`could not create a scratch project: ${made.status}`);
  return made.body.id;
}

// `POST /projects/{id}/imports/check`: the summary an import would give, or the refusal.
export function checkImport(s: Session, projectId: string, data: ExportedFile, names?: string[]): Promise<Answer> {
  return s.c.post(`/projects/${projectId}/imports/check`, asBody(data, names));
}

// `POST /projects/{id}/imports`: the id of the threat model it created. A name is given only to keep two models of one
// file apart in one project.
export async function importModel(s: Session, projectId: string, data: ExportedFile, name?: string): Promise<string> {
  const res = await s.c.post<{ threat_models: ApiRecord[] }>(`/projects/${projectId}/imports`, asBody(data, name === undefined ? undefined : [name]));
  const created = res.body.threat_models?.[0];
  if (res.status >= 300 || created === undefined) {
    throw new Error(`the import was refused: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return created.id;
}

const authorized = (s: Session): RequestInit => ({ headers: { Authorization: `Bearer ${s.token}` } });

// `GET /threat-models/{id}/export?format=specter`.
export async function exportSpecter(s: Session, modelId: string): Promise<ExportedFile> {
  const res = await fetch(`${s.baseUrl}/api/v1/threat-models/${modelId}/export?format=specter`, authorized(s));
  if (res.status !== 200) throw new Error(`the export failed: ${res.status}`);
  return JSON.parse(await res.text()) as ExportedFile;
}

// `GET /threat-models/{id}/report?format=markdown`: text, not JSON, so it does not go through the JSON client.
export async function reportMarkdown(s: Session, modelId: string): Promise<string> {
  const res = await fetch(`${s.baseUrl}/api/v1/threat-models/${modelId}/report?format=markdown`, authorized(s));
  if (res.status !== 200) throw new Error(`the report failed: ${res.status}`);
  return res.text();
}

// The committed file imported twice into one scratch project: model A is never generated against (checks 2 and 7 use
// it), model B is (check 6 uses it). Generation creates a threat for every rule the model is behind on, so run on the
// model that is then exported or reported it would put those threats in both, and "behind the rules" would fail checks
// 2 and 7 instead of only warning (contracts/checks.md, "Two scratch imports").
export async function importTwice(s: Session, data: ExportedFile): Promise<{ projectId: string; a: string; b: string; summary: SummaryLike }> {
  const projectId = await newProject(s);
  const summary = (await checkImport(s, projectId, data)).body as SummaryLike;
  const a = await importModel(s, projectId, data);
  const b = await importModel(s, projectId, data, `${data.threat_model.name} (generated against)`);
  return { projectId, a, b, summary };
}

// `POST /threat-models/{id}/threats/generate`, then what it left: the threats (each carries its `stale` mark) and the
// elements, which classifyRegeneration reads, and the elements generation skipped.
export async function regenerate(s: Session, modelId: string): Promise<Pick<Regeneration, 'afterThreats' | 'afterElements' | 'skippedElements'>> {
  const run = await s.c.post<{ skipped_elements: string[] }>(`/threat-models/${modelId}/threats/generate`, {});
  if (run.status !== 200) throw new Error(`generation failed: ${run.status}`);
  const threats = await s.c.get<Regeneration['afterThreats'][number][]>(`/threat-models/${modelId}/threats`);
  const elements = await s.c.get<Regeneration['afterElements'][number][]>(`/threat-models/${modelId}/elements`);
  return { afterThreats: threats.body, afterElements: elements.body, skippedElements: run.body.skipped_elements };
}
