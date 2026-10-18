import { MAX_BATCH_OPERATIONS, openThreatCounts, type ElementRecord } from '@scrylux/core';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { keys, useBatchElements, useElements, useThreats } from '../api/queries.js';
import { useSession } from '../session/SessionProvider.js';
import { DiagramHistory, type HistoryStep } from './history.js';
import { applyActions, inverseOf, type BatchOp, type DiagramAction } from './operations.js';
import { SaveQueue, type QueueSnapshot, type SaveStatus } from './save-queue.js';

// The state of one threat model's diagram editor: what is on screen, and the queue that saves it. It
// lives above the two tabs, so switching tabs keeps unsaved changes (FR-001b), and it is discarded when
// the user leaves the threat model.
//
// What is on screen is never stored: it is the server's elements with every action that is not yet
// confirmed replayed on top. So a refetch of the elements can never make an unsaved change disappear
// (FR-020), and an action that fails is still shown while the user retries it.

export interface DiagramEditor {
  threatModelId: string;
  // The elements to draw: undefined until they have loaded.
  elements: ElementRecord[] | undefined;
  isPending: boolean;
  loadError: unknown;
  reload: () => void;
  status: QueueSnapshot['status'];
  saveError: unknown;
  pendingCount: number;
  // Shows an action now and saves it.
  apply: (action: DiagramAction) => void;
  retry: () => void;
  // Resolves when every change the user made has been saved, or the save has stopped (generate waits on it).
  whenSettled: () => Promise<SaveStatus>;
  // The open threats of each element, by element id (spec FR-015): what the canvas, the elements list and the
  // selection announcement say about it. Derived from the threats the page holds, so every saved change to a
  // threat reaches it without a reload (FR-016).
  openThreats: ReadonlyMap<string, number>;
  // The ids selected on the canvas, nodes and flows alike. The properties panel shows the one selected.
  selectedIds: readonly string[];
  select: (ids: readonly string[]) => void;
  // Set when the user has just added an element, so the properties panel puts the cursor in its name.
  focusNameFor: string | null;
  requestNameFocus: (id: string) => void;
  clearNameFocus: () => void;
  // A short message about something the editor refused or had to do, shown near the toolbar.
  notice: string | null;
  setNotice: (message: string | null) => void;
  // The element the user asked to delete; the delete dialogs decide what happens next (FR-021 to FR-023).
  deleteRequest: string | null;
  requestDelete: (id: string) => void;
  clearDeleteRequest: () => void;
  // What undo and redo would take back or repeat, named as the action was (null when there is nothing to do).
  undoLabel: string | null;
  redoLabel: string | null;
  undo: () => void;
  redo: () => void;
}

// Exported so a test can supply its own editor.
export const DiagramEditorContext = createContext<DiagramEditor | null>(null);

export function useDiagramEditor(): DiagramEditor {
  const value = useContext(DiagramEditorContext);
  if (!value) throw new Error('useDiagramEditor must be used inside a DiagramEditorProvider');
  return value;
}

export function DiagramEditorProvider({ threatModelId, children }: { threatModelId: string; children: ReactNode }) {
  const query = useElements(threatModelId);
  const batch = useBatchElements(threatModelId);
  const threats = useThreats(threatModelId);
  const openThreats = useMemo(() => openThreatCounts(threats.data ?? []), [threats.data]);
  // The queue is made once for this threat model and always sends through the current mutation.
  const [queue] = useState(() => new SaveQueue((ops) => batch.mutateAsync(ops)));
  useEffect(() => queue.setSend((ops) => batch.mutateAsync(ops)), [queue, batch]);
  const { registerUnsavedWork } = useSession();
  const queryClient = useQueryClient();
  const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  // The session's undo and redo steps. An action that goes to the queue is tied to the step it belongs to, so
  // when the server refuses the action the step can be dropped (FR-024d).
  const [history] = useState(() => new DiagramHistory());
  const [steps] = useState(() => new WeakMap<DiagramAction, HistoryStep>());
  const historySnapshot = useSyncExternalStore(history.subscribe, history.getSnapshot);
  const serverElements = useRef(query.data);
  useEffect(() => {
    serverElements.current = query.data;
  }, [query.data]);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [focusNameFor, setFocusNameFor] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const select = useCallback((ids: readonly string[]) => {
    // The same selection again is not a change, or React Flow's selection events would loop.
    setSelectedIds((previous) => (previous.length === ids.length && previous.every((id, i) => id === ids[i]) ? previous : ids));
  }, []);
  const clearNameFocus = useCallback(() => setFocusNameFor(null), []);
  const [deleteRequest, setDeleteRequest] = useState<string | null>(null);
  const clearDeleteRequest = useCallback(() => setDeleteRequest(null), []);

  // What the queue tells the user when the server says no (spec FR-020b). The change itself is already undone:
  // it is no longer pending, so the screen shows the last saved state of what it touched.
  const refetch = query.refetch;
  useEffect(
    () =>
      queue.setHooks({
        onRejected: (action, message, kind) => {
          const step = steps.get(action);
          if (step) history.remove(step);
          if (kind === 'missing') {
            // Another session deleted an element this change needed: what is shown is out of date.
            setNotice('This diagram was changed elsewhere. It has been reloaded.');
            void refetch();
          } else {
            setNotice(`That change was not saved: ${message}`);
          }
        },
        // The server refused a delete because threats are linked, which the page did not know: its list of
        // threats was out of date. It is read again, so the next try is judged on the real thing.
        onThreatsBlocked: (action, message) => {
          const step = steps.get(action);
          if (step) history.remove(step);
          setNotice(`That change was not saved: ${message}`);
          void queryClient.invalidateQueries({ queryKey: keys.threats(threatModelId) });
        },
      }),
    [queue, refetch, setNotice, queryClient, threatModelId, history, steps],
  );

  // The session layer asks how much is unsaved when a session ends, and says when the same account is back.
  useEffect(() => registerUnsavedWork({ count: () => queue.pendingCount(), onResumed: () => queue.retry() }), [registerUnsavedWork, queue]);

  // A change that failed because the browser was offline is tried again when it is back.
  useEffect(() => {
    const retry = (): void => queue.retry();
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [queue]);

  const elements = useMemo(
    () => (query.data ? applyActions(threatModelId, query.data, snapshot.pending) : undefined),
    [query.data, snapshot.pending, threatModelId],
  );

  // An action the user makes: it is shown and saved, and its inverse is worked out from the diagram as it is
  // now, with everything still unsaved on it, so a quick run of actions each undoes exactly itself.
  const apply = useCallback(
    (action: DiagramAction): void => {
      const before = applyActions(threatModelId, serverElements.current ?? [], queue.getSnapshot().pending);
      const inverse = inverseOf(threatModelId, before, action.ops);
      queue.enqueue(action);
      // An action that changed nothing is nothing to undo.
      if (inverse.length === 0) return;
      const step: HistoryStep = { label: action.label, forward: action.ops, inverse };
      steps.set(action, step);
      history.push(step);
    },
    [threatModelId, queue, history, steps],
  );

  // Undoing and redoing are saved like any other action, after the ones before them, so they work on a diagram
  // whose last change failed to save, and after Retry the server gets everything in order.
  const replay = useCallback(
    (step: HistoryStep | null, ops: (step: HistoryStep) => BatchOp[], verb: string): void => {
      if (!step) return;
      const operations = ops(step);
      if (operations.length > MAX_BATCH_OPERATIONS) {
        history.remove(step);
        setNotice(`That can't be ${verb}: it would take more than ${MAX_BATCH_OPERATIONS} changes at once.`);
        return;
      }
      setNotice(null);
      const action: DiagramAction = { label: `${verb === 'undone' ? 'Undo' : 'Redo'} ${step.label}`, ops: operations };
      steps.set(action, step);
      queue.enqueue(action);
    },
    [queue, history, steps],
  );
  const undo = useCallback(() => replay(history.undo(), (step) => step.inverse, 'undone'), [replay, history]);
  const redo = useCallback(() => replay(history.redo(), (step) => step.forward, 'redone'), [replay, history]);

  const value = useMemo<DiagramEditor>(
    () => ({
      threatModelId,
      elements,
      isPending: query.isPending,
      loadError: query.error,
      reload: () => void query.refetch(),
      status: snapshot.status,
      saveError: snapshot.error,
      pendingCount: snapshot.pending.length,
      apply,
      retry: () => queue.retry(),
      whenSettled: () => queue.whenSettled(),
      openThreats,
      selectedIds,
      select,
      focusNameFor,
      requestNameFocus: setFocusNameFor,
      clearNameFocus,
      notice,
      setNotice,
      deleteRequest,
      requestDelete: setDeleteRequest,
      clearDeleteRequest,
      undoLabel: historySnapshot.undo.at(-1)?.label ?? null,
      redoLabel: historySnapshot.redo.at(-1)?.label ?? null,
      undo,
      redo,
    }),
    [threatModelId, elements, query, snapshot, queue, openThreats, selectedIds, select, focusNameFor, clearNameFocus, notice, deleteRequest, clearDeleteRequest, apply, historySnapshot, undo, redo],
  );
  return <DiagramEditorContext.Provider value={value}>{children}</DiagramEditorContext.Provider>;
}
