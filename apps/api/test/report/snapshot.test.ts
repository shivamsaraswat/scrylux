import { randomUUID } from 'node:crypto';
import { ElementRecord, MitigationRecord, ThreatModelRecord, ThreatRecord } from '@scrylux/core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/app.js';
import db from '../../src/db.js';
import { readSnapshot, withSnapshot } from '../../src/snapshot.js';
import { login, startTestServer, type TestServer } from '../contract/helpers.js';
import { client, seedChain, type Chain, type V1Client } from '../contract/v1/helpers.js';

// research #3: the four reads behind a report see one state of the database, so no mitigation is ever left without
// its threat (SC-002).

describe('the report snapshot', () => {
  let server: TestServer;
  let c: V1Client;
  let chain: Chain;
  let other: Chain;

  beforeAll(async () => {
    server = await startTestServer(app);
    c = client(server.baseUrl, await login(server.baseUrl));
    chain = await seedChain(c);
    other = await seedChain(c);
  });

  afterAll(async () => {
    await server.close();
  });

  it('reads the model with its project, and only its own elements, threats and mitigations', async () => {
    const snapshot = await withSnapshot((trx) => readSnapshot(trx, chain.model.id));
    expect(snapshot).not.toBeNull();
    expect(ThreatModelRecord.parse(snapshot?.model).id).toBe(chain.model.id);
    expect(snapshot?.project.name).toBe(chain.project.name);
    expect(snapshot?.elements.map((e) => ElementRecord.parse(e).id).sort()).toEqual([chain.nodeA.id, chain.nodeB.id, chain.flow.id].sort());
    expect(snapshot?.threats.map((t) => ThreatRecord.parse(t).id)).toEqual([chain.threat.id]);
    expect(snapshot?.mitigations.map((m) => MitigationRecord.parse(m).id)).toEqual([chain.mitigation.id]);
    const ids = JSON.stringify(snapshot);
    for (const foreign of [other.model.id, other.threat.id, other.mitigation.id, other.nodeA.id]) expect(ids).not.toContain(foreign);
  });

  it('runs in one repeatable-read transaction', async () => {
    const level = await withSnapshot(async (trx) => (await sql<{ level: string }>`SELECT current_setting('transaction_isolation') AS level`.execute(trx)).rows[0]?.level);
    expect(level).toBe('repeatable read');
  });

  it('keeps a threat and its mitigations together when they are deleted after the first read', async () => {
    const mine = await seedChain(c);
    const snapshot = await withSnapshot(async (trx) => {
      // The first read fixes the snapshot.
      await sql`SELECT 1 FROM threat_models WHERE id = ${mine.model.id}`.execute(trx);
      // A second connection deletes the threat (its mitigations go with it) and commits.
      await db.query('DELETE FROM threats WHERE id = $1', [mine.threat.id]);
      return readSnapshot(trx, mine.model.id);
    });
    expect(snapshot?.threats.map((t) => t.id)).toEqual([mine.threat.id]);
    expect(snapshot?.mitigations.map((m) => m.id)).toEqual([mine.mitigation.id]);
    // The change itself did happen: a read after the transaction no longer sees them.
    const after = await withSnapshot((trx) => readSnapshot(trx, mine.model.id));
    expect(after?.threats).toEqual([]);
    expect(after?.mitigations).toEqual([]);
  });

  it('answers null for a threat model that does not exist, before reading anything else', async () => {
    expect(await withSnapshot((trx) => readSnapshot(trx, randomUUID()))).toBeNull();
  });
});
