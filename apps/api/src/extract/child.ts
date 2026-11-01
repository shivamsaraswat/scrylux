import { readDocx } from './docx.js';
import { readPdf } from './pdf.js';
import { EXIT_MEMORY, type ExtractRequest, type ExtractResult } from './types.js';

// The extraction child's entry point (Phase 3 Milestone 3, FR-010, research #3): `node dist/extract/child.js`, started by
// the worker with no environment, no standard streams and an IPC channel. It reads one message, reads the file, answers
// once and exits. It loads no configuration, database, storage or provider module, and has no credential to lose.

process.once('message', (message: ExtractRequest) => {
  void (async () => {
    const memoryLimit = message.limits.memoryMb * 1024 * 1024;
    // Between pages and parts: a file that needs more memory than it may ends the child, which the worker reads as a bound.
    const guard = (): void => {
      if (process.memoryUsage.rss() > memoryLimit) process.exit(EXIT_MEMORY);
    };
    let result: ExtractResult;
    try {
      result = message.type === 'pdf' ? await readPdf(message.bytes, message.limits, guard) : await readDocx(message.bytes, message.limits, guard);
    } catch {
      result = { ok: false, category: 'damaged' };
    }
    process.send?.(result, () => process.exit(0));
  })();
});
