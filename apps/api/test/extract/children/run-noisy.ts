// Runs the noisy child through extractDocument in a process of its own, so that the test can read what that process printed.
import { extractDocument } from '../../../src/extract/run.js';

const result = await extractDocument({
  type: 'pdf',
  bytes: Buffer.from('%PDF-1.4'),
  limits: { maxPages: 10, unpackedBytes: 1_000_000, memoryMb: 256, timeLimitMs: 30_000 },
  entry: new URL('./noisy.ts', import.meta.url),
});
console.log(`RESULT ${result.ok ? 'ok' : 'failed'}`);
