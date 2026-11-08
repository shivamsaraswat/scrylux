import type { DraftAnswer } from '@scrylux/core';

// Fixtures for the extraction tests (Phase 3 Milestone 4, tasks T003): the chunks a request sent, and a valid answer that cites
// them. Every quote is an exact passage of its chunk, so the answer passes the request's checks until a test breaks one rule.

export interface SentChunk {
  label: string;
  text: string;
}

export const CHUNK_TEXTS = {
  c1:
    'The web application is a single page application served by the API.\n' +
    'Users sign in with a username and a password.\n' +
    'The API is exposed to the internet through a load balancer.',
  c2:
    'The API stores threats in a PostgreSQL database. Database traffic is encrypted in transit with TLS.\n' +
    'The database runs in a private network and is reachable only from the API and the worker.',
  c3:
    'The worker reads jobs from the database and calls the model provider over HTTPS.\n' +
    'The API never calls the provider.',
} as const;

export const CHUNKS: SentChunk[] = Object.entries(CHUNK_TEXTS).map(([label, text]) => ({ label, text }));

const cite = (chunk: keyof typeof CHUNK_TEXTS, quote: string) => ({ chunk, quote });

/** A valid answer for CHUNKS: boundaries, nodes, flows with flags, an asset and an assumption. Fresh on every call. */
export function validAnswer(): DraftAnswer {
  return {
    elements: [
      {
        ref: 'internet',
        type: 'trust_boundary',
        name: 'Internet',
        boundary: null,
        source: null,
        target: null,
        flags: [],
        rationale: 'The API is reachable from the internet, outside the private network.',
        citations: [cite('c1', 'exposed to the internet')],
      },
      {
        ref: 'private_net',
        type: 'trust_boundary',
        name: 'Private network',
        boundary: null,
        source: null,
        target: null,
        flags: [],
        rationale: 'The database runs in a private network.',
        citations: [cite('c2', 'runs in a private network')],
      },
      {
        ref: 'user',
        type: 'external_entity',
        name: 'User',
        boundary: 'internet',
        source: null,
        target: null,
        flags: [{ flag: 'authenticated', value: true, citations: [cite('c1', 'sign in with a username and a password')] }],
        rationale: 'People use the application and sign in.',
        citations: [cite('c1', 'Users sign in with a username')],
      },
      {
        ref: 'api',
        type: 'process',
        name: 'API',
        boundary: 'internet',
        source: null,
        target: null,
        flags: [{ flag: 'internet_facing', value: true, citations: [cite('c1', 'The API is exposed to the internet')] }],
        rationale: 'The API serves the web application and stores threats.',
        citations: [cite('c1', 'served by the API'), cite('c2', 'The API stores threats')],
      },
      {
        ref: 'worker',
        type: 'process',
        name: 'Worker',
        boundary: 'private_net',
        source: null,
        target: null,
        flags: [],
        rationale: 'A worker process runs jobs and calls the provider.',
        citations: [cite('c3', 'The worker reads jobs from the database')],
      },
      {
        ref: 'db',
        type: 'data_store',
        name: 'Database',
        boundary: 'private_net',
        source: null,
        target: null,
        flags: [{ flag: 'internet_facing', value: false, citations: [cite('c2', 'reachable only from the API and the worker')] }],
        rationale: 'Threats are kept in a PostgreSQL database.',
        citations: [cite('c2', 'stores threats in a PostgreSQL database')],
      },
      {
        ref: 'provider',
        type: 'external_entity',
        name: 'Model provider',
        boundary: null,
        source: null,
        target: null,
        flags: [],
        rationale: 'The worker calls a model provider.',
        citations: [cite('c3', 'calls the model provider over HTTPS')],
      },
      {
        ref: 'api_db',
        type: 'data_flow',
        name: 'Threat data',
        boundary: null,
        source: 'api',
        target: 'db',
        flags: [{ flag: 'encrypted_in_transit', value: true, citations: [cite('c2', 'Database traffic is encrypted in transit with TLS')] }],
        rationale: 'The API reads and writes threats in the database.',
        citations: [cite('c2', 'The API stores threats')],
      },
      {
        ref: 'worker_provider',
        type: 'data_flow',
        name: 'Model requests',
        boundary: null,
        source: 'worker',
        target: 'provider',
        flags: [{ flag: 'encrypted_in_transit', value: true, citations: [cite('c3', 'calls the model provider over HTTPS')] }],
        rationale: 'The worker sends requests to the provider.',
        citations: [cite('c3', 'calls the model provider over HTTPS')],
      },
    ],
    assets: [
      {
        ref: 'threat_data',
        name: 'Threat data',
        description: 'The threats the application stores.',
        held_by: ['db'],
        rationale: 'The database holds the threats.',
        citations: [cite('c2', 'stores threats in a PostgreSQL database')],
      },
    ],
    assumptions: [
      {
        ref: 'private_db',
        statement: 'The database is reachable only from the API and the worker.',
        rationale: 'The design relies on the network keeping everyone else out.',
        citations: [cite('c2', 'reachable only from the API and the worker')],
      },
    ],
    nothing_found: null,
  };
}
