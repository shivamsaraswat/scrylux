import { ThreatGenerationInput, ThreatGenerationResult } from '@scrylux/core';
import { runGeneration } from '../rule-engine/run.js';
import { defineOperation, type Operation } from './operation.js';
import { logGeneration } from './write-log.js';

export const generateOperations: Operation<unknown>[] = [
  defineOperation({
    method: 'post',
    path: '/threat-models/:id/threats/generate',
    operationId: 'generateThreats',
    summary: 'Generate threats from the diagram with the shipped rule library',
    description:
      'Runs the shipped threat library against the threat model\'s diagram, all or nothing, in one transaction. ' +
      'It creates a rule-generated threat, with its suggested mitigations as proposed, for every element and applicable rule ' +
      'that has none yet; flags generated threats whose rule no longer applies as stale, with the reason; and clears the flag ' +
      'when the rule applies again. Running it again on an unchanged diagram changes nothing. It never deletes a threat or ' +
      'mitigation and never changes a field of an existing threat except stale. Elements stored with properties outside the ' +
      'flag vocabulary are skipped and listed in skipped_elements. The body is the empty object.',
    body: { name: 'ThreatGenerationInput', schema: ThreatGenerationInput },
    response: { name: 'ThreatGenerationResult', schema: ThreatGenerationResult },
    status: 200,
    errors: [400, 404],
    // No recordType: the router would log one line for the threat model. The handler logs the run.
    handler: async ({ id, accountId }) => {
      const result = await runGeneration(id);
      // The transaction has committed, so what is logged is stored.
      logGeneration(accountId, id, result);
      return result;
    },
  }),
];
