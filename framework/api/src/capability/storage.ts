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

export type FactTypeDefinition = {
  id: string;
  version: string;
  source_authorities: string[];
  schema: Record<string, unknown>;
  contract_world_id?: string;
  effective_from?: number;
  effective_until?: number;
};

export type FactMaterialInput = {
  type_id: string;
  type_version: string;
  source_id: string;
  subject_key: string;
  payload: Record<string, unknown>;
  observation_id?: string;
  action?: 'assert' | 'correct' | 'retract';
  target_observation_id?: string;
  valid_from?: number;
  valid_until?: number;
};

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
  profileLifecycle: (
    action: string,
    options?: Record<string, unknown>,
  ) => StorageValue;
  kfxRuntimeContract: () => StorageValue;
  validateKfxRuntimeDocument: (
    kind: 'request' | 'inspection' | 'plan' | 'receipt',
    document: StorageValue,
  ) => StorageValue;
  kfxRegistry: (
    action: 'list' | 'inspect' | 'resolve' | 'plan' | 'status' | 'assess',
    request: StorageValue,
  ) => StorageValue;
  factLibraryContract: () => StorageValue;
  factTypes: () => StorageValue;
  createFactType: (
    definition: FactTypeDefinition,
    systemTime?: number,
  ) => StorageValue;
  factMaterials: (typeId?: string, subjectKey?: string) => StorageValue;
  putFactMaterial: (
    material: FactMaterialInput,
    systemTime?: number,
  ) => StorageValue;
  assessments: () => StorageValue;
  exportFactLibrary: (thin?: boolean) => StorageValue;
  importFactLibrary: (
    bundle: StorageValue,
    options?: { execute?: boolean },
  ) => StorageValue;
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
    profileLifecycle: (action, values = {}) =>
      run('profile_lifecycle', { action, ...values }),
    kfxRuntimeContract: () => run('kfx_runtime', { action: 'contract' }),
    validateKfxRuntimeDocument: (kind, document) =>
      run('kfx_runtime', { action: 'validate', kind, document }),
    kfxRegistry: (action, request) => run('kfx_runtime', { action, request }),
    factLibraryContract: () => run('fact_library_contract'),
    factTypes: () => run('fact_type_list'),
    createFactType: (definition, systemTime = 0) =>
      run('fact_type_create', { definition, system_time: systemTime }),
    factMaterials: (typeId = '', subjectKey = '') =>
      run('fact_material_list', {
        ...(typeId ? { type_id: typeId } : {}),
        ...(subjectKey ? { subject_key: subjectKey } : {}),
      }),
    putFactMaterial: (material, systemTime = 0) =>
      run('fact_material_put', { material, system_time: systemTime }),
    assessments: () => run('assessment_list'),
    exportFactLibrary: (thin = false) => run('fact_library_export', { thin }),
    importFactLibrary: (bundle, options = {}) =>
      run('fact_library_import', {
        library_bundle: bundle,
        dry_run: options.execute !== true,
      }),
  };
}
