import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  defaultHomeDesktopWorkspace,
  listRecentDesktopWorkspaces,
  resolveLastDesktopWorkspace,
  workspaceRegistryPath,
} from './workspace-selection.ts';

function fixture(name: string): string {
  const root = path.join(tmpdir(), `kungfu-workspace-selection-${name}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}

function writeRegistry(
  configHome: string,
  recent: Array<Record<string, unknown>>,
  lastWorkspaceId: string,
) {
  const registryPath = workspaceRegistryPath(configHome);
  mkdirSync(path.dirname(registryPath), { recursive: true });
  writeFileSync(
    registryPath,
    JSON.stringify({
      schema: 'kungfu.workspace.registry/v1',
      last_workspace_id: lastWorkspaceId,
      recent,
    }),
  );
}

test('first install selects logical Home without creating its data home', () => {
  const root = fixture('home');
  const selection = defaultHomeDesktopWorkspace(root);

  assert.equal(selection.workspaceId, 'home');
  assert.equal(selection.state, 'selected-uninitialized');
  assert.equal(selection.dataHome, path.join(realpathSync(root), '.kungfu'));
  assert.equal(
    listRecentDesktopWorkspaces(path.join(root, 'config')).length,
    0,
  );
});

test('missing last project remains unavailable instead of falling through', () => {
  const root = fixture('missing');
  const configHome = path.join(root, 'config');
  const project = path.join(root, 'missing-project');
  writeRegistry(
    configHome,
    [
      {
        workspace_id: 'project:missing',
        workspace_kind: 'project',
        workspace_root: project,
        display_path: project,
        data_home: path.join(project, '.kungfu'),
      },
    ],
    'project:missing',
  );

  const selection = resolveLastDesktopWorkspace(configHome);
  assert.equal(selection?.state, 'unavailable');
  assert.match(selection?.diagnosis ?? '', /unavailable/);
});

test('existing project is selected read-only until its data home exists', () => {
  const root = fixture('project');
  const configHome = path.join(root, 'config');
  const project = path.join(root, 'project');
  mkdirSync(project);
  writeRegistry(
    configHome,
    [
      {
        workspace_id: 'project:ready-later',
        workspace_kind: 'project',
        workspace_root: project,
        display_path: project,
        data_home: path.join(project, '.kungfu'),
      },
    ],
    'project:ready-later',
  );

  assert.equal(
    resolveLastDesktopWorkspace(configHome)?.state,
    'selected-uninitialized',
  );
  assert.equal(listRecentDesktopWorkspaces(configHome).length, 1);
  mkdirSync(path.join(project, '.kungfu'));
  assert.equal(resolveLastDesktopWorkspace(configHome)?.state, 'ready');
});
