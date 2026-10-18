// Which format a parsed file is in, from its content. The web app uses it to say what it recognised; the API never
// sniffs, it is told the format and refuses a file that isn't in it (research #17).

export type Detected =
  | { format: 'scrylux' | 'otm' | 'threat-dragon' }
  | { format: null; reason: 'threat-dragon-v1' | 'unknown' };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function diagramsOf(file: Record<string, unknown>): Record<string, unknown>[] {
  const detail = file.detail;
  const diagrams = isObject(detail) ? detail.diagrams : undefined;
  return Array.isArray(diagrams) ? diagrams.filter(isObject) : [];
}

// An OTM file is recognised whatever its version, so the import can name the version it refuses. A Threat Dragon file
// is version 2 when its version starts with "2." and its diagrams hold cells; version 1 files keep their diagram in
// `diagramJson`.
export function detectFormat(value: unknown): Detected {
  if (!isObject(value)) return { format: null, reason: 'unknown' };
  if (value.format === 'scrylux') return { format: 'scrylux' };
  if (typeof value.otmVersion === 'string') return { format: 'otm' };
  const diagrams = diagramsOf(value);
  if (diagrams.some((diagram) => 'diagramJson' in diagram)) return { format: null, reason: 'threat-dragon-v1' };
  if (typeof value.version === 'string' && value.version.startsWith('2.') && diagrams.length > 0 && diagrams.every((diagram) => Array.isArray(diagram.cells))) {
    return { format: 'threat-dragon' };
  }
  return { format: null, reason: 'unknown' };
}
