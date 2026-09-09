// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEVELOPMENT_RESTART_EXIT_CODE,
  nextDevelopmentEnvironment,
  superviseDevelopment,
} from '@kungfu-tech/product-kungfu/tooling/product';

test('development restart resolves the selected Project without retaining the old native root', () => {
  const root = path.join(tmpdir(), `kungfu-gui-dev-${process.pid}`);
  const registryRoot = path.join(root, 'gui');
  mkdirSync(registryRoot, { recursive: true });
  writeFileSync(
    path.join(registryRoot, 'workspaces.json'),
    JSON.stringify({
      last_workspace_id: 'project:selected',
      recent: [
        {
          workspace_id: 'project:selected',
          workspace_kind: 'project',
          workspace_root: '/tmp/selected',
        },
      ],
    }),
  );

  const env = nextDevelopmentEnvironment({
    KF_CONFIG_HOME: root,
    KF_INSTANCE_HOME: '/tmp/old-instance',
    KF_HOME: '/tmp/old-instance/home',
    KF_RUNTIME_DIR: '/tmp/old-instance/home/runtime',
    KF_WORKSPACE_ROOT: '/tmp/old-project',
  });

  assert.equal(env.KF_INSTANCE_HOME, undefined);
  assert.equal(env.KF_HOME, undefined);
  assert.equal(env.KF_RUNTIME_DIR, undefined);
  assert.equal(env.KF_WORKSPACE_ROOT, undefined);
  assert.equal(env.KFE_INITIAL_SURFACE, 'projects');
  assert.equal(env.KFE_FOCUSED_PROJECT_PATH, '/tmp/selected');
  assert.equal(env.KUNGFU_GUI_DEV_SUPERVISOR, '1');
  assert.equal(
    env.KUNGFU_GUI_DEV_RESTART_EXIT_CODE,
    String(DEVELOPMENT_RESTART_EXIT_CODE),
  );
});

test('development supervisor rebuilds the renderer service after the Project restart exit code', async () => {
  const root = path.join(tmpdir(), `kungfu-gui-supervisor-${process.pid}`);
  const registryRoot = path.join(root, 'gui');
  mkdirSync(registryRoot, { recursive: true });
  writeFileSync(
    path.join(registryRoot, 'workspaces.json'),
    JSON.stringify({
      last_workspace_id: 'project:selected',
      recent: [
        {
          workspace_id: 'project:selected',
          workspace_kind: 'project',
          workspace_root: '/tmp/selected',
        },
      ],
    }),
  );
  const launches = [];
  const code = await superviseDevelopment({
    root: '/tmp/gui',
    baseEnv: {
      KF_CONFIG_HOME: root,
      KF_HOME: '/tmp/old/.kungfu',
      KF_RUNTIME_DIR: '/tmp/old/.kungfu/runtime',
    },
    run: async (cwd, env) => {
      launches.push({ cwd, env });
      return {
        code: launches.length === 1 ? DEVELOPMENT_RESTART_EXIT_CODE : 0,
        signal: null,
      };
    },
  });

  assert.equal(code, 0);
  assert.equal(launches.length, 2);
  assert.equal(launches[0].env.KF_HOME, '/tmp/old/.kungfu');
  assert.equal(
    launches[0].env.KUNGFU_GUI_DEV_USER_DATA,
    path.join('/tmp/gui', 'out', 'dev-user-data'),
  );
  assert.equal(launches[1].env.KF_HOME, undefined);
  assert.equal(launches[1].env.KFE_FOCUSED_PROJECT_PATH, '/tmp/selected');
});
