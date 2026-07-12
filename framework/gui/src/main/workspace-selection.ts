// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const REGISTRY_SCHEMA = 'kungfu.workspace.registry/v1';

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
  state: 'ready' | 'selected-uninitialized' | 'unavailable';
  resolutionReason: 'last-workspace-registry' | 'home-fallback';
  diagnosis?: string;
};

export function workspaceRegistryPath(configHome: string): string {
  return path.join(configHome, 'gui', 'workspaces.json');
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
  return {
    workspaceId: selected.workspace_id,
    workspaceKind: selected.workspace_kind,
    workspaceRoot,
    displayPath: selected.display_path || workspaceRoot || dataHome,
    dataHome,
    runtimeDir: path.join(dataHome, 'runtime'),
    state: unavailable
      ? 'unavailable'
      : existsSync(dataHome)
        ? 'ready'
        : 'selected-uninitialized',
    resolutionReason: 'last-workspace-registry',
    ...(unavailable
      ? { diagnosis: 'The last project workspace path is unavailable.' }
      : {}),
  };
}

export function defaultHomeDesktopWorkspace(
  userHome: string,
): DesktopWorkspaceSelection {
  const dataHome = path.join(canonicalPath(userHome), '.kungfu');
  return {
    workspaceId: 'home',
    workspaceKind: 'home',
    workspaceRoot: null,
    displayPath: 'Home Workspace',
    dataHome,
    runtimeDir: path.join(dataHome, 'runtime'),
    state: existsSync(dataHome) ? 'ready' : 'selected-uninitialized',
    resolutionReason: 'home-fallback',
  };
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
