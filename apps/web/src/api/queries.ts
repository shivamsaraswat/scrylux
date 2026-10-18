import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  ElementBatchResult,
  ElementRecord,
  ImportResult,
  MitigationRecord,
  ProjectRecord,
  ThreatGenerationResult,
  ThreatModelRecord,
  ThreatRecord,
  type ElementBatchOperationInput,
  type ImportInput,
  type MitigationCreateInput,
  type MitigationUpdateInput,
  type ProjectCreateInput,
  type ProjectUpdateInput,
  type ThreatCreateInput,
  type ThreatModelCreateInput,
  type ThreatModelUpdateInput,
  type ThreatUpdateInput,
} from '@scrylux/core';
import { apiDelete, apiGet, apiPatch, apiPost } from './client.js';
import { ApiError, isGone } from './errors.js';

// One query per v1 read, and one mutation per write (research #15). Nothing here is optimistic (spec FR-016):
// a write changes what the page shows only after the server has confirmed it. A write to a project or a threat
// model refetches what it changed. A write to a threat or a mitigation puts the record the server answered with
// into the list the page holds, because those lists run to 15,000 threats and 49,000 mitigations, and reading
// one again after every change made working through them slow (Phase 2 M4, research #10). A write that finds its
// record gone (404) refetches, so the screen shows the server's state.

export const keys = {
  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  threatModels: (projectId: string) => ['threat-models', projectId] as const,
  threatModel: (id: string) => ['threat-model', id] as const,
  elements: (threatModelId: string) => ['elements', threatModelId] as const,
  threats: (threatModelId: string) => ['threats', threatModelId] as const,
  mitigations: (threatModelId: string) => ['mitigations', threatModelId] as const,
};

// Changes a list the page holds, with what the server answered. A list that was never loaded is left alone. A read
// of the list that is already on its way may have started before this write and land after it; it is followed by
// another, so the newest state wins and the write cannot be undone by an older answer.
function writeList<T extends { id: string }>(client: QueryClient, queryKey: readonly unknown[], change: (list: T[]) => T[]): void {
  client.setQueryData<T[]>(queryKey, (current) => (current === undefined ? undefined : change(current)));
  if (client.isFetching({ queryKey }) > 0) void client.invalidateQueries({ queryKey });
}

const append = <T,>(record: T) => (list: T[]): T[] => [...list, record];
const replaceById = <T extends { id: string }>(record: T) => (list: T[]): T[] => list.map((item) => (item.id === record.id ? record : item));
const removeById = <T extends { id: string }>(id: string) => (list: T[]): T[] => list.filter((item) => item.id !== id);

// Runs the given invalidations when a write fails because the record no longer exists.
function refetchWhenGone(client: QueryClient, invalidate: () => Promise<unknown>) {
  return (err: unknown): void => {
    if (isGone(err)) void invalidate();
  };
}

// ---- projects ----

export function useProjects() {
  return useQuery({ queryKey: keys.projects, queryFn: () => apiGet('/api/v1/projects', ProjectRecord.array()) });
}

// The id may not be known yet (a threat model's project is known once the model has loaded). The
// query then stays off: with an empty id it would request the list endpoint instead.
export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: keys.project(id ?? ''),
    queryFn: () => apiGet(`/api/v1/projects/${id ?? ''}`, ProjectRecord),
    enabled: id !== undefined,
  });
}

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ProjectCreateInput) => apiPost('/api/v1/projects', ProjectRecord, input),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.projects }),
  });
}

export function useUpdateProject(id: string) {
  const client = useQueryClient();
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: keys.projects }), client.invalidateQueries({ queryKey: keys.project(id) })]);
  return useMutation({
    mutationFn: (input: ProjectUpdateInput) => apiPatch(`/api/v1/projects/${id}`, ProjectRecord, input),
    onSuccess: refresh,
    onError: refetchWhenGone(client, refresh),
  });
}

export function useDeleteProject(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiDelete(`/api/v1/projects/${id}`),
    onSuccess: () => {
      client.removeQueries({ queryKey: keys.project(id) });
      client.removeQueries({ queryKey: keys.threatModels(id) });
      return client.invalidateQueries({ queryKey: keys.projects });
    },
    onError: refetchWhenGone(client, () => client.invalidateQueries({ queryKey: keys.project(id) })),
  });
}

// ---- threat models ----

export function useThreatModels(projectId: string) {
  return useQuery({
    queryKey: keys.threatModels(projectId),
    queryFn: () => apiGet(`/api/v1/projects/${projectId}/threat-models`, ThreatModelRecord.array()),
  });
}

export function useThreatModel(id: string) {
  return useQuery({ queryKey: keys.threatModel(id), queryFn: () => apiGet(`/api/v1/threat-models/${id}`, ThreatModelRecord) });
}

export function useCreateThreatModel(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ThreatModelCreateInput) => apiPost('/api/v1/threat-models', ThreatModelRecord, input),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.threatModels(projectId) }),
  });
}

// Imports a file as new threat models of the project (spec FR-006). The list of the project's threat models is stale
// once it succeeds.
export function useImportThreatModels(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ImportInput) => apiPost(`/api/v1/projects/${projectId}/imports`, ImportResult, input),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.threatModels(projectId) }),
  });
}

export function useUpdateThreatModel(id: string, projectId: string | undefined) {
  const client = useQueryClient();
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: keys.threatModel(id) }),
      projectId ? client.invalidateQueries({ queryKey: keys.threatModels(projectId) }) : undefined,
    ]);
  return useMutation({
    mutationFn: (input: ThreatModelUpdateInput) => apiPatch(`/api/v1/threat-models/${id}`, ThreatModelRecord, input),
    onSuccess: refresh,
    onError: refetchWhenGone(client, refresh),
  });
}

export function useDeleteThreatModel(id: string, projectId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiDelete(`/api/v1/threat-models/${id}`),
    onSuccess: () => {
      client.removeQueries({ queryKey: keys.threatModel(id) });
      return projectId ? client.invalidateQueries({ queryKey: keys.threatModels(projectId) }) : undefined;
    },
    onError: refetchWhenGone(client, () => client.invalidateQueries({ queryKey: keys.threatModel(id) })),
  });
}

// ---- elements (shown by name only: the UI doesn't create or edit them in this milestone) ----

export function useElements(threatModelId: string) {
  return useQuery({
    queryKey: keys.elements(threatModelId),
    queryFn: () => apiGet(`/api/v1/threat-models/${threatModelId}/elements`, ElementRecord.array()),
  });
}

// One request that stores a whole user action: all of its operations, or none (FR-020a). The answer
// goes straight into the elements the page shows, so the next screen is the server's data. A deleted
// element takes its data flows with it, as on the server.
export function useBatchElements(threatModelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (operations: ElementBatchOperationInput[]) =>
      apiPost(`/api/v1/threat-models/${threatModelId}/elements/batch`, ElementBatchResult, { operations }),
    onSuccess: (result) => {
      client.setQueryData<ElementRecord[]>(keys.elements(threatModelId), (current = []) => {
        const deleted = new Set(result.deleted);
        const changed = new Map(result.elements.map((element) => [element.id, element]));
        const kept = current
          .filter(
            (element) =>
              !deleted.has(element.id) &&
              !(element.source_element_id !== null && deleted.has(element.source_element_id)) &&
              !(element.target_element_id !== null && deleted.has(element.target_element_id)),
          )
          .map((element) => changed.get(element.id) ?? element);
        const known = new Set(kept.map((element) => element.id));
        return [...kept, ...result.elements.filter((element) => !known.has(element.id))];
      });
    },
  });
}

// ---- threats ----

export function useThreats(threatModelId: string) {
  return useQuery({
    queryKey: keys.threats(threatModelId),
    queryFn: () => apiGet(`/api/v1/threat-models/${threatModelId}/threats`, ThreatRecord.array()),
  });
}

export function useCreateThreat(threatModelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ThreatCreateInput) => apiPost('/api/v1/threats', ThreatRecord, input),
    onSuccess: (created) => writeList(client, keys.threats(threatModelId), append(created)),
  });
}

// The threat is a variable, not a hook argument, so one hook serves every row of the table.
export function useUpdateThreat(threatModelId: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: keys.threats(threatModelId) });
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ThreatUpdateInput }) => apiPatch(`/api/v1/threats/${id}`, ThreatRecord, input),
    onSuccess: (updated) => writeList(client, keys.threats(threatModelId), replaceById(updated)),
    onError: (err) => {
      refetchWhenGone(client, refresh)(err);
      // A refused move to mitigated means the mitigations the page held were out of date: read them again, so the
      // row shows why (contracts/web-ui.md §1).
      if (err instanceof ApiError && err.status === 409) void client.invalidateQueries({ queryKey: keys.mitigations(threatModelId) });
    },
  });
}

export function useDeleteThreat(threatModelId: string) {
  const client = useQueryClient();
  // A threat's mitigations go with it, so both lists are refetched when the threat was already gone.
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: keys.threats(threatModelId) }),
      client.invalidateQueries({ queryKey: keys.mitigations(threatModelId) }),
    ]);
  return useMutation({
    mutationFn: (id: string) => apiDelete(`/api/v1/threats/${id}`),
    onSuccess: (_result, id) => {
      writeList<ThreatRecord>(client, keys.threats(threatModelId), removeById(id));
      writeList<MitigationRecord>(client, keys.mitigations(threatModelId), (list) => list.filter((mitigation) => mitigation.threat_id !== id));
    },
    onError: refetchWhenGone(client, refresh),
  });
}

// ---- mitigations: one list for the whole threat model, grouped by threat in the table ----

export function useModelMitigations(threatModelId: string) {
  return useQuery({
    queryKey: keys.mitigations(threatModelId),
    queryFn: () => apiGet(`/api/v1/threat-models/${threatModelId}/mitigations`, MitigationRecord.array()),
  });
}

export function useCreateMitigation(threatModelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: MitigationCreateInput) => apiPost('/api/v1/mitigations', MitigationRecord, input),
    onSuccess: (created) => writeList(client, keys.mitigations(threatModelId), append(created)),
    onError: refetchWhenGone(client, () => client.invalidateQueries({ queryKey: keys.threats(threatModelId) })),
  });
}

export function useUpdateMitigation(threatModelId: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: keys.mitigations(threatModelId) });
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: MitigationUpdateInput }) =>
      apiPatch(`/api/v1/mitigations/${id}`, MitigationRecord, input),
    onSuccess: (updated) => writeList(client, keys.mitigations(threatModelId), replaceById(updated)),
    onError: refetchWhenGone(client, refresh),
  });
}

export function useDeleteMitigation(threatModelId: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: keys.mitigations(threatModelId) });
  return useMutation({
    mutationFn: (id: string) => apiDelete(`/api/v1/mitigations/${id}`),
    onSuccess: (_result, id) => writeList<MitigationRecord>(client, keys.mitigations(threatModelId), removeById(id)),
    onError: refetchWhenGone(client, refresh),
  });
}

// ---- generating threats ----

// Whatever the outcome, the lists are refetched: when the answer is lost on the way, the run may still
// have stored its threats, and the table must show what the server holds (contracts/web-ui.md).
export function useGenerateThreats(threatModelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost(`/api/v1/threat-models/${threatModelId}/threats/generate`, ThreatGenerationResult, {}),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: keys.threats(threatModelId) }),
        client.invalidateQueries({ queryKey: keys.mitigations(threatModelId) }),
      ]),
  });
}
