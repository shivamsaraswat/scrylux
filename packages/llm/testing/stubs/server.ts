import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttp2Server, type Http2ServerRequest, type Http2ServerResponse } from 'node:http2';
import type { Socket } from 'node:net';

// A stand-in for a provider's REST API, on 127.0.0.1 with a free port, driven through the real SDKs.
// It records every request and answers from a queue of scripted responses.

export interface RecordedRequest {
  method: string;
  /** The path as sent, still percent-encoded, without the query. */
  path: string;
  query: string;
  headers: IncomingHttpHeaders;
  /** The body parsed as JSON, or undefined when it was empty or not JSON. */
  body: unknown;
  raw: string;
}

export type Scripted =
  | { status?: number; headers?: Record<string, string>; json?: unknown; text?: string }
  /** Never answers; the socket stays open until the test ends. */
  | 'hang'
  /** Destroys the socket without an answer. */
  | 'drop'
  | { delay: number; then: Scripted };

export interface Stub {
  /** The base address, `http://127.0.0.1:<port>`, with no trailing slash. */
  url: string;
  requests: RecordedRequest[];
  /** Queues responses; each request takes the next one. */
  enqueue(...responses: Scripted[]): void;
  /** Answers when the queue is empty. Without one, an empty queue answers 599 so a test fails loudly. */
  setFallback(responder: (request: RecordedRequest) => Scripted): void;
  close(): Promise<void>;
}

export interface StubOptions {
  /** Cleartext HTTP/2 ("prior knowledge"), which is how the AWS SDK talks to Bedrock. */
  http2?: boolean;
}

export async function startStub(options: StubOptions = {}): Promise<Stub> {
  const queue: Scripted[] = [];
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  let fallback: ((request: RecordedRequest) => Scripted) | undefined;

  const handler = (req: IncomingMessage | Http2ServerRequest, res: ServerResponse | Http2ServerResponse): void => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const target = req.url ?? '/';
      const q = target.indexOf('?');
      let body: unknown;
      try {
        body = raw === '' ? undefined : JSON.parse(raw);
      } catch {
        body = undefined;
      }
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        path: q === -1 ? target : target.slice(0, q),
        query: q === -1 ? '' : target.slice(q + 1),
        headers: req.headers,
        body,
        raw,
      };
      requests.push(recorded);
      const scripted = queue.shift() ?? fallback?.(recorded) ?? { status: 599, json: { error: 'stub queue is empty' } };
      play(scripted);

      function play(s: Scripted): void {
        if (s === 'hang') return;
        if (s === 'drop') {
          req.socket.destroy();
          return;
        }
        if ('delay' in s) {
          setTimeout(() => play(s.then), s.delay);
          return;
        }
        const payload = s.text ?? (s.json === undefined ? '' : JSON.stringify(s.json));
        const headers: Record<string, string> = { ...s.headers };
        if (s.json !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type'))
          headers['content-type'] = 'application/json';
        // Http2ServerResponse offers the same writeHead(status, headers) and end(body) as ServerResponse.
        const out = res as ServerResponse;
        out.writeHead(s.status ?? 200, headers);
        out.end(payload);
      }
    });
  };
  const server = options.http2 ? createHttp2Server(handler) : createServer(handler);
  server.on(options.http2 ? 'session' : 'connection', (socket: Socket | { destroy(): void; on(event: 'close', cb: () => void): void }) => {
    const handle = socket as Socket;
    sockets.add(handle);
    handle.on('close', () => sockets.delete(handle));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub server has no port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    enqueue: (...responses) => {
      queue.push(...responses);
    },
    setFallback: (responder) => {
      fallback = responder;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
