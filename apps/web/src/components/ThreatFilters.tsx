import { RISK_LEVELS, THREAT_STATUSES, type ElementRecord, type RiskLevel, type ThreatStatus } from '@scrylux/core';
import { ElementOptions } from './ElementOptions.js';
import { NO_FILTER, isFiltered, type ThreatFilter } from './threat-filter.js';

interface ThreatFiltersProps {
  filter: ThreatFilter;
  elements: readonly ElementRecord[];
  onChange: (next: ThreatFilter) => void;
}

const statusLabel = (status: ThreatStatus): string => status.charAt(0).toUpperCase() + status.slice(1).replace('_', ' ');
const toggle = <T,>(values: readonly T[], value: T, on: boolean): T[] => (on ? [...values, value] : values.filter((v) => v !== value));

// The choices that narrow the threat list and order it (contracts/web-ui.md §3; spec FR-019, FR-020). It holds no
// state of its own: the filter is the page's address, and every change is handed up as a whole new filter.
export function ThreatFilters({ filter, elements, onChange }: ThreatFiltersProps) {
  const element = filter.element.kind === 'element' ? filter.element.id : filter.element.kind === 'none' ? 'none' : '';
  return (
    <div role="group" aria-label="Filter threats" className="threat-filters">
      <label>
        Element
        <select
          value={element}
          onChange={(event) => {
            const value = event.target.value;
            onChange({ ...filter, element: value === '' ? { kind: 'any' } : value === 'none' ? { kind: 'none' } : { kind: 'element', id: value } });
          }}
        >
          <option value="">Any element</option>
          <option value="none">Not linked to an element</option>
          <ElementOptions elements={elements} />
        </select>
      </label>
      <fieldset>
        <legend>Status</legend>
        {THREAT_STATUSES.map((status) => (
          <label key={status}>
            <input
              type="checkbox"
              checked={filter.statuses.includes(status)}
              onChange={(event) => onChange({ ...filter, statuses: THREAT_STATUSES.filter((s) => toggle(filter.statuses, status, event.target.checked).includes(s)) })}
            />
            {statusLabel(status)}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Risk</legend>
        {[...RISK_LEVELS].reverse().map((risk: RiskLevel) => (
          <label key={risk}>
            <input
              type="checkbox"
              checked={filter.risks.includes(risk)}
              onChange={(event) => onChange({ ...filter, risks: RISK_LEVELS.filter((r) => toggle(filter.risks, risk, event.target.checked).includes(r)) })}
            />
            {risk}
          </label>
        ))}
      </fieldset>
      <label>
        Origin
        <select value={filter.origin ?? ''} onChange={(event) => onChange({ ...filter, origin: event.target.value === 'manual' || event.target.value === 'rule' ? event.target.value : null })}>
          <option value="">Any origin</option>
          <option value="manual">Manual</option>
          <option value="rule">Rule-generated</option>
        </select>
      </label>
      <label>
        <input type="checkbox" checked={filter.staleOnly} onChange={(event) => onChange({ ...filter, staleOnly: event.target.checked })} />
        Stale only
      </label>
      <label>
        Order
        <select value={filter.sort} onChange={(event) => onChange({ ...filter, sort: event.target.value === 'risk' ? 'risk' : 'created' })}>
          <option value="created">Oldest first</option>
          <option value="risk">Highest risk first</option>
        </select>
      </label>
      <button type="button" disabled={!isFiltered(filter)} onClick={() => onChange(NO_FILTER)}>
        Clear filters
      </button>
    </div>
  );
}
