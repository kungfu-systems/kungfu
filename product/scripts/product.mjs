// SPDX-License-Identifier: Apache-2.0
// Repo-local dogfood product entry. The SDK owns the generic external-project
// `kungfu sdk product` verbs; this wrapper maps the same vocabulary to Kungfu's
// product-level assembly so `./kungfu-code product gui build` does not silently
// regress to a GUI-only build.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..', '..');
const isWin = process.platform === 'win32';
const KFD3_REGISTRY = path.join(
  ROOT,
  '.buildchain',
  'kfd',
  'kfd-3-surfaces.json',
);
const KFD_UPSTREAM_AGGREGATE = path.join(
  ROOT,
  'developer',
  'sdk',
  'kfd',
  'upstream-aggregate.json',
);
const SDK_ENTRY = path.join(ROOT, 'developer', 'sdk', 'src', 'sdk.js');

function usage(code) {
  process.stdout.write(
    [
      'usage: ./kungfu-code product gui dev|build|pack|dist [--dry-run] [--instance-home <path>] [--no-instance-home]',
      '       ./kungfu-code product tui dev|build|bundle|dist [--dry-run] [--instance-home <path>] [--no-instance-home]',
      '       ./kungfu-code product cli dist [--dry-run] [--instance-home <path>] [--no-instance-home]',
      '',
      'gui build/pack  -> desktop product unpacked app under product/dist/desktop',
      'gui dist        -> desktop product installer assets under product/release/desktop',
      'tui bundle/dist -> bundled TUI under framework/tui/dist',
      'cli dist        -> CLI product archive under product/release/cli',
      '',
      '--instance-home, --home, -H <path>',
      '  run the product against an isolated Kungfu instance root:',
      '  KF_HOME=<path>/home, KF_CONFIG_HOME=<path>/config, KF_RUNTIME_DIR=<path>/home/runtime',
      '  dev commands auto-pick an instance root for linked git worktrees',
      '',
    ].join('\n'),
  );
  process.exit(code);
}

function fail(message) {
  process.stderr.write(`kungfu-code product: ${message}\n`);
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
      !env.KF_CONFIG_HOME &&
      verb === 'dev' &&
      (surface === 'gui' || surface === 'tui') &&
      isLinkedGitWorktree(ROOT),
  );
}

function instanceEnv(instanceHome, baseEnv = process.env) {
  if (!instanceHome) return { ...baseEnv };
  const runtimeHome = path.join(instanceHome, 'home');
  return {
    ...baseEnv,
    KF_INSTANCE_HOME: instanceHome,
    KF_HOME: runtimeHome,
    KF_CONFIG_HOME: path.join(instanceHome, 'config'),
    KF_RUNTIME_DIR: path.join(runtimeHome, 'runtime'),
  };
}

function devKfdEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
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

function parseArgs(argv) {
  const parsed = {
    dryRun: false,
    instanceHome: '',
    noInstanceHome: false,
    positional: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      parsed.dryRun = true;
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
    ['KF_RUNTIME_DIR', env.KF_RUNTIME_DIR],
    ['KUNGFU_SDK_ENTRY', env.KUNGFU_SDK_ENTRY],
    ['KUNGFU_KFD3_REGISTRY', env.KUNGFU_KFD3_REGISTRY],
    ['KUNGFU_KFD_UPSTREAM_AGGREGATE', env.KUNGFU_KFD_UPSTREAM_AGGREGATE],
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
  }
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
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
  const autoInstanceHome = shouldAutoInstanceHome(parsed, surface, verb)
    ? instanceHomeForWorktree(ROOT)
    : '';
  const instanceHome =
    parsed.instanceHome || process.env.KF_INSTANCE_HOME || autoInstanceHome;
  const baseEnv = instanceEnv(instanceHome);
  const env =
    verb === 'dev' && (surface === 'gui' || surface === 'tui')
      ? devKfdEnv(baseEnv)
      : baseEnv;

  if (!surface || !verb) usage(1);

  if (surface === 'gui') {
    if (verb === 'dev') {
      pnpm('gui dev', ['--filter', '@kungfu-tech/gui', 'run', 'dev'], {
        dryRun,
        env,
        instanceHome,
        autoInstanceHome,
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
        },
      );
    } else {
      fail('unknown gui command (supported: dev, build, pack, dist)');
    }
  } else if (surface === 'tui') {
    if (verb === 'dev') {
      pnpm('tui dev', ['--filter', '@kungfu-tech/tui', 'run', 'dev'], {
        dryRun,
        env,
        instanceHome,
        autoInstanceHome,
      });
    } else if (verb === 'build') {
      pnpm('tui build', ['--filter', '@kungfu-tech/tui', 'run', 'build'], {
        dryRun,
        env,
        instanceHome,
        autoInstanceHome,
      });
    } else if (verb === 'bundle' || verb === 'dist') {
      pnpm('tui bundle', ['--filter', '@kungfu-tech/tui', 'run', 'bundle'], {
        dryRun,
        env,
        instanceHome,
        autoInstanceHome,
      });
    } else {
      fail('unknown tui command (supported: dev, build, bundle, dist)');
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
  main();
}

export {
  devKfdEnv,
  instanceEnv,
  instanceHomeForWorktree,
  isLinkedGitWorktree,
  main,
  parseArgs,
  resolveInstanceHome,
  seedInstanceConfig,
  shouldAutoInstanceHome,
};
