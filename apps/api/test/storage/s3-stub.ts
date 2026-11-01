import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// An in-process stand-in for an S3-compatible service, so that no test needs an account, a secret or a network
// (Phase 3 Milestone 3, FR-050, FR-083). It answers PutObject, GetObject, DeleteObject and ListObjectsV2 with path-style
// addressing, which is all the storage backend uses, and keeps its objects in memory. It does not check signatures.

export interface StubObject {
  body: Buffer;
  modifiedAt: Date;
}

export interface S3Stub {
  /** The address to give as STORAGE_S3_ENDPOINT. */
  endpoint: string;
  bucket: string;
  /** Keys are the full object keys, prefix included. */
  objects: Map<string, StubObject>;
  /** Every request received, as "METHOD /path". */
  requests: string[];
  /** The same requests with their query strings, as "METHOD /path?query". */
  requestsWithQuery: string[];
  /** The next `count` requests are answered with `status` and no work done, as an unavailable service would. */
  failNext(count: number, status?: number): void;
  /** Adds objects without going through the storage backend. */
  seed(key: string, body?: Buffer | string, modifiedAt?: Date): void;
  close(): Promise<void>;
}

const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    request.on('data', (chunk: Buffer) => parts.push(chunk));
    request.on('end', () => resolve(Buffer.concat(parts)));
    request.on('error', reject);
  });
}

function error(response: ServerResponse, status: number, code: string): void {
  response.writeHead(status, { 'content-type': 'application/xml' });
  response.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);
}

export async function startS3Stub(bucket: string): Promise<S3Stub> {
  const objects = new Map<string, StubObject>();
  const requests: string[] = [];
  const requestsWithQuery: string[] = [];
  let failures = 0;
  let failureStatus = 503;

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://stub');
      requests.push(`${request.method ?? ''} ${url.pathname}`);
      requestsWithQuery.push(`${request.method ?? ''} ${url.pathname}${url.search}`);
      const body = await readBody(request);
      if (failures > 0) {
        failures -= 1;
        error(response, failureStatus, 'ServiceUnavailable');
        return;
      }
      const path = decodeURIComponent(url.pathname);
      if (path !== `/${bucket}` && !path.startsWith(`/${bucket}/`)) {
        error(response, 404, 'NoSuchBucket');
        return;
      }
      const key = path.slice(bucket.length + 2);

      if (request.method === 'GET' && key === '') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const maxKeys = Number(url.searchParams.get('max-keys') ?? 1000);
        const start = Number(url.searchParams.get('continuation-token') ?? 0);
        const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const page = all.slice(start, start + maxKeys);
        const truncated = start + maxKeys < all.length;
        const contents = page
          .map((k) => {
            const object = objects.get(k) as StubObject;
            return `<Contents><Key>${escapeXml(k)}</Key><LastModified>${object.modifiedAt.toISOString()}</LastModified><Size>${object.body.length}</Size></Contents>`;
          })
          .join('');
        response.writeHead(200, { 'content-type': 'application/xml' });
        response.end(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${start + maxKeys}</NextContinuationToken>` : ''}${contents}</ListBucketResult>`,
        );
        return;
      }
      if (request.method === 'PUT') {
        objects.set(key, { body, modifiedAt: new Date() });
        response.writeHead(200, { etag: '"stub"' });
        response.end();
        return;
      }
      if (request.method === 'GET') {
        const object = objects.get(key);
        if (object === undefined) {
          error(response, 404, 'NoSuchKey');
          return;
        }
        response.writeHead(200, { 'content-length': object.body.length, 'content-type': 'application/octet-stream', 'last-modified': object.modifiedAt.toUTCString(), etag: '"stub"' });
        response.end(object.body);
        return;
      }
      if (request.method === 'DELETE') {
        objects.delete(key);
        response.writeHead(204);
        response.end();
        return;
      }
      error(response, 405, 'MethodNotAllowed');
    })().catch(() => {
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    bucket,
    objects,
    requests,
    requestsWithQuery,
    failNext(count, status = 503) {
      failures = count;
      failureStatus = status;
    },
    seed(key, body = '', modifiedAt = new Date()) {
      objects.set(key, { body: Buffer.from(body), modifiedAt });
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
