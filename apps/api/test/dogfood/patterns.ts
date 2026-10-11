// What a program can recognise of a credential, personal data or the address of a real deployment (spec FR-010,
// research #9). Data, and nothing else: constitution Principle IV keeps detection heuristics as readable, diffable
// data. Each entry has a sample that must match and a near-miss that must not in checks.test.ts, so a pattern cannot
// rot into one that matches nothing. They are heuristics. A clean scan is not proof, and the review of the three
// files (SC-006) stands behind it.
//
// A pattern is tested on one line at a time, with no `g` flag, and its match is never printed.

export interface Pattern {
  name: string;
  pattern: RegExp;
  description: string;
}

export const PATTERNS: readonly Pattern[] = [
  {
    name: 'email',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
    description: 'an email address',
  },
  {
    name: 'ipv4',
    pattern: /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\w.])/,
    description: 'an IPv4 address',
  },
  {
    // The look-arounds keep the last group of a UUID, which is twelve characters and can be all digits, from matching.
    name: 'account-id',
    pattern: /(?<![\w-])\d{12}(?![\w-])/,
    description: 'a twelve-digit cloud account identifier',
  },
  {
    name: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    description: 'an AWS access key id',
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/,
    description: 'a JSON web token',
  },
  {
    name: 'bearer',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/,
    description: 'a bearer credential',
  },
  {
    name: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    description: 'a private key block',
  },
  {
    name: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36}\b/,
    description: 'a hosting-provider token',
  },
  {
    // An assignment, with `=`, to a name that sounds secret (JWT_SECRET=..., password = ...), or the same as a JSON
    // member. A colon in prose ("token: one 5-minute access token") is not an assignment.
    name: 'secret-assignment',
    pattern: /\b[\w-]*(?:password|passwd|secret|token|api[_-]?key)[\w-]*["']?\s*=\s*["']?[^\s"',;]{3,}|"[\w-]*(?:password|passwd|secret|token|api[_-]?key)[\w-]*"\s*:\s*"[^"]{3,}"/i,
    description: 'a value assigned to a name that sounds secret',
  },
];
