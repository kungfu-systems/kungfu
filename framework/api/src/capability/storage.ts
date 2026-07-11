// Public storage-operations capability for human and headless surfaces.
// The native binding owns every semantic operation; this handle only gives
// higher layers a typed, injected expression of that existing contract.

import type {
  QueryChangelogPage,
  QueryDefinition,
  QueryResumeToken,
  SavedQueryCatalog,
  SavedQueryEntry,
  SavedQueryView,
} from './query.js';
import type { KfLocator, KfNativeBinding } from './types.js';
import { resolveRuntimeDir } from './types.js';

export type StorageValue = Record<string, unknown>;

export type Storage = {
  layout: () => StorageValue;
  status: () => StorageValue;
  episodes: (limit?: number) => StorageValue;
  inspectEpisode: (episodeId: number) => StorageValue;
  query: (sourceId?: string, limit?: number) => StorageValue;
  fsck: () => StorageValue;
  repairPlan: () => StorageValue;
  exportBundle: (sourceId?: string) => StorageValue;
  queryExamples: () => StorageValue;
  factQuery: (definition: QueryDefinition) => StorageValue;
  factChangelog: (
    definition: QueryDefinition,
    resumeToken?: QueryResumeToken,
    maxMessages?: number,
  ) => QueryChangelogPage;
  savedQueries: (includeDeleted?: boolean) => SavedQueryCatalog;
  savedQuery: (queryId: string, includeDeleted?: boolean) => SavedQueryEntry;
  putSavedQuery: (
    savedView: SavedQueryView,
    queryId?: string,
    expectedRevision?: number,
  ) => SavedQueryEntry;
  deleteSavedQuery: (
    queryId: string,
    expectedRevision: number,
  ) => SavedQueryEntry;
};

export type OpenStorageOptions = {
  binding: KfNativeBinding;
  locator: KfLocator;
};

export function openStorage(options: OpenStorageOptions): Storage {
  const operation = options.binding.runStorageServiceOperation;
  if (!operation) {
    throw new Error('native binding does not expose storage operations');
  }
  const runtimeDir = resolveRuntimeDir(options.locator);
  const run = (name: string, values: Record<string, unknown> = {}) =>
    operation(name, runtimeDir, values);

  return {
    layout: () => run('layout'),
    status: () => run('status'),
    episodes: (limit = 100) => run('episode_list', { limit }),
    inspectEpisode: (episodeId) => run('episode_inspect', { episodeId }),
    query: (sourceId = '', limit = 100) =>
      run('query', {
        query: 'entries',
        limit,
        ...(sourceId ? { sourceId } : {}),
      }),
    fsck: () => run('fsck'),
    repairPlan: () => run('repair_plan', { dryRun: true }),
    exportBundle: (sourceId = '') =>
      run('export_bundle', sourceId ? { sourceId } : {}),
    queryExamples: () => run('query_plan', { action: 'examples' }),
    factQuery: (definition) => run('fact_query', { definition }),
    factChangelog: (definition, resumeToken, maxMessages = 100) =>
      run('fact_changelog', {
        definition,
        max_messages: maxMessages,
        ...(resumeToken ? { resume_token: resumeToken } : {}),
      }) as QueryChangelogPage,
    savedQueries: (includeDeleted = false) =>
      run('saved_query_catalog', {
        action: 'list',
        include_deleted: includeDeleted,
      }) as SavedQueryCatalog,
    savedQuery: (queryId, includeDeleted = false) =>
      run('saved_query_catalog', {
        action: 'get',
        query_id: queryId,
        include_deleted: includeDeleted,
      }) as SavedQueryEntry,
    putSavedQuery: (savedView, queryId = '', expectedRevision = 0) =>
      run('saved_query_catalog', {
        action: 'put',
        saved_view: savedView,
        ...(queryId ? { query_id: queryId } : {}),
        ...(expectedRevision ? { expected_revision: expectedRevision } : {}),
      }) as SavedQueryEntry,
    deleteSavedQuery: (queryId, expectedRevision) =>
      run('saved_query_catalog', {
        action: 'delete',
        query_id: queryId,
        expected_revision: expectedRevision,
      }) as SavedQueryEntry,
  };
}
