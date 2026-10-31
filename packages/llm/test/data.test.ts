import { describe, expect, it } from 'vitest';
import { fillPlaceholders, parseStrictYaml } from '../src/data.js';

describe('parseStrictYaml', () => {
  it('parses plain YAML 1.2 and keeps a date as text', () => {
    expect(parseStrictYaml('t.yaml', 'a: yes\nchecked: 2026-10-06\n')).toEqual({
      a: 'yes',
      checked: '2026-10-06',
    });
  });

  it('refuses an alias and an anchor', () => {
    expect(() => parseStrictYaml('t.yaml', 'a: &x 1\nb: *x\n')).toThrow(/alias|anchor/);
    expect(() => parseStrictYaml('t.yaml', 'a: &x 1\n')).toThrow(/anchor/);
  });

  it('refuses a duplicate key', () => {
    expect(() => parseStrictYaml('t.yaml', 'a: 1\na: 2\n')).toThrow(/t\.yaml/);
  });

  it('refuses a custom tag', () => {
    expect(() => parseStrictYaml('t.yaml', 'a: !custom 1\n')).toThrow(/t\.yaml/);
  });

  it('refuses a file with several documents', () => {
    expect(() => parseStrictYaml('t.yaml', 'a: 1\n---\nb: 2\n')).toThrow(/t\.yaml/);
  });

  it('treats a parser warning as an error', () => {
    expect(() => parseStrictYaml('t.yaml', '%UNKNOWN directive\n---\na: 1\n')).toThrow(/t\.yaml/);
  });

  it('names the file in the message', () => {
    expect(() => parseStrictYaml('models.yaml', 'a: [\n')).toThrow(/models\.yaml/);
  });
});

describe('fillPlaceholders', () => {
  it('replaces each placeholder', () => {
    expect(fillPlaceholders('a {{x}} b {{y}} c {{x}}', { x: '1', y: '2' })).toBe('a 1 b 2 c 1');
  });

  it('does not expand a placeholder inside an inserted value', () => {
    expect(fillPlaceholders('{{issues}} and {{nonce}}', { issues: 'see {{nonce}}', nonce: 'N' })).toBe(
      'see {{nonce}} and N',
    );
  });

  it('throws when a named placeholder is missing from the text', () => {
    expect(() => fillPlaceholders('no placeholder here', { x: '1' })).toThrow(/x/);
  });

  it('throws when the text has a placeholder the values lack', () => {
    expect(() => fillPlaceholders('a {{x}} {{y}}', { x: '1' })).toThrow(/y/);
  });

  it('inserts a value containing $ patterns literally', () => {
    expect(fillPlaceholders('{{x}}', { x: "$& $1 $'" })).toBe("$& $1 $'");
  });
});
