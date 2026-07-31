// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEVELOPMENT_RESTART_EXIT_CODE = 75;

const WORKSPACE_ENV_KEYS = [
  'KF_HOME',
  'KF_RUNTIME_DIR',
  'KF_WORKSPACE_ID',
  'KF_WORKSPACE_KIND',
  'KF_WORKSPACE_ROOT',
  'KF_WORKSPACE_DISPLAY_PATH',
  'KF_WORKSPACE_RESOLUTION_REASON',
  'KF_WORKSPACE_STATE',
  'KF_WORKSPACE_DIAGNOSIS',
];

function supervisedEnvironment(baseEnv) {
  return {
    ...baseEnv,
    KUNGFU_GUI_DEV_SUPERVISOR: '1',
    KUNGFU_GUI_DEV_RESTART_EXIT_CODE: String(DEVELOPMENT_RESTART_EXIT_CODE),
  };
}

function expanded(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return path.join(homedir(), value.slice(2));
  return value;
}

function selectedRegistryWorkspace(env) {
  const configHome = path.resolve(
    expanded(env.KF_CONFIG_HOME || path.join(homedir(), '.kungfu-config')),
  );
  const registryPath = path.join(configHome, 'gui', 'workspaces.json');
  if (!existsSync(registryPath)) return null;
  try {
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    return (
      registry.recent?.find(
        (candidate) => candidate.workspace_id === registry.last_workspace_id,
      ) ?? null
    );
  } catch {
    return null;
  }
}

export function nextDevelopmentEnvironment(baseEnv) {
  const env = supervisedEnvironment(baseEnv);
  for (const key of [
    'KF_INSTANCE_HOME',
    ...WORKSPACE_ENV_KEYS,
    'KFE_INITIAL_SURFACE',
    'KFE_FOCUSED_PROJECT_PATH',
  ]) {
    Reflect.deleteProperty(env, key);
  }
  const selected = selectedRegistryWorkspace(env);
  if (
    selected?.workspace_kind === 'project' &&
    typeof selected.workspace_root === 'string' &&
    selected.workspace_root.length > 0
  ) {
    env.KFE_INITIAL_SURFACE = 'projects';
    env.KFE_FOCUSED_PROJECT_PATH = selected.workspace_root;
  }
  return env;
}

function runElectronVite(root, env) {
  const executable = path.join(
    root,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite',
  );
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['dev'], {
      cwd: root,
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

export async function superviseDevelopment(options) {
  let env = supervisedEnvironment({
    ...options.baseEnv,
    KUNGFU_GUI_DEV_USER_DATA:
      options.baseEnv.KUNGFU_GUI_DEV_USER_DATA ||
      path.join(options.root, 'out', 'dev-user-data'),
  });
  for (;;) {
    const result = await (options.run ?? runElectronVite)(options.root, env);
    if (result.code !== DEVELOPMENT_RESTART_EXIT_CODE) {
      return result.code;
    }
    options.onRestart?.();
    env = nextDevelopmentEnvironment(env);
  }
}

export function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return superviseDevelopment({
    root,
    baseEnv: process.env,
    onRestart: () =>
      process.stdout.write(
        '\n[kungfu-gui] Project changed; restarting the development renderer and native process.\n\n',
      ),
  });
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
