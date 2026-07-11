// Public storage-operations capability for human and headless surfaces.
// The native binding owns every semantic operation; this handle only gives
// higher layers a typed, injected expression of that existing contract.

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
  };
}
