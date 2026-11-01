import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXIT_MEMORY, type ExtractFailure, type ExtractLimits, type ExtractRequest, type ExtractResult } from './types.js';

// Starts the extraction child for one file and waits for its answer (Phase 3 Milestone 3, FR-010, FR-011, research #3). The
// child gets no environment and no standard streams, so a flaw in a parser finds no credential and a library that prints
// cannot write document text into the worker's log. It is killed when the time passes or the run is stopped, so a cancel
// during extraction still takes effect at once.

export type { Block, ExtractFailure, ExtractLimits, ExtractResult, ExtractSuccess } from './types.js';

/** The run was stopped while the child was reading: `reason` is what the signal was aborted with. */
export class ExtractAborted extends Error {
  constructor(readonly reason: unknown) {
    super('extraction aborted');
    this.name = 'ExtractAborted';
  }
}

export interface ExtractInput {
  type: 'pdf' | 'docx';
  bytes: Uint8Array;
  limits: ExtractLimits;
  /** Abort to kill the child; the promise then rejects with an ExtractAborted that holds the signal's reason. */
  signal?: AbortSignal;
  /** The child to start. The worker never sets it: the tests start children that misbehave. */
  entry?: URL;
}

const defaultEntry = (): URL => new URL(import.meta.url.endsWith('.ts') ? './child.ts' : './child.js', import.meta.url);

/** How a child that left without an answer is read. */
function failureOf(code: number | null, signal: NodeJS.Signals | null, killedFor: 'time' | undefined): ExtractFailure {
  if (killedFor === 'time') return { ok: false, category: 'unreadable', detail: 'time' };
  // Its own check, V8 out of heap (SIGABRT), or the kernel's out-of-memory killer (a SIGKILL that was not ours).
  if (code === EXIT_MEMORY || signal === 'SIGABRT' || signal === 'SIGKILL') return { ok: false, category: 'unreadable', detail: 'memory' };
  return { ok: false, category: 'damaged' };
}

const isResult = (value: unknown): value is ExtractResult => typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean';

export function extractDocument(input: ExtractInput): Promise<ExtractResult> {
  const entry = input.entry ?? defaultEntry();
  const source = entry.pathname.endsWith('.ts');
  const heapMb = Math.max(64, Math.floor(input.limits.memoryMb * 0.75));
  const child = fork(fileURLToPath(entry), [], {
    env: {},
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced',
    execArgv: [`--max-old-space-size=${heapMb}`, ...(source ? ['--import', 'tsx'] : [])],
  });

  return new Promise<ExtractResult>((resolve, reject) => {
    let settled = false;
    let killedFor: 'time' | undefined;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      child.kill('SIGKILL');
      settle();
    };
    const timer = setTimeout(() => {
      killedFor = 'time';
      child.kill('SIGKILL');
    }, input.limits.timeLimitMs);
    const onAbort = (): void => finish(() => reject(new ExtractAborted(input.signal?.reason)));

    if (input.signal?.aborted === true) {
      onAbort();
      return;
    }
    input.signal?.addEventListener('abort', onAbort, { once: true });

    child.once('message', (answer: unknown) => finish(() => resolve(isResult(answer) ? answer : { ok: false, category: 'damaged' })));
    child.once('error', () => finish(() => resolve({ ok: false, category: 'damaged' })));
    child.once('exit', (code, signal) => finish(() => resolve(failureOf(code, signal, killedFor))));

    const request: ExtractRequest = { type: input.type, bytes: input.bytes, limits: input.limits };
    child.send(request, (error) => {
      if (error) finish(() => resolve({ ok: false, category: 'damaged' }));
    });
  });
}
