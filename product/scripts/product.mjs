// SPDX-License-Identifier: Apache-2.0
// Repo-local dogfood product entry. The SDK owns the generic external-project
// `kungfu sdk product` verbs; this wrapper maps the same vocabulary to Kungfu's
// product-level assembly so `./shifu product gui build` does not silently
// regress to a GUI-only build.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH } from '@kungfu-tech/buildchain/buildchain-layout';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..', '..');
const isWin = process.platform === 'win32';
const KFD3_REGISTRY = path.join(
  ROOT,
  ...BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH.split('/'),
);
const KFD_UPSTREAM_AGGREGATE = path.join(
  ROOT,
  'developer',
  'sdk',
  'kfd',
  'upstream-aggregate.json',
);
const SDK_ENTRY = path.join(ROOT, 'developer', 'sdk', 'src', 'sdk.js');
const EXTENSIONS_ROOT = path.join(ROOT, 'extensions');
const GUI_ROOT = path.join(ROOT, 'framework', 'gui');

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

function selectedRegistryWorkspace(env) {
  const configHome = path.resolve(
    expandHomePath(
      env.KF_CONFIG_HOME || path.join(os.homedir(), '.kungfu-config'),
    ),
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
    if (result.code !== DEVELOPMENT_RESTART_EXIT_CODE) return result.code;
    options.onRestart?.();
    env = nextDevelopmentEnvironment(env);
  }
}

export function guiDevelopmentMain(baseEnv = process.env) {
  return superviseDevelopment({
    root: GUI_ROOT,
    baseEnv,
    onRestart: () =>
      process.stdout.write(
        '\n[kungfu-gui] Project changed; restarting the development renderer and native process.\n\n',
      ),
  });
}

function usage(code) {
  process.stdout.write(
    [
      'usage: ./shifu product gui dev|build|pack|dist [--dry-run] [--instance-home <path>] [--no-instance-home]',
      '       ./shifu product tui dev|demo|build|bundle|dist [--empty-state] [--dry-run] [--instance-home <path>] [--no-instance-home]',
      '       ./shifu product cli dist [--dry-run] [--instance-home <path>] [--no-instance-home]',
      '',
      'gui build/pack  -> desktop product unpacked app under product/dist/desktop',
      'gui dist        -> desktop product installer assets under product/release/desktop',
      'tui bundle/dist -> bundled TUI under framework/tui/dist',
      'cli dist        -> CLI product archive under product/release/cli',
      '',
      '--instance-home, --home, -H <path>',
      '  run the product against an isolated Kungfu instance root:',
      '  KF_HOME=<path>/home, KF_CONFIG_HOME=<path>/config, KF_RUNTIME_DIR=<path>/home/runtime',
      '  dev commands auto-pick a workspace data home at <workspace>/.kungfu',
      '  KF_DEV_HOME=<path> pins the dev workspace data home for local dev runs',
      '  (dev only; explicit flags and KF_INSTANCE_HOME/KF_HOME take precedence)',
      '',
      '--empty-state',
      '  open `product tui dev` against a deterministic no-Work snapshot',
      '',
    ].join('\n'),
  );
  process.exit(code);
}

function fail(message) {
  process.stderr.write(`shifu product: ${message}\n`);
  process.exit(1);
}

function exitLabel(result) {
  return result.status == null
    ? `signal ${result.signal}`
    : String(result.status);
}

function expandHomePath(value) {
  if (!value || !value.trim())
    fail('--instance-home requires a non-empty path');
  const raw = value.trim();
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

function resolveInstanceHome(value) {
  return path.resolve(ROOT, expandHomePath(value));
}

function sanitizeInstanceName(value) {
  const name = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return name || 'worktree';
}

function defaultInstanceRoot(env = process.env) {
  return path.resolve(
    expandHomePath(
      env.KF_AUTO_INSTANCE_ROOT ||
        path.join(os.homedir(), '.kungfu-config', 'instances'),
    ),
  );
}

function defaultConfigHome() {
  return path.resolve(
    expandHomePath(path.join(os.homedir(), '.kungfu-config')),
  );
}

function instanceConfigPath(instanceHome) {
  return path.join(instanceHome, 'config', 'config.json');
}

function seedInstanceConfig(instanceHome, options = {}) {
  const sourceConfigHome = options.sourceConfigHome || defaultConfigHome();
  const source = path.join(sourceConfigHome, 'config.json');
  const target = instanceConfigPath(instanceHome);
  if (existsSync(target)) {
    return { seeded: false, reason: 'target-exists', source, target };
  }
  if (!existsSync(source)) {
    return { seeded: false, reason: 'source-missing', source, target };
  }
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
  return { seeded: true, source, target };
}

function seedInstanceProjectIndex(instanceHome, options = {}) {
  const sourceConfigHome = options.sourceConfigHome || defaultConfigHome();
  const targetConfigHome = path.join(instanceHome, 'config');
  const relativePaths = [
    path.join('gui', 'workspaces.json'),
    path.join('projects', 'library.json'),
    path.join('workspaces', 'catalog.json'),
  ];
  const seeded = [];
  for (const relativePath of relativePaths) {
    const source = path.join(sourceConfigHome, relativePath);
    const target = path.join(targetConfigHome, relativePath);
    if (!existsSync(source) || existsSync(target)) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
    seeded.push({ source, target });
  }
  return seeded;
}

function nearestExistingWorkspaceHome(cwd) {
  let current = path.resolve(cwd);
  const globalUserHome = path.join(os.homedir(), '.kungfu');
  for (;;) {
    const candidate = path.join(current, '.kungfu');
    if (existsSync(candidate) && path.resolve(candidate) !== globalUserHome) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return '';
    current = parent;
  }
}

function workspaceDataHomeForCwd(cwd = ROOT) {
  const existing = nearestExistingWorkspaceHome(cwd);
  if (existing) return existing;
  const gitRoot = gitOutput(['rev-parse', '--show-toplevel'], cwd);
  return gitRoot ? path.join(path.resolve(gitRoot), '.kungfu') : '';
}

function instanceHomeForWorktree(worktreeRoot, env = process.env) {
  const resolvedRoot = path.resolve(worktreeRoot);
  const name = sanitizeInstanceName(path.basename(resolvedRoot));
  const hash = createHash('sha256')
    .update(resolvedRoot)
    .digest('hex')
    .slice(0, 10);
  return path.join(defaultInstanceRoot(env), 'worktrees', `${name}-${hash}`);
}

function gitOutput(args, cwd = ROOT) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) return '';
  return result.stdout.trim();
}

function isLinkedGitWorktree(cwd = ROOT) {
  const gitDir = gitOutput(
    ['rev-parse', '--path-format=absolute', '--git-dir'],
    cwd,
  );
  const commonDir = gitOutput(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    cwd,
  );
  return Boolean(
    gitDir && commonDir && path.resolve(gitDir) !== path.resolve(commonDir),
  );
}

function shouldAutoInstanceHome(parsed, surface, verb, env = process.env) {
  return Boolean(
    !parsed.noInstanceHome &&
      !parsed.instanceHome &&
      !env.KF_INSTANCE_HOME &&
      !env.KF_HOME &&
      (verb === 'dev' || (surface === 'tui' && verb === 'demo')) &&
      (surface === 'gui' || surface === 'tui') &&
      isLinkedGitWorktree(ROOT),
  );
}

function shouldAutoWorkspaceHome(parsed, surface, verb, env = process.env) {
  return Boolean(
    !parsed.noInstanceHome &&
      !parsed.instanceHome &&
      !env.KF_INSTANCE_HOME &&
      !env.KF_HOME &&
      (verb === 'dev' || (surface === 'tui' && verb === 'demo')) &&
      (surface === 'gui' || surface === 'tui') &&
      workspaceDataHomeForCwd(ROOT),
  );
}

// KF_DEV_HOME pins every local dev run on this machine to one workspace data
// home, so a daily-driver dev instance keeps its state across worktrees. It
// only applies to dev verbs and loses to explicit flags and
// KF_INSTANCE_HOME/KF_HOME, so tests and packaged runs stay unaffected.
function devWorkspaceHomeOverride(parsed, surface, verb, env = process.env) {
  const raw = (env.KF_DEV_HOME || '').trim();
  return raw &&
    !parsed.noInstanceHome &&
    !parsed.instanceHome &&
    !env.KF_INSTANCE_HOME &&
    !env.KF_HOME &&
    (verb === 'dev' || (surface === 'tui' && verb === 'demo')) &&
    (surface === 'gui' || surface === 'tui')
    ? path.resolve(expandHomePath(raw))
    : '';
}

function instanceEnv(instanceHome, baseEnv = process.env) {
  if (!instanceHome) return { ...baseEnv };
  const runtimeHome = path.join(instanceHome, 'home');
  const projectsConfigHome =
    baseEnv.KF_PROJECTS_CONFIG_HOME ||
    baseEnv.KF_CONFIG_HOME ||
    defaultConfigHome();
  return {
    ...baseEnv,
    KF_INSTANCE_HOME: instanceHome,
    KF_HOME: runtimeHome,
    KF_CONFIG_HOME: path.join(instanceHome, 'config'),
    KF_PROJECTS_CONFIG_HOME: projectsConfigHome,
    KF_RUNTIME_DIR: path.join(runtimeHome, 'runtime'),
  };
}

function workspaceEnv(workspaceHome, baseEnv = process.env) {
  if (!workspaceHome) return { ...baseEnv };
  const workspaceRoot =
    path.basename(workspaceHome) === '.kungfu'
      ? path.dirname(workspaceHome)
      : '';
  return {
    ...baseEnv,
    KF_HOME: workspaceHome,
    KF_CONFIG_HOME: baseEnv.KF_CONFIG_HOME || defaultConfigHome(),
    KF_RUNTIME_DIR: path.join(workspaceHome, 'runtime'),
    ...(workspaceRoot ? { KF_WORKSPACE_ROOT: workspaceRoot } : {}),
    KF_WORKSPACE_KIND: 'project',
    KF_WORKSPACE_STATE: existsSync(workspaceHome)
      ? 'ready'
      : 'selected-uninitialized',
  };
}

function devKfdEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  if (!env.KF_EXTENSION_PATH && existsSync(EXTENSIONS_ROOT)) {
    env.KF_EXTENSION_PATH = EXTENSIONS_ROOT;
  }
  if (!env.KUNGFU_SDK_ENTRY && existsSync(SDK_ENTRY)) {
    env.KUNGFU_SDK_ENTRY = SDK_ENTRY;
  }
  if (!env.KUNGFU_KFD3_REGISTRY && existsSync(KFD3_REGISTRY)) {
    env.KUNGFU_KFD3_REGISTRY = KFD3_REGISTRY;
  }
  if (
    !env.KUNGFU_KFD_UPSTREAM_AGGREGATE &&
    existsSync(KFD_UPSTREAM_AGGREGATE)
  ) {
    env.KUNGFU_KFD_UPSTREAM_AGGREGATE = KFD_UPSTREAM_AGGREGATE;
  }
  return env;
}

function devTuiCliEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    KUNGFU_TUI_SOURCE_CLI: baseEnv.KUNGFU_TUI_SOURCE_CLI || '1',
  };
}

function newestMtimeMs(target) {
  if (!existsSync(target)) return 0;
  const stat = statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    newest = Math.max(newest, newestMtimeMs(path.join(target, entry.name)));
  }
  return newest;
}

function devViewExtensionBuildPlan(extensionsRoot = EXTENSIONS_ROOT) {
  const plan = [];
  const visit = (directory, depth) => {
    if (depth > 2 || !existsSync(directory)) return;
    const packagePath = path.join(directory, 'package.json');
    const manifestPath = path.join(directory, 'kungfu.kfx.json');
    if (existsSync(packagePath) && existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const view = manifest?.kungfuConfig?.config?.view;
      if (view) {
        const bundlePath = path.join(
          directory,
          view.entry || 'dist/view/index.js',
        );
        const inputMtime = Math.max(
          newestMtimeMs(packagePath),
          newestMtimeMs(manifestPath),
          newestMtimeMs(path.join(directory, 'src', 'view')),
        );
        const bundleMtime = newestMtimeMs(bundlePath);
        plan.push({
          name: manifest.name || manifest.kungfuConfig.key,
          directory,
          bundlePath,
          needsBuild: bundleMtime === 0 || inputMtime > bundleMtime,
        });
      }
    }
    if (depth === 2) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      visit(path.join(directory, entry.name), depth + 1);
    }
  };
  visit(extensionsRoot, 0);
  return plan.sort((left, right) => left.name.localeCompare(right.name));
}

function prepareDevViewExtensions(options = {}) {
  const env = options.env || process.env;
  const pending = devViewExtensionBuildPlan(
    options.extensionsRoot || EXTENSIONS_ROOT,
  ).filter((entry) => entry.needsBuild);
  if (pending.length === 0) {
    process.stdout.write('[dev] source extension views are current\n');
    return;
  }
  process.stdout.write(
    `[dev] preparing ${pending.length} missing or stale source extension view${pending.length === 1 ? '' : 's'}\n`,
  );
  for (const entry of pending) {
    run(
      `build source extension ${entry.name}`,
      process.execPath,
      [SDK_ENTRY, 'kfx', 'build'],
      {
        dryRun: options.dryRun,
        cwd: entry.directory,
        env,
      },
    );
  }
}

function parseArgs(argv) {
  const parsed = {
    dryRun: false,
    emptyState: false,
    instanceHome: '',
    noInstanceHome: false,
    positional: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--empty-state') {
      parsed.emptyState = true;
    } else if (arg === '--no-instance-home') {
      parsed.noInstanceHome = true;
    } else if (arg === '--instance-home' || arg === '--home' || arg === '-H') {
      i += 1;
      if (i >= argv.length) fail(`${arg} requires a path`);
      parsed.instanceHome = resolveInstanceHome(argv[i]);
    } else if (arg.startsWith('--instance-home=')) {
      parsed.instanceHome = resolveInstanceHome(
        arg.slice('--instance-home='.length),
      );
    } else if (arg.startsWith('--home=')) {
      parsed.instanceHome = resolveInstanceHome(arg.slice('--home='.length));
    } else if (arg.startsWith('-')) {
      fail(`unknown option: ${arg}`);
    } else {
      parsed.positional.push(arg);
    }
  }
  return parsed;
}

function envDiff(env) {
  return [
    ['KF_INSTANCE_HOME', env.KF_INSTANCE_HOME],
    ['KF_HOME', env.KF_HOME],
    ['KF_CONFIG_HOME', env.KF_CONFIG_HOME],
    ['KF_PROJECTS_CONFIG_HOME', env.KF_PROJECTS_CONFIG_HOME],
    ['KF_RUNTIME_DIR', env.KF_RUNTIME_DIR],
    ['KUNGFU_SDK_ENTRY', env.KUNGFU_SDK_ENTRY],
    ['KUNGFU_KFD3_REGISTRY', env.KUNGFU_KFD3_REGISTRY],
    ['KUNGFU_KFD_UPSTREAM_AGGREGATE', env.KUNGFU_KFD_UPSTREAM_AGGREGATE],
    ['KUNGFU_TUI_SOURCE_CLI', env.KUNGFU_TUI_SOURCE_CLI],
  ]
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`);
}

function run(label, cmd, args, options = {}) {
  if (options.dryRun) {
    if (options.autoInstanceHome) {
      process.stdout.write(
        `[dry-run] auto-instance-home: ${options.autoInstanceHome}\n`,
      );
    }
    if (options.autoWorkspaceHome) {
      process.stdout.write(
        `[dry-run] auto-workspace-home: ${options.autoWorkspaceHome}\n`,
      );
    }
    const diff = envDiff(options.env || {});
    if (diff.length) {
      process.stdout.write(`[dry-run] env: ${diff.join(' ')}\n`);
    }
    process.stdout.write(`[dry-run] ${label}: ${[cmd, ...args].join(' ')}\n`);
    return;
  }
  if (options.instanceHome) {
    mkdirSync(options.instanceHome, { recursive: true });
    mkdirSync(path.join(options.instanceHome, 'config'), { recursive: true });
    mkdirSync(path.join(options.instanceHome, 'home', 'runtime'), {
      recursive: true,
    });
    const seed = seedInstanceConfig(options.instanceHome);
    if (seed.seeded) {
      process.stdout.write(
        `[instance-home] seeded config: ${seed.source} -> ${seed.target}\n`,
      );
    }
    for (const projectSeed of seedInstanceProjectIndex(options.instanceHome)) {
      process.stdout.write(
        `[instance-home] seeded Project index: ${projectSeed.source} -> ${projectSeed.target}\n`,
      );
    }
  }
  // Selecting a workspace is read-only. Desktop owns the write-intent-bound
  // ensure gate; the launcher must not initialize <workspace>/.kungfu merely
  // because a user opened or developed the product against that workspace.
  const result = spawnSync(cmd, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    stdio: 'inherit',
    shell: isWin,
  });
  if (result.status !== 0) fail(`${label} failed (${exitLabel(result)})`);
}

function pnpm(label, args, options) {
  run(label, 'pnpm', args, options);
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) usage(0);
  const parsed = parseArgs(argv);
  const { dryRun, positional } = parsed;
  const [surface, verb] = positional;
  if (parsed.emptyState && !(surface === 'tui' && verb === 'dev')) {
    fail('--empty-state is supported only by `product tui dev`');
  }
  const autoInstanceHome = '';
  const autoWorkspaceHome =
    devWorkspaceHomeOverride(parsed, surface, verb) ||
    (shouldAutoWorkspaceHome(parsed, surface, verb)
      ? workspaceDataHomeForCwd(ROOT)
      : '');
  const instanceHome =
    parsed.instanceHome || process.env.KF_INSTANCE_HOME || autoInstanceHome;
  const workspaceHome = instanceHome ? '' : autoWorkspaceHome;
  const baseEnv = workspaceEnv(workspaceHome, instanceEnv(instanceHome));
  const devEnv =
    (verb === 'dev' || (surface === 'tui' && verb === 'demo')) &&
    (surface === 'gui' || surface === 'tui')
      ? devKfdEnv(baseEnv)
      : baseEnv;
  const env =
    surface === 'tui' && (verb === 'dev' || verb === 'demo')
      ? devTuiCliEnv(devEnv)
      : devEnv;

  if (!surface || !verb) usage(1);

  if (surface === 'gui') {
    if (verb === 'supervise-dev') {
      if (dryRun) fail('internal gui supervisor does not support --dry-run');
      return guiDevelopmentMain(env);
    }
    if (verb === 'dev') {
      prepareDevViewExtensions({ dryRun, env });
      pnpm('gui dev', ['--filter', '@kungfu-tech/gui', 'run', 'dev'], {
        dryRun,
        env,
        instanceHome,
        autoInstanceHome,
        workspaceHome,
        autoWorkspaceHome,
      });
    } else if (verb === 'build' || verb === 'pack') {
      run(
        'desktop product dir build',
        process.execPath,
        ['product/scripts/dist.mjs', '--product', 'desktop', '--dir'],
        {
          dryRun,
          env,
          instanceHome,
          autoInstanceHome,
          workspaceHome,
          autoWorkspaceHome,
        },
      );
    } else if (verb === 'dist') {
      run(
        'desktop product dist build',
        process.execPath,
        ['product/scripts/dist.mjs', '--product', 'desktop'],
        {
          dryRun,
          env,
          instanceHome,
          autoInstanceHome,
          workspaceHome,
          autoWorkspaceHome,
        },
      );
    } else {
      fail('unknown gui command (supported: dev, build, pack, dist)');
    }
  } else if (surface === 'tui') {
    if (verb === 'dev') {
      const tuiArgs = ['--filter', '@kungfu-tech/tui', 'run', 'dev'];
      if (parsed.emptyState) tuiArgs.push('--', '--empty-state');
      pnpm('tui dev', tuiArgs, {
        dryRun,
        env,
        instanceHome,
        autoInstanceHome,
        workspaceHome,
        autoWorkspaceHome,
      });
    } else if (verb === 'demo') {
      pnpm(
        'tui offline demo',
        [
          '--filter',
          '@kungfu-tech/tui',
          'run',
          'dev',
          '--',
          '--agent-work-lab-autoplay',
        ],
        {
          dryRun,
          env,
          instanceHome,
          autoInstanceHome,
          workspaceHome,
          autoWorkspaceHome,
        },
      );
    } else if (verb === 'build') {
      pnpm('tui build', ['--filter', '@kungfu-tech/tui', 'run', 'build'], {
        dryRun,
        env,
        instanceHome,
        autoInstanceHome,
        workspaceHome,
        autoWorkspaceHome,
      });
    } else if (verb === 'bundle' || verb === 'dist') {
      pnpm('tui bundle', ['--filter', '@kungfu-tech/tui', 'run', 'bundle'], {
        dryRun,
        env,
        instanceHome,
        autoInstanceHome,
        workspaceHome,
        autoWorkspaceHome,
      });
    } else {
      fail('unknown tui command (supported: dev, demo, build, bundle, dist)');
    }
  } else if (surface === 'cli') {
    if (verb === 'dist') {
      run(
        'cli product dist build',
        process.execPath,
        ['product/scripts/dist.mjs', '--product', 'cli'],
        {
          dryRun,
          env,
          instanceHome,
          autoInstanceHome,
          workspaceHome,
          autoWorkspaceHome,
        },
      );
    } else {
      fail('unknown cli command (supported: dist)');
    }
  } else {
    fail('unknown product target (supported: gui, tui, cli)');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const result = main();
  if (result instanceof Promise) process.exitCode = await result;
}

export {
  devKfdEnv,
  devTuiCliEnv,
  devViewExtensionBuildPlan,
  devWorkspaceHomeOverride,
  instanceEnv,
  instanceHomeForWorktree,
  isLinkedGitWorktree,
  main,
  parseArgs,
  prepareDevViewExtensions,
  resolveInstanceHome,
  seedInstanceConfig,
  seedInstanceProjectIndex,
  shouldAutoInstanceHome,
  shouldAutoWorkspaceHome,
  workspaceDataHomeForCwd,
  workspaceEnv,
};
