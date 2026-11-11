import { assetOperations } from './assets.js';
import { assumptionOperations } from './assumptions.js';
import { elementOperations } from './elements.js';
import { exchangeOperations } from './exchange.js';
import { extractionOperations } from './extraction.js';
import { generateOperations } from './generate.js';
import { jobOperations } from './jobs.js';
import { mitigationOperations } from './mitigations.js';
import type { Operation } from './operation.js';
import { projectOperations } from './projects.js';
import { reportOperations } from './reports.js';
import { reviewOperations } from './review.js';
import { sourceOperations } from './sources.js';
import { threatModelOperations } from './threat-models.js';
import { threatOperations } from './threats.js';

// Every resource operation, in the order the contract lists them.
export const resourceOperations: Operation<unknown>[] = [
  ...projectOperations,
  ...threatModelOperations,
  ...elementOperations,
  ...threatOperations,
  ...generateOperations,
  ...reportOperations,
  ...exchangeOperations,
  ...mitigationOperations,
  ...jobOperations,
  ...sourceOperations,
  ...extractionOperations,
  ...reviewOperations,
  ...assetOperations,
  ...assumptionOperations,
];
