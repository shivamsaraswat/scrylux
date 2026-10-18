// The words the editor uses for each security flag (spec FR-015). The keys are the shared vocabulary in
// @scrylux/core; this file only gives them names a person reads.
export const FLAG_LABELS: Record<string, string> = {
  authenticated: 'Authenticated',
  internet_facing: 'Internet facing',
  requires_authentication: 'Requires authentication',
  handles_sensitive_data: 'Handles sensitive data',
  runs_privileged: 'Runs privileged',
  stores_sensitive_data: 'Stores sensitive data',
  encrypted_at_rest: 'Encrypted at rest',
  encrypted_in_transit: 'Encrypted in transit',
  carries_sensitive_data: 'Carries sensitive data',
};

// One line on what a flag means, since the same word means different things on different element types.
export const FLAG_HINTS: Record<string, string> = {
  authenticated: 'It proves its identity to the system.',
  internet_facing: 'It can be reached from the public internet.',
  requires_authentication: 'Its callers must authenticate.',
  handles_sensitive_data: 'It processes sensitive data.',
  runs_privileged: 'It runs with elevated or administrative privileges.',
  stores_sensitive_data: 'It holds sensitive data.',
  encrypted_at_rest: 'What it stores is encrypted.',
  encrypted_in_transit: 'It is encrypted on the wire.',
  carries_sensitive_data: 'It carries sensitive data.',
};

export const flagLabel = (key: string): string => FLAG_LABELS[key] ?? key;
