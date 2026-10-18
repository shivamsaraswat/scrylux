import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkLinks, MAX_IMAGE_BYTES, MAX_IMAGES_BYTES, MIN_README_IMAGES, type LinkInputs } from './check-links.js';
import { formatFinding } from './release/versions.js';

// Check L of contracts/checks.md (spec FR-020, FR-021, SC-006): a relative link or an image of the README, the changelog and the
// release documents points at a file that exists; every image has alt text; the README shows at least four screenshots of at most
// 600 KB each and 3 MB together; and the front page links where a visitor goes next. The check takes the files' text and what is
// on disk as arguments, so each clause is shown to fail on input made to break it.

const IMAGES = ['diagram-editor', 'threats-for-element', 'report', 'import-export'].map((n) => `docs/images/${n}.png`);

// A set of files that satisfies every clause: the README embeds four images and links everything required.
function good(): LinkInputs {
  const readme = [
    '# Scrylux',
    ...IMAGES.map((p, i) => `![Screenshot ${i + 1} of the demo](${p})`),
    'See the [changelog](CHANGELOG.md), the [releases](https://github.com/shivamsaraswat/scrylux/releases), the [demo](docs/demo/),',
    'the [threat model](docs/threat-model/), [contributing](CONTRIBUTING.md) and [security](SECURITY.md).',
  ].join('\n');
  const files: Record<string, string> = {
    'README.md': readme,
    'CHANGELOG.md': '# Changelog\n[0.1.0]: https://github.com/shivamsaraswat/scrylux/releases/tag/v0.1.0',
    'docs/releasing.md': 'See the [README](../README.md).',
    'docs/demo/README.md': 'Back to the [README](../../README.md).',
  };
  const onDisk = new Set([...Object.keys(files), ...IMAGES, 'CONTRIBUTING.md', 'SECURITY.md', 'docs/demo/notes-app.scrylux.json', 'docs/threat-model/README.md']);
  return { files, exists: (p) => onDisk.has(p.replace(/\/$/, '')) || [...onDisk].some((f) => f.startsWith(p.endsWith('/') ? p : `${p}/`)), images: IMAGES.map((p) => ({ path: p, bytes: 100_000 })) };
}

const said = (input: LinkInputs): string => checkLinks(input).map(formatFinding).join('\n');

describe('a README that satisfies every clause', () => {
  it('finds nothing', () => {
    expect(checkLinks(good())).toEqual([]);
  });
});

describe('links and images that point nowhere', () => {
  it('names a relative link whose target is not there, and the file that holds it', () => {
    const input = good();
    input.files['docs/releasing.md'] = 'See [the missing page](missing.md).';
    const text = said(input);
    expect(text).toContain('docs/releasing.md');
    expect(text).toContain('docs/missing.md');
  });

  it('resolves a link from the folder of the file that holds it', () => {
    const input = good();
    input.files['docs/demo/README.md'] = 'See [the file](notes-app.scrylux.json) and [the same, wrongly](docs/demo/notes-app.scrylux.json).';
    const text = said(input);
    expect(text).not.toContain('docs/demo/notes-app.scrylux.json:');
    expect(text).toContain('docs/demo/docs/demo/notes-app.scrylux.json');
  });

  it('names an image that is not there', () => {
    const input = good();
    input.files['README.md'] = `${input.files['README.md'] ?? ''}\n![Another shot](docs/images/nothing.png)`;
    expect(said(input)).toContain('docs/images/nothing.png');
  });

  it('ignores an anchor, a query and an external address, and checks the file before them', () => {
    const input = good();
    input.files['docs/releasing.md'] = '[a](#top) [b](../README.md#section) [c](../README.md?x=1) [d](https://example.invalid/x) [e](mailto:someone@example.invalid)';
    expect(checkLinks(input)).toEqual([]);
  });

  it('checks a link written as a reference definition, and ignores one that is external', () => {
    const input = good();
    input.files['CHANGELOG.md'] = '# Changelog\n[0.1.0]: https://github.com/shivamsaraswat/scrylux/releases/tag/v0.1.0\n[local]: nowhere.md';
    const text = said(input);
    expect(text).toContain('nowhere.md');
    expect(text).not.toContain('releases/tag');
  });

  it('does not read a link in a code block or in a code span', () => {
    const input = good();
    input.files['docs/releasing.md'] = ['```sh', '[x](nowhere-in-a-fence.md)', '```', 'and `[y](nowhere-in-a-span.md)` too'].join('\n');
    expect(checkLinks(input)).toEqual([]);
  });

  it('refuses a file of the set that does not exist', () => {
    const input = good();
    delete input.files['docs/releasing.md'];
    expect(said(input)).toContain('docs/releasing.md');
  });
});

describe('images (FR-020)', () => {
  it('refuses an image with no alt text', () => {
    const input = good();
    input.files['README.md'] = (input.files['README.md'] ?? '').replace('![Screenshot 1 of the demo]', '![]');
    expect(said(input)).toMatch(/no alt text/);
  });

  it('refuses a README that shows fewer than four images from docs/images/', () => {
    const input = good();
    input.files['README.md'] = (input.files['README.md'] ?? '').replace(/!\[Screenshot 4 of the demo\]\([^)]*\)\n?/, '');
    expect(MIN_README_IMAGES).toBe(4);
    expect(said(input)).toMatch(/3 image/);
  });

  it('does not count the same image twice, or an image from somewhere else', () => {
    const input = good();
    input.files['README.md'] = (input.files['README.md'] ?? '').replace(IMAGES[3] ?? '', IMAGES[0] ?? '');
    expect(said(input)).toMatch(/3 image/);
    input.files['README.md'] = (input.files['README.md'] ?? '').replace(IMAGES[2] ?? '', 'docs/demo/notes-app.scrylux.json');
    expect(said(input)).toMatch(/2 image/);
  });

  it('refuses an image over 600 KB, naming it', () => {
    const input = good();
    input.images = [{ path: IMAGES[0] ?? '', bytes: MAX_IMAGE_BYTES + 1 }, ...input.images.slice(1)];
    const text = said(input);
    expect(MAX_IMAGE_BYTES).toBe(600 * 1024);
    expect(text).toContain(IMAGES[0]);
    expect(text).toMatch(/600 KB/);
  });

  it('accepts an image of exactly 600 KB', () => {
    const input = good();
    input.images = input.images.map((i) => ({ ...i, bytes: MAX_IMAGE_BYTES }));
    expect(said(input)).not.toMatch(/600 KB/);
  });

  it('refuses images that together exceed 3 MB', () => {
    const input = good();
    input.images = [...input.images, { path: 'docs/images/extra-1.png', bytes: 500_000 }, { path: 'docs/images/extra-2.png', bytes: 500_000 }];
    input.images = input.images.map((i) => ({ ...i, bytes: 560_000 }));
    expect(MAX_IMAGES_BYTES).toBe(3 * 1024 * 1024);
    expect(said(input)).toMatch(/3 MB in all/);
  });
});

describe('where a visitor goes next (FR-021)', () => {
  it.each([
    ['the changelog', '[changelog](CHANGELOG.md)'],
    ['the releases page', '[releases](https://github.com/shivamsaraswat/scrylux/releases)'],
    ['the demo', '[demo](docs/demo/)'],
    ['the threat model', '[threat model](docs/threat-model/)'],
    ['the contribution guide', '[contributing](CONTRIBUTING.md)'],
    ['the security policy', '[security](SECURITY.md)'],
  ])('refuses a README and a changelog that do not link %s', (what, link) => {
    const input = good();
    input.files['README.md'] = (input.files['README.md'] ?? '').replace(link, 'nothing');
    // The changelog's own link to its release is a link to the releases page too, so it goes as well.
    input.files['CHANGELOG.md'] = (input.files['CHANGELOG.md'] ?? '').replace(/^\[0\.1\.0\]: .*$/m, '');
    expect(said(input)).toContain(`does not link ${what}`);
  });

  it('accepts a link that is only in the changelog', () => {
    const input = good();
    input.files['README.md'] = (input.files['README.md'] ?? '').replace('[security](SECURITY.md)', 'nothing');
    input.files['CHANGELOG.md'] = `${input.files['CHANGELOG.md'] ?? ''}\n[security](SECURITY.md)`;
    expect(checkLinks(input)).toEqual([]);
  });

  it('accepts a link to a file under a folder, and to a folder written without its slash', () => {
    const input = good();
    input.files['README.md'] = (input.files['README.md'] ?? '').replace('(docs/demo/)', '(docs/demo/README.md)').replace('(docs/threat-model/)', '(docs/threat-model)');
    expect(checkLinks(input)).toEqual([]);
  });
});

describe("this repository's own front page, changelog and release documents", () => {
  const root = path.resolve(import.meta.dirname, '..');
  const rel = (p: string): string => p.split(path.sep).join('/');
  const FILES = ['README.md', 'CHANGELOG.md', 'docs/releasing.md', 'docs/demo/README.md'];

  it('link only to what exists, show at least four small screenshots, and link where a visitor goes next (SC-006)', () => {
    const files: Record<string, string> = {};
    for (const f of FILES) if (existsSync(path.join(root, f))) files[f] = readFileSync(path.join(root, f), 'utf8');
    const dir = path.join(root, 'docs', 'images');
    const images = existsSync(dir)
      ? readdirSync(dir)
          .filter((n) => /\.(png|jpe?g|gif|webp|svg)$/i.test(n))
          .map((n) => ({ path: rel(path.join('docs', 'images', n)), bytes: statSync(path.join(dir, n)).size }))
      : [];
    const findings = checkLinks({ files, exists: (p) => existsSync(path.join(root, p)), images });
    if (findings.length > 0) throw new Error(`\n${findings.map(formatFinding).join('\n\n')}`);
  });
});
