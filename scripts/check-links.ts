import path from 'node:path';
import type { Finding } from './release/versions.js';

// Check L of contracts/checks.md (spec FR-020, FR-021, SC-006). A relative link or an image in the front page, the changelog and
// the release documents points at a file that exists; every image has alt text; the README shows a screenshot and, with the
// screenshots page, the project shows at least four, of at most 600 KB each and 3 MB together; and the front page and the changelog
// link where a visitor goes next. It takes the files'
// text and what is on disk as arguments, so each clause can be shown to fail (links.test.ts). External addresses are not
// followed: the build does not depend on the network.

export const LINK_FILES = [
  'README.md',
  'CHANGELOG.md',
  'docs/releasing.md',
  'docs/demo/README.md',
  'docs/install.md',
  'docs/development.md',
  'docs/roadmap.md',
  'docs/screenshots.md',
];
const SCREENSHOT_PAGES = ['README.md', 'docs/screenshots.md'];
export const MIN_README_IMAGES = 1;
export const MIN_IMAGES = 4;
export const MAX_IMAGE_BYTES = 600 * 1024;
export const MAX_IMAGES_BYTES = 3 * 1024 * 1024;

const IMAGE_DIR = 'docs/images/';
const RELEASES = 'https://github.com/shivamsaraswat/scrylux/releases';

export interface LinkInputs {
  // Repository-relative path -> text, for the files of LINK_FILES that exist.
  files: Record<string, string>;
  // Whether a repository-relative path, a file or a folder, exists.
  exists: (relative: string) => boolean;
  // The files of docs/images/ and their sizes.
  images: { path: string; bytes: number }[];
}

const finding = (file: string, message: string, fix: string): Finding => ({ file, check: 'links', message, fix });

// Code is not read: `[x](y)` in a fenced block or a code span is an example, not a link.
const withoutCode = (text: string): string => text.replace(/^(```|~~~)[\s\S]*?^\1/gm, '').replace(/`[^`\n]*`/g, '');

const LINK = /(!?)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const DEFINITION = /^\[[^\]]+\]:\s+(\S+)/gm;
const isExternal = (target: string): boolean => target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target);

interface Found {
  image: boolean;
  alt: string;
  target: string;
}

function linksOf(text: string): Found[] {
  const code = withoutCode(text);
  const found: Found[] = [...code.matchAll(LINK)].map((m) => ({ image: m[1] === '!', alt: m[2] ?? '', target: m[3] ?? '' }));
  for (const m of code.matchAll(DEFINITION)) found.push({ image: false, alt: '', target: m[1] ?? '' });
  return found;
}

const clean = (target: string): string => target.replace(/[#?].*$/, '');
const resolved = (file: string, target: string): string => path.posix.normalize(path.posix.join(path.posix.dirname(file), clean(target))).replace(/\/$/, '');

const kb = (bytes: number): string => `${Math.round(bytes / 1024)} KB`;

export function checkLinks({ files, exists, images }: LinkInputs): Finding[] {
  const findings: Finding[] = [];
  const reached = new Set<string>();
  const external: string[] = [];
  const shown = new Set<string>();
  const inReadme = new Set<string>();

  for (const file of LINK_FILES) {
    const text = files[file];
    if (text === undefined) {
      findings.push(finding(file, 'the file does not exist', `restore ${file}, which this milestone adds or keeps`));
      continue;
    }
    for (const { image, alt, target } of linksOf(text)) {
      if (isExternal(target)) {
        if (!target.startsWith('#')) external.push(target);
        continue;
      }
      const to = resolved(file, target);
      if (image && alt.trim() === '') findings.push(finding(file, `an image has no alt text: ${to}`, 'describe what it shows, in a sentence, between the brackets'));
      if (!exists(to)) findings.push(finding(file, `links to ${to}, which is not there`, `fix the link, or add ${to}`));
      else if (file === 'README.md' || file === 'CHANGELOG.md') reached.add(to);
      if (image && SCREENSHOT_PAGES.includes(file) && to.startsWith(IMAGE_DIR) && exists(to)) {
        shown.add(to);
        if (file === 'README.md') inReadme.add(to);
      }
    }
  }

  if (files['README.md'] !== undefined && inReadme.size < MIN_README_IMAGES) {
    findings.push(finding('README.md', `it embeds ${inReadme.size} image(s) from ${IMAGE_DIR}, and at least ${MIN_README_IMAGES} is required`, 'embed a screenshot of the demo near the top'));
  }
  if (files['README.md'] !== undefined && shown.size < MIN_IMAGES) {
    findings.push(finding('docs/screenshots.md', `the README and this page embed ${shown.size} image(s) from ${IMAGE_DIR}, and at least ${MIN_IMAGES} are required`, 'take the screenshots of the demo and embed them (docs/screenshots.md)'));
  }
  for (const { path: image, bytes } of images) {
    if (bytes > MAX_IMAGE_BYTES) findings.push(finding(image, `it is ${kb(bytes)}, over the 600 KB limit of one screenshot`, 'optimise it, or crop it to the application area'));
  }
  const total = images.reduce((sum, i) => sum + i.bytes, 0);
  if (total > MAX_IMAGES_BYTES) findings.push(finding(IMAGE_DIR, `the screenshots add up to ${(total / 1024 / 1024).toFixed(1)} MB, more than 3 MB in all`, 'optimise them, or show fewer'));

  const onTheWay = (prefix: string): boolean => [...reached].some((r) => r === prefix || r.startsWith(`${prefix}/`));
  const required: [string, boolean][] = [
    ['the changelog', reached.has('CHANGELOG.md')],
    ['the releases page', external.some((e) => e === RELEASES || e.startsWith(`${RELEASES}/`) || e.startsWith(`${RELEASES}#`))],
    ['the demo', onTheWay('docs/demo')],
    ['the threat model', onTheWay('docs/threat-model')],
    ['the contribution guide', reached.has('CONTRIBUTING.md')],
    ['the security policy', reached.has('SECURITY.md')],
  ];
  for (const [what, linked] of required) {
    if (files['README.md'] !== undefined && !linked) findings.push(finding('README.md', `it (with CHANGELOG.md) does not link ${what}`, 'add the link to the README or the changelog (spec FR-021)'));
  }
  return findings;
}
