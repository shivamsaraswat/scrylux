import { OtmFile, ScryluxFileV1, ThreatDragonFile, checkBounds, detectFormat, type ImportFormat } from '@scrylux/core';
import { HttpError } from '../../v1/errors.js';
import { planOtm } from './otm.js';
import { parseWith } from './parse-with.js';
import type { ImportPlan } from './plan.js';
import { planScrylux } from './scrylux.js';
import { planThreatDragon } from './threat-dragon.js';

// A request's file, from raw JSON to a plan (research #6): bound it, parse it with the chosen format's schema, plan
// it. Nothing walks the file before `checkBounds` has limited its depth and size (FR-020), and every refusal names its
// place under `file`.

interface Parsed {
  scrylux: ScryluxFileV1;
  otm: OtmFile;
  'threat-dragon': ThreatDragonFile;
}

// Scrylux reads OTM 0.2.0 only; a file of another version, or no OTM file at all, is refused before anything else is
// read from it, saying which (research #12).
function parseOtm(raw: unknown): OtmFile {
  const version = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as { otmVersion?: unknown }).otmVersion : undefined;
  if (version !== '0.2.0') throw new HttpError(400, 'file: not an OTM 0.2.0 file');
  return parseWith(OtmFile, raw);
}

// One parser per import format, typed by the list, so a format without one is a type error.
// Scrylux reads Threat Dragon version 2 only. A version 1 file keeps its diagram in `diagramJson`; opening and saving it
// in Threat Dragon 2 converts it, which the message says (research #13).
function parseThreatDragon(raw: unknown): ThreatDragonFile {
  const detected = detectFormat(raw);
  if (detected.format !== 'threat-dragon') {
    throw new HttpError(
      400,
      detected.format === null && detected.reason === 'threat-dragon-v1'
        ? 'file: Threat Dragon version 1 files are not supported; open and save the model in Threat Dragon 2 first'
        : 'file: not a Threat Dragon version 2 file',
    );
  }
  return parseWith(ThreatDragonFile, raw);
}

const PARSERS: { [F in ImportFormat]: (raw: unknown) => Parsed[F] } = {
  scrylux: (raw) => parseWith(ScryluxFileV1, raw),
  otm: parseOtm,
  'threat-dragon': parseThreatDragon,
};

export function parseFile<F extends ImportFormat>(format: F, raw: unknown): Parsed[F] {
  const bounds = checkBounds(raw);
  if (!bounds.ok) throw new HttpError(400, bounds.message);
  return PARSERS[format](raw);
}

export function planImport(format: ImportFormat, raw: unknown): ImportPlan {
  switch (format) {
    case 'scrylux':
      return planScrylux(parseFile('scrylux', raw));
    case 'otm':
      return planOtm(parseFile('otm', raw));
    case 'threat-dragon':
      return planThreatDragon(parseFile('threat-dragon', raw));
  }
}
