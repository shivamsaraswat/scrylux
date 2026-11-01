import Busboy from 'busboy';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { HttpError } from '../v1/errors.js';

// Reading a request body that is a document (Phase 3 Milestone 3, FR-004, research #9). Two things go wrong with a body that is
// up to 10 MB held in memory: there can be many at once, and one can stall. So at most 4 are read at once in a process, by
// uploads and by pastes alike, and a body that stops arriving is given up on. Nothing here reads a file's structure.

/** At most this many bodies are read at once by one process. A fifth is refused, to be tried again in a few seconds (FR-004). */
export const MAX_CONCURRENT_BODIES = 4;
/** How long a body may take to arrive. */
const READ_TIMEOUT_MS = 120_000;
/** What a multipart body adds to its file: boundaries and headers. */
const MULTIPART_SLACK = 16 * 1024;

const BUSY = 'Scrylux is busy reading other uploads. Try again in a few seconds.';

function createLimiter(max: number): RequestHandler {
  let inFlight = 0;
  return (_req: Request, res: Response, next: NextFunction) => {
    if (inFlight >= max) {
      res.set('Retry-After', '5').status(503).json({ error: BUSY });
      return;
    }
    inFlight++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      inFlight--;
    };
    // `close` fires whether the response finished or the client went away.
    res.once('close', release);
    next();
  };
}

/**
 * Middleware: a request beyond the limit is refused before anything of its body is read. One instance for the whole process, so
 * that uploads and pastes share the four places (FR-004): the router mounts this same handler on both.
 */
export const limitBodies: RequestHandler = createLimiter(MAX_CONCURRENT_BODIES);

const tooLarge = (maxBytes: number): HttpError => new HttpError(413, `The file is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB, the most allowed.`);

/** A request whose body is announced as larger than allowed is refused before it is read. */
function checkAnnounced(req: Request, maxBytes: number, slack: number): void {
  const announced = Number(req.headers['content-length']);
  if (Number.isFinite(announced) && announced > maxBytes + slack) throw tooLarge(maxBytes);
}

/** The whole body, if it is at most `maxBytes`. Gives up on a body that stalls. */
function readBytes(req: Request, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      req.destroy();
      reject(new HttpError(408, 'The request took too long to arrive.'));
    }, READ_TIMEOUT_MS);
    req.on('data', (part: Buffer) => {
      size += part.length;
      if (size > maxBytes) {
        clearTimeout(timer);
        req.pause();
        reject(tooLarge(maxBytes));
        return;
      }
      parts.push(part);
    });
    req.once('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(parts));
    });
    req.once('error', () => {
      clearTimeout(timer);
      reject(new HttpError(400, 'The request could not be read.'));
    });
  });
}

/** A JSON body of at most `maxBytes`. The caller validates it. */
export async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send the request as application/json.');
  checkAnnounced(req, maxBytes, 0);
  const bytes = await readBytes(req, maxBytes);
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

export interface UploadedFile {
  /** As the client named it. Checked by the caller before it is used for anything. */
  name: string;
  bytes: Buffer;
}

/**
 * The one file of a multipart body, named `file`. Refused with nothing else read when the announced size is over the limit,
 * when it is over while it arrives, when there is another part or a field, and when there is no file (FR-004).
 */
export function readUpload(req: Request, maxBytes: number): Promise<UploadedFile> {
  checkAnnounced(req, maxBytes, MULTIPART_SLACK);
  if (!/^multipart\/form-data\b/i.test(req.headers['content-type'] ?? '')) {
    return Promise.reject(new HttpError(400, 'Send the file as multipart/form-data, in one part named file.'));
  }
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let name: string | undefined;
    let tooBig = false;
    let failure: HttpError | undefined;
    const timer = setTimeout(() => {
      req.destroy();
      reject(new HttpError(408, 'The request took too long to arrive.'));
    }, READ_TIMEOUT_MS);

    let busboy: Busboy.Busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        defParamCharset: 'utf8',
        // busboy raises `partsLimit` when the count reaches the limit, not when it passes it, so 2 makes it mean "more than the one file".
        limits: { files: 1, fields: 0, parts: 2, fileSize: maxBytes + 1 },
      });
    } catch {
      clearTimeout(timer);
      reject(new HttpError(400, 'Send the file as multipart/form-data, in one part named file.'));
      return;
    }
    const refuse = (error: HttpError): void => {
      failure ??= error;
    };
    busboy.on('file', (field, stream, info) => {
      if (field !== 'file') {
        refuse(new HttpError(400, 'Send the file in one part named file.'));
        stream.resume();
        return;
      }
      name = info.filename;
      stream.on('data', (part: Buffer) => parts.push(part));
      stream.on('limit', () => {
        tooBig = true;
      });
    });
    busboy.on('field', () => refuse(new HttpError(400, 'Send the file in one part named file, and nothing else.')));
    busboy.on('partsLimit', () => refuse(new HttpError(400, 'Send the file in one part named file, and nothing else.')));
    busboy.on('filesLimit', () => refuse(new HttpError(400, 'Send one file at a time.')));
    busboy.on('fieldsLimit', () => refuse(new HttpError(400, 'Send the file in one part named file, and nothing else.')));
    busboy.once('error', () => {
      clearTimeout(timer);
      reject(new HttpError(400, 'The upload could not be read.'));
    });
    busboy.once('close', () => {
      clearTimeout(timer);
      if (tooBig) reject(tooLarge(maxBytes));
      else if (failure !== undefined) reject(failure);
      else if (name === undefined) reject(new HttpError(400, 'Send the file in one part named file.'));
      else resolve({ name, bytes: Buffer.concat(parts) });
    });
    req.pipe(busboy);
  });
}
