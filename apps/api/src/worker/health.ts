import { createServer, type Server } from 'node:http';

// The worker's health check (Phase 3 Milestone 2, FR-010, research #10): `GET /health` answers 200 while the process is up.
// No authentication, no database, no provider, as the API's /health (Principle IV): it says only that the process is alive,
// which is what a container platform asks. It serves nothing else, and imports nothing of the application.

export interface HealthServer {
  /** The port it listens on: the one asked for, or the one the system chose when asked for 0. */
  port: number;
  close(): Promise<void>;
}

export function startHealthServer(port: number): Promise<HealthServer> {
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"Not found"}');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address !== null ? address.port : port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
