// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

const REGISTRY_SCHEMA = 'kungfu.workspace.registry/v1';
const ROOT = /^sha256:[0-9a-f]{64}$/u;
const PROJECT_CUT_ROOT_FIELDS = [
  'project',
  'parentCutRoots',
  'sourceProjection',
  'atlas',
  'episodeDelta',
  'interpretation',
  'visibility',
  'omissions',
  'conflicts',
  'unknowns',
  'compatibility',
] as const;

export type WorkspaceContinuationState =
  | 'uninitialized'
  | 'shadow-only'
  | 'live-runtime'
  | 'evidence-degraded'
  | 'unavailable';

const DESKTOP_WORKSPACE_ENV_KEYS = [
  'KF_HOME',
  'KF_RUNTIME_DIR',
  'KF_WORKSPACE_ID',
  'KF_WORKSPACE_KIND',
  'KF_WORKSPACE_ROOT',
  'KF_WORKSPACE_DISPLAY_PATH',
  'KF_WORKSPACE_RESOLUTION_REASON',
  'KF_WORKSPACE_STATE',
  'KF_WORKSPACE_DIAGNOSIS',
] as const;

export type RegistryWorkspace = {
  workspace_id?: string;
  workspace_kind?: 'home' | 'project';
  workspace_root?: string | null;
  display_path?: string;
  data_home?: string;
};

type WorkspaceRegistry = {
  schema?: string;
  last_workspace_id?: string | null;
  recent?: RegistryWorkspace[];
};

export type DesktopWorkspaceSelection = {
  workspaceId: string;
  workspaceKind: 'home' | 'project';
  workspaceRoot: string | null;
  displayPath: string;
  dataHome: string;
  runtimeDir: string;
  state: WorkspaceContinuationState;
  evidenceLevel: 'none' | 'settled-review' | 'live-local' | 'degraded';
  settledEpisodeCount: number;
  projectCutCount: number;
  resolutionReason: 'last-workspace-registry' | 'home-fallback';
  diagnosis?: string;
};

export function workspaceRegistryPath(configHome: string): string {
  return path.join(configHome, 'gui', 'workspaces.json');
}

export function clearDesktopWorkspaceEnvForRelaunch(
  env: Record<string, string | undefined>,
): void {
  for (const key of DESKTOP_WORKSPACE_ENV_KEYS) delete env[key];
}

export function resolveLastDesktopWorkspace(
  configHome: string,
): DesktopWorkspaceSelection | null {
  const registryPath = workspaceRegistryPath(configHome);
  if (!existsSync(registryPath)) return null;
  let registry: WorkspaceRegistry;
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch {
    return null;
  }
  if (
    registry.schema !== REGISTRY_SCHEMA ||
    !registry.last_workspace_id ||
    !Array.isArray(registry.recent)
  ) {
    return null;
  }
  const selected = registry.recent.find(
    (item) => item.workspace_id === registry.last_workspace_id,
  );
  if (
    !selected?.workspace_id ||
    !selected.workspace_kind ||
    !selected.data_home
  ) {
    return null;
  }
  const workspaceRoot = selected.workspace_root
    ? canonicalPath(selected.workspace_root)
    : null;
  const dataHome = canonicalPath(selected.data_home);
  const unavailable =
    selected.workspace_kind === 'project' &&
    (!workspaceRoot || !existsSync(workspaceRoot));
  const continuation = unavailable
    ? {
        state: 'unavailable' as const,
        evidenceLevel: 'none' as const,
        settledEpisodeCount: 0,
        projectCutCount: 0,
        diagnosis: 'The last project workspace path is unavailable.',
      }
    : inspectDesktopContinuation(dataHome);
  return {
    workspaceId: selected.workspace_id,
    workspaceKind: selected.workspace_kind,
    workspaceRoot,
    displayPath: selected.display_path || workspaceRoot || dataHome,
    dataHome,
    runtimeDir: path.join(dataHome, 'runtime'),
    state: continuation.state,
    evidenceLevel: continuation.evidenceLevel,
    settledEpisodeCount: continuation.settledEpisodeCount,
    projectCutCount: continuation.projectCutCount,
    resolutionReason: 'last-workspace-registry',
    ...(continuation.diagnosis ? { diagnosis: continuation.diagnosis } : {}),
  };
}

export function defaultHomeDesktopWorkspace(
  userHome: string,
): DesktopWorkspaceSelection {
  const dataHome = path.join(canonicalPath(userHome), '.kungfu');
  const continuation = inspectDesktopContinuation(dataHome);
  return {
    workspaceId: 'home',
    workspaceKind: 'home',
    workspaceRoot: null,
    displayPath: 'Home Workspace',
    dataHome,
    runtimeDir: path.join(dataHome, 'runtime'),
    state: continuation.state,
    evidenceLevel: continuation.evidenceLevel,
    settledEpisodeCount: continuation.settledEpisodeCount,
    projectCutCount: continuation.projectCutCount,
    resolutionReason: 'home-fallback',
  };
}

export function inspectDesktopContinuation(dataHome: string): {
  state: Exclude<WorkspaceContinuationState, 'unavailable'>;
  evidenceLevel: 'none' | 'settled-review' | 'live-local' | 'degraded';
  settledEpisodeCount: number;
  projectCutCount: number;
  diagnosis?: string;
} {
  const runtimePresent = existsSync(path.join(dataHome, 'runtime'));
  const episodeManifests = filesNamed(
    path.join(dataHome, 'episodes', 'sealed'),
    'manifest.json',
  );
  const cutFiles = jsonFiles(path.join(dataHome, 'project-cuts')).filter(
    (file) => !file.endsWith('.receipt.json'),
  );
  const issues: string[] = [];
  let settledEpisodeCount = 0;
  let projectCutCount = 0;
  for (const file of episodeManifests) {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as Record<
        string,
        unknown
      >;
      if (
        value.schema !== 'kungfu.episode.git-workspace-manifest/v1' ||
        value.authority !== 'shadow-of-yijinjing-journal' ||
        !ROOT.test(String(value.semanticRoot ?? '')) ||
        !ROOT.test(String(value.providerRoot ?? ''))
      ) {
        throw new Error('manifest contract mismatch');
      }
      const { providerRoot, ...preimage } = value;
      if (semanticRoot(preimage) !== providerRoot) {
        throw new Error('Episode provider root mismatch');
      }
      settledEpisodeCount += 1;
    } catch {
      issues.push(`Invalid settled Episode manifest: ${path.basename(file)}`);
    }
  }
  for (const file of cutFiles) {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as Record<
        string,
        unknown
      >;
      if (
        value.schema !== 'project.cut/v1' ||
        !ROOT.test(String(value.cutRoot ?? ''))
      ) {
        throw new Error('Project Cut contract mismatch');
      }
      const rootInput = Object.fromEntries([
        ['schema', 'project.cut.root-input/v1'],
        ...PROJECT_CUT_ROOT_FIELDS.map((field) => [field, value[field]]),
      ]);
      if (semanticRoot(rootInput) !== value.cutRoot) {
        throw new Error('Project Cut root mismatch');
      }
      projectCutCount += 1;
    } catch {
      issues.push(`Invalid Project Cut: ${path.basename(file)}`);
    }
  }
  if (issues.length > 0) {
    return {
      state: 'evidence-degraded',
      evidenceLevel: 'degraded',
      settledEpisodeCount,
      projectCutCount,
      diagnosis: issues.join(' '),
    };
  }
  if (runtimePresent) {
    return {
      state: 'live-runtime',
      evidenceLevel: 'live-local',
      settledEpisodeCount,
      projectCutCount,
    };
  }
  if (settledEpisodeCount > 0 || projectCutCount > 0) {
    return {
      state: 'shadow-only',
      evidenceLevel: 'settled-review',
      settledEpisodeCount,
      projectCutCount,
    };
  }
  return {
    state: 'uninitialized',
    evidenceLevel: 'none',
    settledEpisodeCount: 0,
    projectCutCount: 0,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'string') {
    if (value.normalize('NFC') !== value) {
      throw new Error('canonical JSON strings must be NFC-normalized');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new Error('canonical JSON integers must be non-negative and safe');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  throw new Error('unsupported canonical JSON value');
}

function semanticRoot(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function filesNamed(root: string, name: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return filesNamed(target, name);
    return entry.isFile() && entry.name === name ? [target] : [];
  });
}

function jsonFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return jsonFiles(target);
    return entry.isFile() && entry.name.endsWith('.json') ? [target] : [];
  });
}

export function listRecentDesktopWorkspaces(
  configHome: string,
): RegistryWorkspace[] {
  const registryPath = workspaceRegistryPath(configHome);
  if (!existsSync(registryPath)) return [];
  try {
    const registry = JSON.parse(
      readFileSync(registryPath, 'utf8'),
    ) as WorkspaceRegistry;
    return registry.schema === REGISTRY_SCHEMA && Array.isArray(registry.recent)
      ? registry.recent
      : [];
  } catch {
    return [];
  }
}

function canonicalPath(value: string): string {
  const absolute = path.resolve(value);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}
