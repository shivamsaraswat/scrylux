import { useQueryClient } from '@tanstack/react-query';
import type { ThreatRecord } from '@scrylux/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { keys, useCreateThreat, useElements, useModelMitigations, useThreats } from '../api/queries.js';
import { LoadError } from './LoadError.js';
import { Pager } from './Pager.js';
import { focusNeighbour, leftMessage } from './row-focus.js';
import { ThreatFilters } from './ThreatFilters.js';
import { ThreatForm } from './ThreatForm.js';
import { ThreatSummary } from './ThreatSummary.js';
import { ThreatTable } from './ThreatTable.js';
import { applyThreatFilter, parseThreatFilter, toSearchParams, type ThreatFilter } from './threat-filter.js';

// How many rows the table draws at once. A generated threat model can hold about 15,000 threats, and drawing them
// all took 3.5 seconds (Phase 2 M3 measured it); a page is drawn at once, and filtering the full list is instant.
export const PAGE_SIZE = 100;

const ELEMENT_GONE = 'The element in this filter no longer exists, so the filter was removed.';

// The threats of one threat model: its summary, the filters, the table a page at a time, and the form to add one.
// The page reads the elements (for their names and the filter), the threats, and every mitigation of the model in
// one list each, however many threats the model holds (spec FR-010, M5 FR-002). The filters are the page's
// address, so a filtered list survives a reload and can be shared as a link (FR-019).
// `pageSize` is for tests, which check the paging with a handful of rows instead of drawing 200 in jsdom.
export function ThreatsSection({ threatModelId, pageSize = PAGE_SIZE }: { threatModelId: string; pageSize?: number }) {
  const elements = useElements(threatModelId);
  const threats = useThreats(threatModelId);
  const mitigations = useModelMitigations(threatModelId);
  const create = useCreateThreat(threatModelId);
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [params, setParams] = useSearchParams();
  const filter = useMemo(() => parseThreatFilter(params), [params]);
  // How many rows have left the view in a row, with nothing else saved in between: what the table says (T069).
  const [departures, setDepartures] = useState(0);
  const countLine = useRef<HTMLParagraphElement>(null);

  // The page belongs to the filter it was chosen under: any change of filter or order, by hand or with Back,
  // starts again at page 1 (research #9).
  const filterKey = params.toString();
  const [chosen, setChosen] = useState({ key: filterKey, page: 1 });

  // A filter on an element that is gone is dropped, with a message (spec FR-022). It is judged only once the elements
  // have arrived, or a slow load would make a valid element look gone. The history entry is replaced, so Back does
  // not bring the dead filter back, and the message travels with that entry: it is there for the address that
  // dropped the filter, and gone with the next change of filter.
  const wanted = filter.element.kind === 'element' ? filter.element.id : null;
  useEffect(() => {
    if (wanted === null || !elements.data || elements.data.some((candidate) => candidate.id === wanted)) return;
    setParams(toSearchParams({ ...filter, element: { kind: 'any' } }), { replace: true, state: { elementGone: true } });
  }, [wanted, elements.data, filter, setParams]);
  const notice = (useLocation().state as { elementGone?: boolean } | null)?.elementGone === true ? ELEMENT_GONE : null;

  const all = threats.data;
  const filtered = useMemo(() => (all ? applyThreatFilter(all, filter) : []), [all, filter]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  // Edits can shrink the list under the page the user is on: the last page that still exists is shown.
  const page = Math.min(chosen.key === filterKey ? chosen.page : 1, pages);
  const rows = useMemo(() => filtered.slice((page - 1) * pageSize, page * pageSize), [filtered, page, pageSize]);

  // flushSync: the controls show the filter, and the filter is the address. Without it a checkbox the user just
  // clicked would show its old state until the navigation, which React Router runs as a transition, had finished.
  function change(next: ThreatFilter): void {
    setDepartures(0);
    setParams(toSearchParams(next), { flushSync: true });
  }

  // The list has been read again after a change made from a row. A row that no longer matches is gone, with focus
  // on it: focus goes to the row after it, or before it, or to the count line, and the table says what happened.
  function rowSaved(id: string): void {
    const latest = client.getQueryData<ThreatRecord[]>(keys.threats(threatModelId));
    if (!latest) return;
    if (applyThreatFilter(latest, filter).some((threat) => threat.id === id)) {
      setDepartures(0);
      return;
    }
    setDepartures((n) => n + 1);
    if (!focusNeighbour(rows.map((threat) => threat.id), id)) countLine.current?.focus();
  }

  const failed = [elements, threats, mitigations].filter((query) => query.isError);
  const loading = [elements, threats, mitigations].some((query) => query.isPending);

  return (
    <section aria-labelledby="threats-heading">
      <h2 id="threats-heading">Threats</h2>
      {adding ? (
        <ThreatForm
          threatModelId={threatModelId}
          elements={elements.data}
          onSubmit={async (input) => {
            await create.mutateAsync(input as Parameters<typeof create.mutateAsync>[0]);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button type="button" className="primary" onClick={() => setAdding(true)}>
          Add threat
        </button>
      )}
      {failed.length > 0 ? (
        <LoadError error={failed[0]?.error} onRetry={() => failed.forEach((query) => void query.refetch())} />
      ) : loading ? (
        <p>Loading…</p>
      ) : (
        all &&
        mitigations.data &&
        elements.data &&
        (all.length === 0 ? (
          <ThreatTable threatModelId={threatModelId} threats={[]} mitigations={mitigations.data} elements={elements.data} />
        ) : (
          <>
            <ThreatSummary threats={all} />
            <ThreatFilters filter={filter} elements={elements.data} onChange={change} />
            {notice && <p className="muted">{notice}</p>}
            <p role="status" tabIndex={-1} ref={countLine} className="count-line">
              {filtered.length === 0 ? 'No threat matches these filters.' : `Showing ${filtered.length} of ${all.length} threats`}
            </p>
            {/* The table says what happened to a row that left, for assistive technology and the eye alike. */}
            <p role="status" className="muted">
              {leftMessage(departures)}
            </p>
            {rows.length > 0 && (
              <ThreatTable
                threatModelId={threatModelId}
                threats={rows}
                mitigations={mitigations.data}
                elements={elements.data}
                onRowSaved={rowSaved}
              />
            )}
            <Pager page={page} pages={pages} onChange={(next) => {
                setDepartures(0);
                setChosen({ key: filterKey, page: next });
              }}
            />
          </>
        ))
      )}
    </section>
  );
}
