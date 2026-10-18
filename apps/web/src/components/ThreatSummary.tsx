import { RISK_LEVELS, THREAT_STATUSES, summarizeThreats, type ThreatRecord } from '@scrylux/core';
import { useMemo } from 'react';

const label = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1).replace('_', ' ');

// How the whole threat model stands, above its list (spec FR-021): the threats in each status, and the open ones at
// each risk level, most serious first. It counts every threat, whatever filter the list has.
export function ThreatSummary({ threats }: { threats: readonly ThreatRecord[] }) {
  const summary = useMemo(() => summarizeThreats(threats), [threats]);
  return (
    <section aria-label="Threat summary" className="threat-summary">
      <div>
        <h3>Threats by status</h3>
        <dl>
          {THREAT_STATUSES.map((status) => (
            <div key={status}>
              <dt>{label(status)}</dt>
              <dd>{summary.byStatus[status]}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div>
        <h3>Open threats by risk</h3>
        <dl>
          {[...RISK_LEVELS].reverse().map((risk) => (
            <div key={risk}>
              <dt>{risk}</dt>
              <dd>{summary.openByRisk[risk]}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
