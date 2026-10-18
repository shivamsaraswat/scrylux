import type { ScryluxFileV1 } from '@scrylux/core';
import { HttpError } from '../../v1/errors.js';
import type { ImportPlan } from './plan.js';

// A Scrylux file as a plan (contracts/scrylux-file.md): every record, status and origin as the file has it. The file's
// ids are kept here and replaced by `checkPlan`. A generated threat stays generated, with its rule and stale reason, so
// "Generate threats" recognises it afterwards; an AI-drafted one is refused, because none can exist before Phase 3,
// which decides what rationale and citations such a threat must carry (FR-010, Principle VI). The file's export time
// and project name are ignored.
//
// The field rules were applied when the file was parsed (ScryluxFileV1), and the rules across records are applied by
// `checkPlan`, so there is nothing else to refuse here and nothing to note: a Scrylux file imports with an empty list.
export function planScrylux(file: ScryluxFileV1): ImportPlan {
  file.threats.forEach((threat, index) => {
    if (threat.origin === 'ai') throw new HttpError(400, `file.threats.${index}.origin: AI-drafted threats cannot be imported yet`);
  });
  return {
    models: [
      {
        threatModel: { id: 'model', name: file.threat_model.name, methodology: file.threat_model.methodology, status: file.threat_model.status },
        name_issue: null,
        elements: file.elements.map((element, index) => ({
          id: element.id,
          path: `file.elements.${index}`,
          type: element.type,
          name: element.name,
          properties: element.properties,
          layout: element.layout,
          parent_boundary_id: element.parent_boundary_id,
          source_element_id: element.source_element_id,
          target_element_id: element.target_element_id,
          depth: 0,
        })),
        threats: file.threats.map((threat, index) => ({
          id: threat.id,
          path: `file.threats.${index}`,
          element_id: threat.element_id,
          category: threat.category,
          title: threat.title,
          description: threat.description,
          likelihood: threat.likelihood,
          impact: threat.impact,
          status: threat.status,
          status_reason: threat.status_reason,
          origin: threat.origin === 'rule' ? 'rule' : 'manual',
          library_ref: threat.library_ref,
          stale: threat.stale,
        })),
        mitigations: file.mitigations.map((mitigation, index) => ({
          id: mitigation.id,
          path: `file.mitigations.${index}`,
          threat_id: mitigation.threat_id,
          description: mitigation.description,
          status: mitigation.status,
          external_ref: mitigation.external_ref,
        })),
      },
    ],
    notes: [],
  };
}
