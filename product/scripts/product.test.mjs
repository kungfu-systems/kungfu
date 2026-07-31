// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  devKfdEnv,
  devTuiCliEnv,
  devViewExtensionBuildPlan,
  devWorkspaceHomeOverride,
  instanceEnv,
  instanceHomeForWorktree,
  parseArgs,
  resolveInstanceHome,
  seedInstanceConfig,
  shouldAutoWorkspaceHome,
  workspaceDataHomeForCwd,
  workspaceEnv,
} from './product.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..', '..');

test('parses an isolated instance home for product commands', () => {
  const parsed = parseArgs([
    'gui',
    'dev',
    '--instance-home',
    '~/kungfu-demo',
    '--dry-run',
  ]);
  assert.equal(parsed.dryRun, true);
  assert.deepEqual(parsed.positional, ['gui', 'dev']);
  assert.equal(parsed.instanceHome, path.join(homedir(), 'kungfu-demo'));
  assert.equal(parsed.noInstanceHome, false);
});

test('parses the dev auto-instance opt-out flag', () => {
  const parsed = parseArgs(['gui', 'dev', '--no-instance-home']);
  assert.deepEqual(parsed.positional, ['gui', 'dev']);
  assert.equal(parsed.noInstanceHome, true);
});

test('builds a consistent Kungfu instance environment', () => {
  const home = resolveInstanceHome('relative-kungfu-home');
  const env = instanceEnv(home, { PATH: '/bin' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.KF_INSTANCE_HOME, home);
  assert.equal(env.KF_HOME, path.join(home, 'home'));
  assert.equal(env.KF_CONFIG_HOME, path.join(home, 'config'));
  assert.equal(env.KF_RUNTIME_DIR, path.join(home, 'home', 'runtime'));
});

test('KF_DEV_HOME pins the dev workspace data home', () => {
  const parsed = { noInstanceHome: false, instanceHome: '' };
  const devHome = path.join(tmpdir(), 'atlas', '.kungfu');
  assert.equal(
    devWorkspaceHomeOverride(parsed, 'gui', 'dev', { KF_DEV_HOME: devHome }),
    devHome,
  );
  assert.equal(
    devWorkspaceHomeOverride(parsed, 'tui', 'dev', { KF_DEV_HOME: '~/wsp' }),
    path.join(homedir(), 'wsp'),
  );
});

test('KF_DEV_HOME loses to explicit homes and non-dev verbs', () => {
  const parsed = { noInstanceHome: false, instanceHome: '' };
  const devHome = path.join(tmpdir(), 'atlas', '.kungfu');
  assert.equal(
    devWorkspaceHomeOverride(parsed, 'gui', 'dev', {
      KF_DEV_HOME: devHome,
      KF_HOME: path.join(tmpdir(), 'explicit'),
    }),
    '',
  );
  assert.equal(
    devWorkspaceHomeOverride(parsed, 'gui', 'dev', {
      KF_DEV_HOME: devHome,
      KF_INSTANCE_HOME: path.join(tmpdir(), 'instance'),
    }),
    '',
  );
  assert.equal(
    devWorkspaceHomeOverride(parsed, 'gui', 'build', { KF_DEV_HOME: devHome }),
    '',
  );
  assert.equal(
    devWorkspaceHomeOverride(
      { noInstanceHome: true, instanceHome: '' },
      'gui',
      'dev',
      { KF_DEV_HOME: devHome },
    ),
    '',
  );
  assert.equal(
    devWorkspaceHomeOverride(
      { noInstanceHome: false, instanceHome: path.join(tmpdir(), 'flag') },
      'gui',
      'dev',
      { KF_DEV_HOME: devHome },
    ),
    '',
  );
});

test('builds a workspace data environment with separate config home', () => {
  const dataHome = path.join(tmpdir(), 'repo', '.kungfu');
  const env = workspaceEnv(dataHome, {
    PATH: '/bin',
    KF_CONFIG_HOME: path.join(tmpdir(), 'kungfu-config'),
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.KF_HOME, dataHome);
  assert.equal(env.KF_CONFIG_HOME, path.join(tmpdir(), 'kungfu-config'));
  assert.equal(env.KF_RUNTIME_DIR, path.join(dataHome, 'runtime'));
  assert.equal(env.KF_WORKSPACE_ROOT, path.dirname(dataHome));
  assert.equal(env.KF_WORKSPACE_KIND, 'project');
  assert.equal(env.KF_WORKSPACE_STATE, 'selected-uninitialized');
  assert.equal(env.KF_INSTANCE_HOME, undefined);
});

test('development environment discovers source extensions without installation', () => {
  const env = devKfdEnv({ PATH: '/bin' });
  assert.equal(env.KF_EXTENSION_PATH, path.join(ROOT, 'extensions'));
});

test('TUI development selects the source CLI without overriding an exact choice', () => {
  assert.equal(devTuiCliEnv({ PATH: '/bin' }).KUNGFU_TUI_SOURCE_CLI, '1');
  assert.equal(
    devTuiCliEnv({ KUNGFU_TUI_SOURCE_CLI: '0' }).KUNGFU_TUI_SOURCE_CLI,
    '0',
  );
});

test('plans only missing or stale source extension view bundles', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kungfu-dev-extensions-'));
  const extension = path.join(root, 'example-view');
  const source = path.join(extension, 'src', 'view');
  const bundle = path.join(extension, 'dist', 'view', 'index.js');
  mkdirSync(source, { recursive: true });
  writeFileSync(
    path.join(extension, 'package.json'),
    '{"name":"@example/view"}\n',
  );
  writeFileSync(
    path.join(extension, 'kungfu.kfx.json'),
    JSON.stringify({
      schema: 'kungfu.kfx.manifest/v1',
      name: '@example/view',
      kungfuConfig: {
        key: 'example-view',
        config: { view: { title: 'Example' } },
      },
    }),
  );
  writeFileSync(
    path.join(source, 'index.tsx'),
    'export const View = () => null',
  );
  try {
    let plan = devViewExtensionBuildPlan(root);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].needsBuild, true);
    mkdirSync(path.dirname(bundle), { recursive: true });
    writeFileSync(bundle, 'exports.View = () => null');
    const current = new Date(Date.now() + 2_000);
    utimesSync(bundle, current, current);
    plan = devViewExtensionBuildPlan(root);
    assert.equal(plan[0].needsBuild, false);
    const stale = new Date(Date.now() + 4_000);
    utimesSync(path.join(source, 'index.tsx'), stale, stale);
    plan = devViewExtensionBuildPlan(root);
    assert.equal(plan[0].needsBuild, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('derives workspace data home from nearest existing .kungfu', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'kungfu-workspace-existing-'));
  const nested = path.join(parent, 'a', 'b');
  const existing = path.join(parent, 'a', '.kungfu');
  mkdirSync(nested, { recursive: true });
  mkdirSync(existing, { recursive: true });
  try {
    assert.equal(workspaceDataHomeForCwd(nested), existing);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('derives workspace data home from git root without creating it', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'kungfu-workspace-git-'));
  const nested = path.join(repo, 'nested');
  mkdirSync(nested, { recursive: true });
  try {
    const init = spawnSync('git', ['init'], { cwd: repo, encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr || init.stdout);
    const workspaceHome = path.join(realpathSync(repo), '.kungfu');
    assert.equal(workspaceDataHomeForCwd(nested), workspaceHome);
    assert.equal(existsSync(workspaceHome), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('derives a stable auto instance root from a worktree path', () => {
  const root = path.join(tmpdir(), 'kungfu feature spaces', 'demo-worktree');
  const home = instanceHomeForWorktree(root, {
    KF_AUTO_INSTANCE_ROOT: path.join(tmpdir(), 'kf-instances'),
  });
  assert.match(
    home,
    new RegExp(
      `${escapeRegExp(path.join(tmpdir(), 'kf-instances', 'worktrees'))}${escapeRegExp(path.sep)}demo-worktree-[0-9a-f]{10}$`,
    ),
  );
});

test('defaults auto instance homes under the config root', () => {
  const root = path.join(tmpdir(), 'kungfu-feature', 'demo-worktree');
  const home = instanceHomeForWorktree(root, {});
  assert.match(
    home,
    new RegExp(
      `${escapeRegExp(path.join(homedir(), '.kungfu-config', 'instances', 'worktrees'))}${escapeRegExp(path.sep)}demo-worktree-[0-9a-f]{10}$`,
    ),
  );
});

test('seeds default config into a fresh instance without overwriting it', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'kungfu-product-seed-'));
  const sourceHome = path.join(parent, 'default-config');
  const instanceHome = path.join(parent, 'instance');
  mkdirSync(sourceHome, { recursive: true });
  writeFileSync(
    path.join(sourceHome, 'config.json'),
    '{"schema":"kungfu.config.override/v1","ui":{"scale":1.1}}\n',
  );
  try {
    const first = seedInstanceConfig(instanceHome, {
      sourceConfigHome: sourceHome,
    });
    const target = path.join(instanceHome, 'config', 'config.json');
    assert.equal(first.seeded, true);
    assert.equal(
      readFileSync(target, 'utf8'),
      readFileSync(first.source, 'utf8'),
    );

    writeFileSync(
      target,
      '{"schema":"kungfu.config.override/v1","ui":{"scale":2}}\n',
    );
    writeFileSync(
      path.join(sourceHome, 'config.json'),
      '{"schema":"kungfu.config.override/v1","ui":{"scale":3}}\n',
    );
    const second = seedInstanceConfig(instanceHome, {
      sourceConfigHome: sourceHome,
    });
    assert.equal(second.seeded, false);
    assert.equal(second.reason, 'target-exists');
    assert.match(readFileSync(target, 'utf8'), /"scale":2/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('dry-run shows instance env without creating the home', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'kungfu-product-test-'));
  const home = path.join(parent, 'instance-a');
  try {
    const result = spawnSync(
      process.execPath,
      [
        __filename.replace(/\.test\.mjs$/, '.mjs'),
        'gui',
        'dev',
        '-H',
        home,
        '--dry-run',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(
      result.stdout,
      new RegExp(`KF_HOME=${escapeRegExp(path.join(home, 'home'))}`),
    );
    assert.match(
      result.stdout,
      new RegExp(`KF_CONFIG_HOME=${escapeRegExp(path.join(home, 'config'))}`),
    );
    assert.match(
      result.stdout,
      new RegExp(
        `KF_RUNTIME_DIR=${escapeRegExp(path.join(home, 'home', 'runtime'))}`,
      ),
    );
    assert.match(result.stdout, /pnpm --filter @kungfu-tech\/gui run dev/);
    assert.equal(existsSync(home), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('one-command TUI demo launches the interactive offline autoplay', () => {
  const result = spawnSync(
    process.execPath,
    [__filename.replace(/\.test\.mjs$/, '.mjs'), 'tui', 'demo', '--dry-run'],
    {
      encoding: 'utf8',
      env: { HOME: homedir(), PATH: process.env.PATH || '' },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    result.stdout,
    /pnpm --filter @kungfu-tech\/tui run dev -- --agent-work-lab-autoplay/,
  );
  assert.match(result.stdout, /KF_HOME=/);
  assert.match(result.stdout, /KUNGFU_SDK_ENTRY=/);
  assert.match(result.stdout, /KUNGFU_TUI_SOURCE_CLI=1/);
});

test('dry-run auto-selects workspace .kungfu for gui dev', () => {
  const result = spawnSync(
    process.execPath,
    [__filename.replace(/\.test\.mjs$/, '.mjs'), 'gui', 'dev', '--dry-run'],
    {
      encoding: 'utf8',
      env: { HOME: homedir(), PATH: process.env.PATH || '' },
    },
  );
  const workspaceHome = path.join(ROOT, '.kungfu');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    shouldAutoWorkspaceHome(
      { noInstanceHome: false, instanceHome: '' },
      'gui',
      'dev',
      { HOME: homedir() },
    ),
    true,
  );
  assert.match(
    result.stdout,
    new RegExp(`auto-workspace-home: ${escapeRegExp(workspaceHome)}`),
  );
  assert.match(
    result.stdout,
    new RegExp(`KF_HOME=${escapeRegExp(workspaceHome)}`),
  );
  assert.match(
    result.stdout,
    new RegExp(
      `KF_CONFIG_HOME=${escapeRegExp(path.join(homedir(), '.kungfu-config'))}`,
    ),
  );
  assert.match(
    result.stdout,
    new RegExp(
      `KF_RUNTIME_DIR=${escapeRegExp(path.join(workspaceHome, 'runtime'))}`,
    ),
  );
  assert.doesNotMatch(result.stdout, /KF_INSTANCE_HOME=/);
});

test('dry-run honors KF_DEV_HOME as the dev workspace data home', () => {
  const devHome = mkdtempSync(path.join(tmpdir(), 'kungfu-dev-home-'));
  try {
    const result = spawnSync(
      process.execPath,
      [__filename.replace(/\.test\.mjs$/, '.mjs'), 'gui', 'dev', '--dry-run'],
      {
        encoding: 'utf8',
        env: {
          HOME: homedir(),
          PATH: process.env.PATH || '',
          KF_DEV_HOME: devHome,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const resolvedDevHome = path.resolve(devHome);
    assert.match(
      result.stdout,
      new RegExp(`auto-workspace-home: ${escapeRegExp(resolvedDevHome)}`),
    );
    assert.match(
      result.stdout,
      new RegExp(`KF_HOME=${escapeRegExp(resolvedDevHome)}`),
    );
    assert.match(
      result.stdout,
      new RegExp(
        `KF_RUNTIME_DIR=${escapeRegExp(path.join(resolvedDevHome, 'runtime'))}`,
      ),
    );
    assert.doesNotMatch(result.stdout, /KF_INSTANCE_HOME=/);
  } finally {
    rmSync(devHome, { recursive: true, force: true });
  }
});

test('dev product commands expose local KFD metadata to kungfu kfd', () => {
  const result = spawnSync(
    process.execPath,
    [__filename.replace(/\.test\.mjs$/, '.mjs'), 'gui', 'dev', '--dry-run'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    result.stdout,
    new RegExp(
      `KUNGFU_SDK_ENTRY=${escapeRegExp(path.join(ROOT, 'developer', 'sdk', 'src', 'sdk.js'))}`,
    ),
  );
  assert.match(
    result.stdout,
    new RegExp(
      `KUNGFU_KFD3_REGISTRY=${escapeRegExp(path.join(ROOT, '.buildchain', 'kfd', 'kfd-3', 'surfaces.json'))}`,
    ),
  );
  assert.match(
    result.stdout,
    new RegExp(
      `KUNGFU_KFD_UPSTREAM_AGGREGATE=${escapeRegExp(path.join(ROOT, 'developer', 'sdk', 'kfd', 'upstream-aggregate.json'))}`,
    ),
  );
});

test('dev KFD environment preserves explicit user overrides', () => {
  const env = devKfdEnv({
    KUNGFU_SDK_ENTRY: '/custom/sdk.js',
    KUNGFU_KFD3_REGISTRY: '/custom/kfd3.json',
    KUNGFU_KFD_UPSTREAM_AGGREGATE: '/custom/upstream.json',
  });
  assert.equal(env.KUNGFU_SDK_ENTRY, '/custom/sdk.js');
  assert.equal(env.KUNGFU_KFD3_REGISTRY, '/custom/kfd3.json');
  assert.equal(env.KUNGFU_KFD_UPSTREAM_AGGREGATE, '/custom/upstream.json');
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
