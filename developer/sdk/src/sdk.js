#!/usr/bin/env node
// sdk — the Kungfu application assembly CLI, exposed as the `kungfu sdk` subcommand.
//
// First cut of the modern SDK surface: scaffold a complete Kungfu desktop app
// on the platform stack (electron-vite + React + the in-process runtime
// binding), wired the same way as the reference GUI. The generated app is
// self-contained; it consumes the platform through published packages, or
// through the workspace when scaffolded inside the monorepo (--workspace).
// @ts-check
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH } from '@kungfu-tech/buildchain/buildchain-layout';
import {
  collectKfdStatus,
  kfd1,
  kfd2,
  kfd3,
  kfd4,
  schemas as kfdSchemas,
} from '@kungfu-tech/buildchain/kfd';
import {
  BUILDCHAIN_JSON_FORMATTING_POLICY,
  createKfd1ReleaseGateEvidence,
  normalizeKfd1ContractWorldWitness,
  resolveKfd1Metadata,
  sha256Json as sha256KfdJson,
  validateKfd1ReleaseGateEvidence,
} from '@kungfu-tech/buildchain/kfd-gate';

const TEMPLATE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'templates',
);
const KFX_CONTRACT_FILE = 'kungfu-kfx.contract.json';
const KFX_CONTRACT_ENV = 'KUNGFU_KFX_CONTRACT';
const CONTRACT_REGISTRY_FILE = 'kungfu-contracts.registry.json';
const CONTRACT_REGISTRY_ENV = 'KUNGFU_CONTRACT_REGISTRY';
const CONTRACT_REGISTRY_SCHEMA = 'kungfu.contract-registry/v1';
const CONTRACT_FIXTURE_SCHEMA = 'kungfu.sdk.contract-drift-fixture/v1';
const CANONICAL_POLICY_SCHEMA = 'kungfu.agent-first-canonical-policy/v1';
const CANONICAL_POLICY_FILE = 'kungfu-agent-first-canonical-policy.json';
const require = createRequire(import.meta.url);
const { queryCapabilities: queryKfd3Capabilities } = kfd3;
const SDK_CLI = fileURLToPath(import.meta.url);
const SDK_ROOT = path.resolve(path.dirname(SDK_CLI), '..');
const SDK_KFD3_CANONICAL_REGISTRY = path.join(
  SDK_ROOT,
  'kfd',
  'kfd-3-surfaces.json',
);
const SDK_KFD_UPSTREAM_AGGREGATE = path.join(
  SDK_ROOT,
  'kfd',
  'upstream-aggregate.json',
);
const isWin = process.platform === 'win32';

/**
 * Print CLI usage and exit with the given status code.
 * @param {number} code
 * @returns {never}
 */
function usage(code) {
  process.stdout.write(
    [
      'usage: kungfu sdk create app <directory> [options]',
      '       kungfu sdk create extension <directory> [options]',
      '       kungfu sdk create skill <directory> [options]',
      '       kungfu sdk contract adopt <surface> [--source <path>] [--json]',
      '       kungfu sdk contract render <surface> [--check | --write] [--json]',
      '       kungfu sdk contract evidence [surface] [--json]',
      '       kungfu sdk contract policy [--check | --write] [--json]',
      '       kungfu sdk contract witness [--json]',
      '       kungfu sdk contract audit [--json]',
      '       kungfu sdk contract add <surface> [--source <path>] [--json]',
      '       kungfu sdk kfd status [--json]',
      '       kungfu sdk kfd schema <kfd-1|kfd-2|kfd-3|kfd-4> [--schema <name>] [--json]',
      '       kungfu sdk kfd 1 status|schema|witness [--json]',
      '       kungfu sdk kfd 2 status|schema|claims|trust-claims|trust-assessment [--json]',
      '       kungfu sdk kfd 4 status|schema [--json]',
      '       kungfu sdk kfd query|check|witness|upstream|aggregate [--json]',
      '       kungfu sdk kfx build | clean',
      '       kungfu sdk product gui dev|build|pack|dist [--dir <app-dir>] [--dry-run]',
      '       kungfu sdk product tui dev|build|bundle|dist [--dir <tui-dir>] [--dry-run]',
      '',
      'create options:',
      '  --name <name>   product/view name (defaults to the directory basename)',
      '  --workspace     wire platform deps as workspace:* (inside the monorepo)',
      '',
      'product options:',
      '  --dir <path>    project directory (defaults to the current directory)',
      '  --dry-run       print the underlying commands without running them',
      '',
      'contract options:',
      '  --source <path>  require the registered surface to use this source file',
      '  --check         compare rendered output with the current source file',
      '  --write         explicitly write canonical rendered contract JSON',
      '  --json          machine-readable output for contract evidence',
      '',
      'create extension scaffolds a view extension package (kfx): src/view/',
      'exports the View component, package.json carries the kungfuConfig',
      'manifest. kfx commands run inside such a package (a package.json with',
      'kungfuConfig.config.view); build bundles src/view/ to dist/view/index.js',
      'with react and the capability SDK left external — the shell injects',
      'its own instances at load time.',
      '',
      'kfx build also handles adapter facets (ships source), C++ extensions (a',
      'package with a CMakeLists.txt — CMake via the core conan toolchain), and',
      'Python AOT extensions (kungfuBuild.python — engage pdm install + engage',
      'nuitka --module), each producing a native module under dist/.',
      '',
      'create skill scaffolds the minimum valid Kungfu Skill source: a directory',
      'containing only SKILL.md. It is instruction-only until it explicitly',
      'declares kfx dependencies or capabilities.',
      '',
      'contract adopt/render are the KFD-1 SDK prototype: they adopt an existing',
      'registered contract surface and prove the SDK can reproduce its current',
      'source contract file without writing over it unless --write is explicit.',
      'contract policy/witness/audit are the agent-first canonical policy path:',
      'they import KFD metadata and Buildchain release-gate policy, then produce',
      'one local contract-world witness for config/kfx/skill without duplicating',
      'standard keys or JSON formatting rules.',
      '',
      'kfd status/schema and kfd 1/2/4 expose Kungfu KFD-1 contract-world,',
      'KFD-2 release-claim, KFD-3 capability, and KFD-4 schema-only facts.',
      'query/check/witness keep the existing KFD-3 capability query behavior;',
      'upstream and aggregate expose the SDK-packaged KFD view of Kungfu plus',
      'upstream KFD/libnode/Buildchain package facts, without a separate',
      'buildchain executable installation.',
      '',
    ].join('\n'),
  );
  process.exit(code);
}

/**
 * Print an error to stderr and exit non-zero.
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`kungfu sdk: ${message}\n`);
  process.exit(1);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parsed CLI options shared by SDK verbs.
 * @typedef {{ workspace: boolean, name: string, source: string, dir: string, schema: string, check: boolean, write: boolean, json: boolean, dryRun: boolean }} CliOptions
 */

/**
 * Split argv into positional arguments and named options.
 * @param {string[]} argv
 * @returns {{ positional: string[], options: CliOptions }}
 */
function parseArgs(argv) {
  const positional = [];
  const options = {
    workspace: false,
    name: '',
    source: '',
    dir: '',
    schema: '',
    check: false,
    write: false,
    json: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--workspace') options.workspace = true;
    else if (arg === '--name') {
      i += 1;
      options.name = argv[i] || '';
    } else if (arg === '--source') {
      i += 1;
      options.source = argv[i] || '';
    } else if (arg === '--dir') {
      i += 1;
      options.dir = argv[i] || '';
    } else if (arg === '--schema') {
      i += 1;
      options.schema = argv[i] || '';
    } else if (arg === '--check') {
      options.check = true;
    } else if (arg === '--write') {
      options.write = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '-h' || arg === '--help') usage(0);
    else if (arg.startsWith('-')) fail(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  return { positional, options };
}

/**
 * Derive a reverse-DNS application id from a product name.
 * @param {string} name
 * @returns {string}
 */
function toAppId(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `com.kungfu.app.${slug.replace(/-/g, '')}`;
}

/**
 * Copy a template tree into targetDir, substituting placeholder tokens.
 * @param {string} templateName
 * @param {string} targetDir
 * @param {Record<string, string>} replacements
 * @returns {void}
 */
function scaffold(templateName, targetDir, replacements) {
  const templateDir = path.join(TEMPLATE_ROOT, templateName);
  /**
   * @param {string} from
   * @param {string} to
   * @returns {void}
   */
  const copy = (from, to) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      // npm strips dotfiles from published packages; templates store them
      // with an underscore prefix.
      const outName = entry.name.startsWith('_')
        ? `.${entry.name.slice(1)}`
        : entry.name.replace(/\.tmpl$/, '');
      const src = path.join(from, entry.name);
      const dest = path.join(to, outName);
      if (entry.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        copy(src, dest);
      } else {
        let content = fs.readFileSync(src, 'utf8');
        for (const [token, value] of Object.entries(replacements)) {
          content = content.replaceAll(token, value);
        }
        fs.writeFileSync(dest, content);
      }
    }
  };
  fs.mkdirSync(targetDir, { recursive: true });
  copy(templateDir, targetDir);
}

/**
 * Scaffold a complete Kungfu desktop app into `directory`.
 * @param {string | undefined} directory
 * @param {CliOptions} options
 * @returns {void}
 */
function createApp(directory, options) {
  if (!directory) usage(1);
  const targetDir = path.resolve(directory);
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    fail(`target directory is not empty: ${targetDir}`);
  }
  const productName = options.name || path.basename(targetDir);
  const packageName = productName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  scaffold('app', targetDir, {
    __APP_NAME__: productName,
    __APP_PACKAGE__: packageName,
    __APP_ID__: toAppId(productName),
    __KF_DEP_VERSION__: options.workspace ? 'workspace:*' : '^4.0.0-alpha.0',
  });
  process.stdout.write(
    [
      `created ${productName} at ${targetDir}`,
      '',
      'next steps:',
      `  cd ${directory}`,
      '  pnpm install   # or npm/yarn',
      '  pnpm dev       # launch against a built kungfu-core (KUNGFU_DIR to override)',
      '',
    ].join('\n'),
  );
}

/**
 * Scaffold a view extension package (kfx) into `directory`.
 * @param {string | undefined} directory
 * @param {CliOptions} options
 * @returns {void}
 */
function createExtension(directory, options) {
  if (!directory) usage(1);
  const targetDir = path.resolve(directory);
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    fail(`target directory is not empty: ${targetDir}`);
  }
  const extName = options.name || path.basename(targetDir);
  const extKey = extName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  scaffold('extension', targetDir, {
    __EXT_NAME__: extName,
    __EXT_KEY__: extKey,
    __KF_DEP_VERSION__: options.workspace ? 'workspace:*' : '^4.0.0-alpha.0',
  });
  process.stdout.write(
    [
      `created ${extName} at ${targetDir}`,
      '',
      'next steps:',
      `  cd ${directory}`,
      '  pnpm install   # or npm/yarn',
      '  pnpm build     # kungfu sdk kfx build -> dist/view/index.js',
      '  npm pack       # the tgz is the install unit: kungfu kfx install <tgz>',
      '',
    ].join('\n'),
  );
}

/**
 * Scaffold a minimum valid Kungfu Skill source into `directory`.
 * @param {string | undefined} directory
 * @param {CliOptions} options
 * @returns {void}
 */
function createSkill(directory, options) {
  if (!directory) usage(1);
  const targetDir = path.resolve(directory);
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    fail(`target directory is not empty: ${targetDir}`);
  }
  const skillName = options.name || path.basename(targetDir);
  scaffold('skill', targetDir, {
    __SKILL_NAME__: skillName,
  });
  process.stdout.write(
    [
      `created ${skillName} at ${targetDir}`,
      '',
      'next steps:',
      `  kungfu skill validate ${directory}`,
      `  kungfu skill catalog --path ${directory} --json`,
      '',
    ].join('\n'),
  );
}

// ── product commands ───────────────────────────────────────────────────────
// `product` is the SDK-distributed product loop: the same verbs that a repo-local
// dogfood build uses are available to an external app/TUI project without
// copying shell-specific electron-builder incantations into every package.json.

/**
 * @param {string} cwd
 * @returns {string}
 */
function productCwd(cwd) {
  const resolved = path.resolve(cwd || process.cwd());
  if (!fs.existsSync(resolved))
    fail(`project directory not found: ${resolved}`);
  return resolved;
}

/**
 * @param {string} cwd
 * @returns {Record<string, unknown>}
 */
function readPackageJson(cwd) {
  const packageJson = path.join(cwd, 'package.json');
  if (!fs.existsSync(packageJson)) {
    fail(`package.json not found: ${packageJson}`);
  }
  const parsed = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
  if (!isObject(parsed)) {
    fail(`package.json must be a JSON object: ${packageJson}`);
  }
  return parsed;
}

/**
 * @param {Record<string, unknown>} pkg
 * @returns {Record<string, string>}
 */
function dependencyMap(pkg) {
  return {
    ...(isObject(pkg.dependencies)
      ? /** @type {Record<string, string>} */ (pkg.dependencies)
      : {}),
    ...(isObject(pkg.devDependencies)
      ? /** @type {Record<string, string>} */ (pkg.devDependencies)
      : {}),
  };
}

/**
 * @param {Record<string, unknown>} pkg
 * @returns {boolean}
 */
function isKfxManifest(pkg) {
  return isObject(pkg.kungfuConfig);
}

/**
 * @param {Record<string, unknown>} pkg
 * @returns {boolean}
 */
function isProductArtifactManifest(pkg) {
  if (isObject(pkg.kungfuProduct)) return true;
  const deps = dependencyMap(pkg);
  return (
    Boolean(deps['@kungfu-tech/gui']) &&
    Object.keys(deps).some((name) => name.startsWith('@kungfu-tech/kfx-'))
  );
}

/**
 * @param {Record<string, unknown>} pkg
 * @returns {Record<string, string>}
 */
function scriptsOf(pkg) {
  return isObject(pkg.scripts)
    ? /** @type {Record<string, string>} */ (pkg.scripts)
    : {};
}

/**
 * @param {string} cwd
 * @returns {{ cmd: string, argsForRun: (script: string) => string[] }}
 */
function packageRunner(cwd) {
  const roots = ancestorDirs(cwd);
  const manager = roots
    .map((dir) => {
      const pkgPath = path.join(dir, 'package.json');
      if (!fs.existsSync(pkgPath)) return '';
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return isObject(pkg) ? String(pkg.packageManager || '') : '';
      } catch {
        return '';
      }
    })
    .find(Boolean);
  if (
    manager?.startsWith('pnpm@') ||
    roots.some((dir) => fs.existsSync(path.join(dir, 'pnpm-lock.yaml')))
  ) {
    return {
      cmd: 'pnpm',
      argsForRun: (script) => ['--dir', cwd, 'run', script],
    };
  }
  if (
    manager?.startsWith('yarn@') ||
    roots.some((dir) => fs.existsSync(path.join(dir, 'yarn.lock')))
  ) {
    return { cmd: 'yarn', argsForRun: (script) => ['--cwd', cwd, script] };
  }
  return {
    cmd: 'npm',
    argsForRun: (script) => ['--prefix', cwd, 'run', script],
  };
}

/**
 * @param {string} cwd
 * @param {string} bin
 * @returns {string}
 */
function localBin(cwd, bin) {
  return path.join(cwd, 'node_modules', '.bin', isWin ? `${bin}.cmd` : bin);
}

/**
 * @param {string[]} parts
 * @returns {string}
 */
function shellLine(parts) {
  return parts
    .map((part) => (/[\s"'$]/.test(part) ? JSON.stringify(part) : part))
    .join(' ');
}

/**
 * @param {string} cwd
 * @param {string} bin
 * @param {string[]} args
 * @param {CliOptions} options
 * @returns {void}
 */
function runLocalBin(cwd, bin, args, options) {
  const cmd = localBin(cwd, bin);
  if (options.dryRun) {
    process.stdout.write(
      `[dry-run] cd ${cwd}\n[dry-run] ${shellLine([cmd, ...args])}\n`,
    );
    return;
  }
  if (!fs.existsSync(cmd)) {
    fail(
      `local ${bin} not found at ${cmd}; run your package manager install first`,
    );
  }
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: isWin,
  });
  if (result.status !== 0) {
    fail(
      `${bin} failed with exit ${result.status ?? `signal ${result.signal}`}`,
    );
  }
}

/**
 * @param {string} cwd
 * @param {string} script
 * @param {CliOptions} options
 * @param {{ env?: NodeJS.ProcessEnv, optional?: boolean }} [runOptions]
 * @returns {void}
 */
function runPackageScript(cwd, script, options, runOptions = {}) {
  const pkg = readPackageJson(cwd);
  if (!scriptsOf(pkg)[script]) {
    if (runOptions.optional) return;
    fail(`package ${String(pkg.name || cwd)} has no script: ${script}`);
  }
  const runner = packageRunner(cwd);
  const args = runner.argsForRun(script);
  if (options.dryRun) {
    process.stdout.write(
      `[dry-run] cd ${cwd}\n[dry-run] ${shellLine([runner.cmd, ...args])}\n`,
    );
    return;
  }
  const result = spawnSync(runner.cmd, args, {
    cwd,
    env: runOptions.env || process.env,
    stdio: 'inherit',
    shell: isWin,
  });
  if (result.status !== 0) {
    fail(
      `${runner.cmd} ${args.join(' ')} failed (exit ${result.status ?? `signal ${result.signal}`})`,
    );
  }
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {CliOptions} options
 * @param {{ env?: NodeJS.ProcessEnv }} [runOptions]
 * @returns {void}
 */
function runSdkCommand(cwd, args, options, runOptions = {}) {
  if (options.dryRun) {
    process.stdout.write(
      `[dry-run] cd ${cwd}\n[dry-run] ${shellLine([process.execPath, SDK_CLI, ...args])}\n`,
    );
    return;
  }
  const result = spawnSync(process.execPath, [SDK_CLI, ...args], {
    cwd,
    env: runOptions.env || process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    fail(
      `kungfu sdk ${args.join(' ')} failed (exit ${result.status ?? `signal ${result.signal}`})`,
    );
  }
}

/**
 * @param {string} cwd
 * @param {string} packageName
 * @returns {string | null}
 */
function resolvePackageDir(cwd, packageName) {
  const fromProject = () =>
    path.dirname(
      createRequire(path.join(cwd, 'package.json')).resolve(
        `${packageName}/package.json`,
      ),
    );
  const fromSdk = () =>
    path.dirname(require.resolve(`${packageName}/package.json`));
  for (const resolver of [fromProject, fromSdk]) {
    try {
      return resolver();
    } catch {
      // Try the next resolution base.
    }
  }
  return null;
}

/**
 * @param {string} startDir
 * @returns {string | null}
 */
function findRepoRootWithExtensions(startDir) {
  for (const dir of ancestorDirs(startDir)) {
    if (
      fs.existsSync(path.join(dir, 'framework', 'gui', 'package.json')) &&
      fs.existsSync(path.join(dir, 'extensions'))
    ) {
      return dir;
    }
  }
  return null;
}

/**
 * @param {string} cwd
 * @returns {string}
 */
function resolveReferenceGuiDir(cwd) {
  const repoRoot = findRepoRootWithExtensions(cwd);
  if (repoRoot) return path.join(repoRoot, 'framework', 'gui');
  const resolved = resolvePackageDir(cwd, '@kungfu-tech/gui');
  if (resolved) return resolved;
  fail(
    'cannot locate @kungfu-tech/gui; install @kungfu-tech/gui or run from a kungfu checkout',
  );
}

/**
 * @param {string} cwd
 * @returns {string | null}
 */
function resolveReferenceExtensionsRoot(cwd) {
  const repoRoot = findRepoRootWithExtensions(cwd);
  return repoRoot ? path.join(repoRoot, 'extensions') : null;
}

/**
 * @param {string} source
 * @param {string} target
 * @returns {void}
 */
function copyProductPackage(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const sourceRoot = path.resolve(source);
  fs.cpSync(source, target, {
    recursive: true,
    dereference: false,
    filter: (src) => {
      const resolved = path.resolve(src);
      if (
        resolved !== sourceRoot &&
        fs.existsSync(path.join(resolved, 'package.json')) &&
        fs.statSync(resolved).isDirectory()
      ) {
        return false;
      }
      const base = path.basename(src);
      return ![
        'node_modules',
        'build',
        '.venv',
        '__pycache__',
        '.DS_Store',
      ].includes(base);
    },
  });
}

/**
 * @param {Record<string, unknown>} pkg
 * @param {string} fallback
 * @returns {string}
 */
function packageInstallKey(pkg, fallback) {
  const config = isObject(pkg.kungfuConfig) ? pkg.kungfuConfig : {};
  const key = config.key;
  return String(key || fallback).replace(/[^a-zA-Z0-9._-]+/g, '-');
}

/**
 * @param {string} cwd
 * @param {string[]} packageNames
 * @param {string | null} extraPackageDir
 * @param {CliOptions} options
 * @param {{ temp?: boolean }} [assembleOptions]
 * @returns {string}
 */
function assembleProductExtensions(
  cwd,
  packageNames,
  extraPackageDir,
  options,
  assembleOptions = {},
) {
  const targetRoot = assembleOptions.temp
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-product-extensions-'))
    : path.join(cwd, 'extensions');
  if (options.dryRun) {
    process.stdout.write(`[dry-run] assemble kfx -> ${targetRoot}\n`);
    return targetRoot;
  }
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(targetRoot, { recursive: true });
  const copied = new Set();
  /**
   * @param {string} sourceDir
   * @returns {void}
   */
  const copyOne = (sourceDir) => {
    const pkg = readPackageJson(sourceDir);
    if (!isKfxManifest(pkg)) return;
    const key = packageInstallKey(pkg, path.basename(sourceDir));
    if (copied.has(key)) return;
    copyProductPackage(sourceDir, path.join(targetRoot, key));
    copied.add(key);
  };
  if (extraPackageDir) copyOne(extraPackageDir);
  for (const name of packageNames) {
    const sourceDir = resolvePackageDir(cwd, name);
    if (!sourceDir) fail(`cannot resolve declared kfx dependency: ${name}`);
    copyOne(sourceDir);
  }
  return targetRoot;
}

/**
 * @param {string} cwd
 * @returns {string[]}
 */
function declaredKfxDependencies(cwd) {
  const pkg = readPackageJson(cwd);
  return Object.keys(dependencyMap(pkg))
    .filter((name) => name.startsWith('@kungfu-tech/kfx-'))
    .sort();
}

/**
 * @param {string} cwd
 * @returns {boolean}
 */
function isBuildableKfxPackage(cwd) {
  const pkg = readPackageJson(cwd);
  const config = isObject(pkg.kungfuConfig) ? pkg.kungfuConfig : {};
  const facets = isObject(config.config) ? config.config : {};
  return (
    Boolean(facets.view) ||
    Boolean(facets.adapter) ||
    Boolean(facets.service) ||
    fs.existsSync(path.join(cwd, 'CMakeLists.txt')) ||
    isObject(pkg.kungfuBuild)
  );
}

/**
 * @param {string} cwd
 * @param {CliOptions} options
 * @returns {string}
 */
function electronDist(cwd, options) {
  try {
    const projectRequire = createRequire(path.join(cwd, 'package.json'));
    return `${path.dirname(projectRequire.resolve('electron'))}/dist`;
  } catch (e) {
    if (options.dryRun) return 'node_modules/electron/dist';
    fail(
      `cannot resolve electron from ${cwd}; install project dependencies first (${errorMessage(e)})`,
    );
  }
}

/**
 * @param {string} cwd
 * @returns {NodeJS.ProcessEnv}
 */
function kfxProductEnv(cwd) {
  const referenceRoot = resolveReferenceExtensionsRoot(cwd);
  const extensionRoot = referenceRoot
    ? referenceRoot
    : assembleProductExtensions(
        cwd,
        [],
        cwd,
        {
          workspace: false,
          name: '',
          source: '',
          dir: '',
          schema: '',
          check: false,
          write: false,
          json: false,
          dryRun: false,
        },
        { temp: true },
      );
  const roots = [path.dirname(cwd)];
  if (!roots.includes(extensionRoot)) roots.push(extensionRoot);
  if (process.env.KF_EXTENSION_PATH) roots.push(process.env.KF_EXTENSION_PATH);
  return {
    ...process.env,
    KF_EXTENSION_PATH: roots.join(path.delimiter),
    KF_FIRST_PARTY_SOURCE_ROOT: extensionRoot,
  };
}

/**
 * @param {string} cwd
 * @param {string} verb
 * @param {CliOptions} options
 * @returns {void}
 */
function productKfxGui(cwd, verb, options) {
  if (verb === 'build') {
    runSdkCommand(cwd, ['kfx', 'build'], options);
    return;
  }
  if (verb !== 'dev') {
    fail(
      'kfx product gui supports dev and build; use an artifact product for pack/dist',
    );
  }
  runSdkCommand(cwd, ['kfx', 'build'], options);
  const guiDir = resolveReferenceGuiDir(cwd);
  const env = options.dryRun ? process.env : kfxProductEnv(cwd);
  if (options.dryRun) {
    const referenceRoot =
      resolveReferenceExtensionsRoot(cwd) || '<sdk bundled kfx>';
    process.stdout.write(
      `[dry-run] KF_EXTENSION_PATH=${path.dirname(cwd)}${path.delimiter}${referenceRoot}\n`,
    );
    process.stdout.write(
      `[dry-run] KF_FIRST_PARTY_SOURCE_ROOT=${referenceRoot}\n`,
    );
  }
  runPackageScript(guiDir, 'dev', options, { env });
}

/**
 * @param {string} cwd
 * @param {string} verb
 * @param {CliOptions} options
 * @returns {void}
 */
function productArtifactGui(cwd, verb, options) {
  const kfxPackages = declaredKfxDependencies(cwd);
  for (const name of kfxPackages) {
    const packageDir = resolvePackageDir(cwd, name);
    if (!packageDir) fail(`cannot resolve declared kfx dependency: ${name}`);
    if (!isBuildableKfxPackage(packageDir)) continue;
    runSdkCommand(packageDir, ['kfx', 'build'], options);
  }

  if (verb === 'dev') {
    const extensionRoot = assembleProductExtensions(
      cwd,
      kfxPackages,
      null,
      options,
    );
    const guiDir =
      resolvePackageDir(cwd, '@kungfu-tech/gui') || resolveReferenceGuiDir(cwd);
    const env = {
      ...process.env,
      KF_EXTENSION_PATH: [extensionRoot, process.env.KF_EXTENSION_PATH]
        .filter(Boolean)
        .join(path.delimiter),
      KF_FIRST_PARTY_SOURCE_ROOT: extensionRoot,
    };
    runPackageScript(guiDir, 'dev', options, { env });
    return;
  }

  const extensionRoot = assembleProductExtensions(
    cwd,
    kfxPackages,
    null,
    options,
  );
  const tuiDir = resolvePackageDir(cwd, '@kungfu-tech/tui');
  if (tuiDir) runPackageScript(tuiDir, 'bundle', options, { optional: true });

  const guiDir =
    resolvePackageDir(cwd, '@kungfu-tech/gui') || resolveReferenceGuiDir(cwd);
  runPackageScript(guiDir, 'ensure-electron', options, { optional: true });
  runPackageScript(guiDir, 'build', options);

  if (verb === 'build') return;

  const config = path.join(cwd, 'electron-builder.yml');
  if (!fs.existsSync(config)) {
    fail(`artifact product config not found: ${config}`);
  }
  const builderScript = path.join(
    guiDir,
    'scripts',
    'run-electron-builder.mjs',
  );
  const args = [`--config=${config}`];
  if (verb === 'pack') args.unshift('--dir');
  if (options.dryRun) {
    process.stdout.write(
      `[dry-run] cd ${guiDir}\n[dry-run] KF_FIRST_PARTY_SOURCE_ROOT=${extensionRoot} ${shellLine([process.execPath, builderScript, ...args])}\n`,
    );
    return;
  }
  const result = spawnSync(process.execPath, [builderScript, ...args], {
    cwd: guiDir,
    env: {
      ...process.env,
      KF_FIRST_PARTY_SOURCE_ROOT: extensionRoot,
    },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    fail(
      `electron-builder failed (exit ${result.status ?? `signal ${result.signal}`})`,
    );
  }
}

/**
 * @param {string} cwd
 * @param {string} verb
 * @param {CliOptions} options
 * @returns {Promise<void>}
 */
async function productArtifactTui(cwd, verb, options) {
  const tuiDir = resolvePackageDir(cwd, '@kungfu-tech/tui');
  if (!tuiDir) fail('artifact product does not declare @kungfu-tech/tui');
  if (verb === 'dev') {
    runPackageScript(tuiDir, 'dev', options);
    return;
  }
  if (verb === 'build') {
    runPackageScript(tuiDir, 'build', options);
    return;
  }
  if (verb === 'bundle' || verb === 'dist') {
    runPackageScript(tuiDir, 'bundle', options);
    return;
  }
  fail('unknown product tui command (supported: dev, build, bundle, dist)');
}

/**
 * @param {string} verb
 * @param {CliOptions} options
 * @returns {void}
 */
function productGui(verb, options) {
  const cwd = productCwd(options.dir);
  const pkg = readPackageJson(cwd);
  if (isKfxManifest(pkg)) {
    productKfxGui(cwd, verb, options);
    return;
  }
  if (isProductArtifactManifest(pkg)) {
    productArtifactGui(cwd, verb, options);
    return;
  }
  if (verb === 'dev') {
    runLocalBin(cwd, 'electron-vite', ['dev'], options);
    return;
  }
  if (verb === 'build') {
    runLocalBin(cwd, 'electron-vite', ['build'], options);
    return;
  }
  if (verb === 'pack' || verb === 'dist') {
    runLocalBin(cwd, 'electron-vite', ['build'], options);
    const args = [`--config.electronDist=${electronDist(cwd, options)}`];
    if (verb === 'pack') args.unshift('--dir');
    runLocalBin(cwd, 'electron-builder', args, options);
    return;
  }
  fail('unknown product gui command (supported: dev, build, pack, dist)');
}

const TUI_BUNDLE_BANNER = [
  "import { createRequire as __kfCreateRequire } from 'node:module';",
  'const require = __kfCreateRequire(import.meta.url);',
].join('\n');

const stubDevtools = {
  name: 'stub-react-devtools-core',
  /**
   * @param {any} build
   * @returns {void}
   */
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core',
      namespace: 'stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export function connectToDevTools() {}\nexport default {};\n',
      loader: 'js',
    }));
  },
};

/**
 * @param {CliOptions} options
 * @returns {Promise<void>}
 */
async function productTuiBundle(options) {
  const cwd = productCwd(options.dir);
  const entry = path.join(cwd, 'src', 'main.tsx');
  const outfile = path.join(cwd, 'dist', 'tui.mjs');
  if (options.dryRun) {
    process.stdout.write(
      `[dry-run] cd ${cwd}\n[dry-run] esbuild src/main.tsx --bundle --platform=node --format=esm --target=node20 --outfile=dist/tui.mjs\n`,
    );
    return;
  }
  if (!fs.existsSync(entry)) fail(`TUI entry not found: ${entry}`);
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    plugins: [stubDevtools],
    banner: { js: TUI_BUNDLE_BANNER },
    logLevel: 'info',
  });
}

/**
 * @param {string} verb
 * @param {CliOptions} options
 * @returns {Promise<void>}
 */
async function productTui(verb, options) {
  const cwd = productCwd(options.dir);
  const pkg = readPackageJson(cwd);
  if (isProductArtifactManifest(pkg)) {
    await productArtifactTui(cwd, verb, options);
    return;
  }
  if (verb === 'dev') {
    runLocalBin(cwd, 'tsx', ['src/main.tsx'], options);
    return;
  }
  if (verb === 'build') {
    runLocalBin(cwd, 'tsc', [], options);
    return;
  }
  if (verb === 'bundle' || verb === 'dist') {
    await productTuiBundle(options);
    return;
  }
  fail('unknown product tui command (supported: dev, build, bundle, dist)');
}

/**
 * @param {string | undefined} surface
 * @param {string | undefined} verb
 * @param {CliOptions} options
 * @returns {Promise<void>}
 */
async function product(surface, verb, options) {
  if (!surface || !verb) usage(1);
  if (surface === 'gui') {
    productGui(verb, options);
    return;
  }
  if (surface === 'tui') {
    await productTui(verb, options);
    return;
  }
  fail('unknown product target (supported: gui, tui)');
}

// ── KFD-1 contract prototype ───────────────────────────────────────────────
// The first SDK contract slice adopts existing registered mother files. It is
// deliberately read-only: the registry and contract files stay the truth source,
// while the SDK proves it can resolve and reproduce them without drift.

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {string} file
 * @returns {unknown}
 */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function renderJson(value) {
  const indentation =
    Number(BUILDCHAIN_JSON_FORMATTING_POLICY.indentation) || 2;
  const rendered = JSON.stringify(value, null, indentation);
  return BUILDCHAIN_JSON_FORMATTING_POLICY.trailingNewline === false
    ? rendered
    : `${rendered}\n`;
}

/**
 * @param {string} file
 * @returns {string}
 */
function sha256File(file) {
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

/**
 * @param {string} startDir
 * @returns {string}
 */
function locateRepoRoot(startDir) {
  for (const dir of ancestorDirs(startDir)) {
    const candidate = path.join(
      dir,
      'framework',
      'contract',
      CONTRACT_REGISTRY_FILE,
    );
    if (fs.existsSync(candidate)) return dir;
  }
  fail(`cannot locate ${CONTRACT_REGISTRY_FILE} from ${startDir}`);
}

/**
 * @param {string} repoRoot
 * @param {string} target
 * @returns {string}
 */
function rel(repoRoot, target) {
  return path.relative(repoRoot, target).split(path.sep).join('/');
}

/**
 * @param {string} repoRoot
 * @param {string} target
 * @returns {string}
 */
function repoRelativePath(repoRoot, target) {
  const relative = rel(repoRoot, path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`path must stay inside the repository: ${target}`);
  }
  return relative;
}

/**
 * @param {string} surface
 * @returns {string}
 */
function normalizeSurface(surface) {
  const normalized = surface.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(normalized)) {
    fail(`invalid contract surface: ${surface}`);
  }
  return normalized;
}

/**
 * @param {string} surface
 * @returns {string}
 */
function contractEnvName(surface) {
  return `KUNGFU_${surface.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_CONTRACT`;
}

/**
 * @param {Record<string, unknown>} registry
 * @param {string} surface
 * @returns {boolean}
 */
function hasContractEntry(registry, surface) {
  return /** @type {unknown[]} */ (registry.contracts).some(
    (entry) => isObject(entry) && entry.surface === surface,
  );
}

/**
 * @param {string} surface
 * @returns {Record<string, unknown>}
 */
function contractTemplate(surface) {
  const schema = `kungfu.${surface}.contract/v1`;
  const id = `kungfu-${surface}`;
  const weldedSurface = `${surface}-contract`;
  return {
    schema,
    id,
    version: 1,
    weldedSurface,
    description: `KFD-1 contract source for ${surface}.`,
    contractSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: true,
      required: [
        'schema',
        'id',
        'version',
        'weldedSurface',
        'description',
        'contractSchema',
      ],
      properties: {
        schema: { type: 'string', const: schema },
        id: { type: 'string', const: id },
        version: { type: 'integer', minimum: 1 },
        weldedSurface: { type: 'string', const: weldedSurface },
        description: { type: 'string' },
        contractSchema: { type: 'object' },
      },
    },
  };
}

/**
 * @param {string} surface
 * @param {string} source
 * @returns {Record<string, unknown>}
 */
function registryEntryTemplate(surface, source) {
  const file = path.basename(source);
  return {
    surface,
    id: `kungfu-${surface}`,
    schema: `kungfu.${surface}.contract/v1`,
    weldedSurface: `${surface}-contract`,
    env: contractEnvName(surface),
    file,
    source,
    artifact: `config/${file}`,
    probeFixture: contractFixturePath(surface),
  };
}

/**
 * @param {string} surface
 * @returns {string}
 */
function contractFixturePath(surface) {
  return `framework/contract/fixtures/${surface}.contract-evidence.json`;
}

/**
 * @param {string} repoRoot
 * @returns {string}
 */
function resolveContractRegistryPath(repoRoot) {
  const explicit = process.env[CONTRACT_REGISTRY_ENV];
  if (explicit) return path.resolve(explicit);
  return path.join(repoRoot, 'framework', 'contract', CONTRACT_REGISTRY_FILE);
}

/**
 * @param {string} registryPath
 * @returns {Record<string, unknown>}
 */
function loadContractRegistry(registryPath) {
  const registry = readJson(registryPath);
  if (!isObject(registry)) {
    fail(`contract registry must be a JSON object: ${registryPath}`);
  }
  if (registry.schema !== CONTRACT_REGISTRY_SCHEMA) {
    fail(`contract registry schema mismatch: ${String(registry.schema)}`);
  }
  if (!Array.isArray(registry.contracts)) {
    fail('contract registry must contain a contracts array');
  }
  return registry;
}

/**
 * @param {Record<string, unknown>} registry
 * @returns {Array<Record<string, unknown>>}
 */
function registryContracts(registry) {
  if (!Array.isArray(registry.contracts)) {
    fail('contract registry must contain a contracts array');
  }
  return /** @type {Array<Record<string, unknown>>} */ (registry.contracts);
}

/**
 * @param {string} exportPath
 * @returns {unknown}
 */
function readJsonPackageExport(exportPath) {
  return JSON.parse(fs.readFileSync(require.resolve(exportPath), 'utf8'));
}

/**
 * @param {string} packageName
 * @returns {{ name: string, version: string }}
 */
function packageIdentity(packageName) {
  const packageJson = readJsonPackageExport(`${packageName}/package.json`);
  if (!isObject(packageJson)) {
    fail(`package metadata must be a JSON object: ${packageName}`);
  }
  return {
    name: String(packageJson.name || packageName),
    version: String(packageJson.version || ''),
  };
}

/**
 * @param {Record<string, unknown>} schema
 * @returns {string}
 */
function schemaContractConst(schema) {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const contract = isObject(properties.contract) ? properties.contract : {};
  const value = contract.const;
  if (typeof value !== 'string' || value.length === 0) {
    fail('KFD schema export missing properties.contract.const');
  }
  return value;
}

/**
 * @param {ReturnType<typeof resolveKfd1Metadata>} metadata
 * @returns {{ contractWorld: string, witness: string }}
 */
function kfd1SchemaConstants(metadata) {
  const contractWorldSchema = readJsonPackageExport(
    `@kungfu-tech/kfd/${metadata.schemaPaths.contractWorld}`,
  );
  const witnessSchema = readJsonPackageExport(
    `@kungfu-tech/kfd/${metadata.schemaPaths.witness}`,
  );
  if (!isObject(contractWorldSchema) || !isObject(witnessSchema)) {
    fail('KFD schema exports must be JSON objects');
  }
  return {
    contractWorld: schemaContractConst(contractWorldSchema),
    witness: schemaContractConst(witnessSchema),
  };
}

/**
 * @param {string} repoRoot
 * @returns {{ source: string, artifact: string }}
 */
function canonicalPolicyPaths(repoRoot) {
  const registry = loadContractRegistry(resolveContractRegistryPath(repoRoot));
  const declared = isObject(registry.canonicalPolicy)
    ? /** @type {Record<string, unknown>} */ (registry.canonicalPolicy)
    : {};
  return {
    source:
      typeof declared.source === 'string'
        ? declared.source
        : path.join('framework', 'contract', CANONICAL_POLICY_FILE),
    artifact:
      typeof declared.artifact === 'string'
        ? declared.artifact
        : path.join('config', CANONICAL_POLICY_FILE),
  };
}

/**
 * @param {Record<string, unknown>} registry
 * @param {string} surface
 * @returns {Record<string, unknown>}
 */
function findContractEntry(registry, surface) {
  const matches = /** @type {unknown[]} */ (registry.contracts).filter(
    (entry) => isObject(entry) && entry.surface === surface,
  );
  if (matches.length === 0) {
    fail(`contract surface is not registered: ${surface}`);
  }
  if (matches.length > 1) {
    fail(`contract surface is registered more than once: ${surface}`);
  }
  return /** @type {Record<string, unknown>} */ (matches[0]);
}

/**
 * @param {Record<string, unknown>} entry
 * @param {string} key
 * @returns {string}
 */
function requiredString(entry, key) {
  const value = entry[key];
  if (typeof value !== 'string' || value.length === 0) {
    fail(`contract registry entry missing string field: ${key}`);
  }
  return value;
}

/**
 * @param {Record<string, unknown>} contract
 * @param {string} key
 * @returns {string | number}
 */
function requiredScalar(contract, key) {
  const value = contract[key];
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    value === ''
  ) {
    fail(`contract file missing scalar field: ${key}`);
  }
  return value;
}

/**
 * @param {string | undefined} surface
 * @param {CliOptions} options
 * @returns {{
 *   repoRoot: string,
 *   registryPath: string,
 *   entry: Record<string, unknown>,
 *   contractPath: string,
 *   contractText: string,
 *   contract: Record<string, unknown>,
 * }}
 */
function loadContractSurface(surface, options) {
  if (!surface) usage(1);
  const repoRoot = locateRepoRoot(process.cwd());
  const registryPath = resolveContractRegistryPath(repoRoot);
  const registry = loadContractRegistry(registryPath);
  const entry = findContractEntry(registry, surface);
  const registeredSource = requiredString(entry, 'source');
  const contractPath = path.resolve(repoRoot, registeredSource);
  if (!fs.existsSync(contractPath)) {
    fail(`registered contract source does not exist: ${registeredSource}`);
  }
  if (options.source) {
    const requested = path.resolve(options.source);
    if (requested !== contractPath) {
      fail(
        `--source does not match registry source for ${surface}: ${rel(repoRoot, requested)} != ${registeredSource}`,
      );
    }
  }
  const contractText = fs.readFileSync(contractPath, 'utf8');
  const parsed = JSON.parse(contractText);
  if (!isObject(parsed)) {
    fail(`contract source must be a JSON object: ${registeredSource}`);
  }
  const contract = parsed;
  const expected = {
    schema: requiredString(entry, 'schema'),
    id: requiredString(entry, 'id'),
    weldedSurface: requiredString(entry, 'weldedSurface'),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (contract[key] !== value) {
      fail(
        `${surface} contract ${key} mismatch: ${String(contract[key])} != ${value}`,
      );
    }
  }
  requiredScalar(contract, 'version');
  if (!isObject(contract.contractSchema)) {
    fail(`${surface} contract missing contractSchema object`);
  }
  return {
    repoRoot,
    registryPath,
    entry,
    contractPath,
    contractText,
    contract,
  };
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {Array<Record<string, unknown>>}
 */
function extraArtifacts(entry) {
  return Array.isArray(entry.extraArtifacts)
    ? /** @type {Array<Record<string, unknown>>} */ (
        entry.extraArtifacts.filter(isObject)
      )
    : [];
}

/**
 * @param {string | undefined} surface
 * @param {CliOptions} options
 * @returns {void}
 */
function contractAdopt(surface, options) {
  const state = loadContractSurface(surface, options);
  const data = {
    schema: 'kungfu.sdk.contract-adopt/v1',
    ok: true,
    surface,
    registry: rel(state.repoRoot, state.registryPath),
    source: rel(state.repoRoot, state.contractPath),
    artifact: requiredString(state.entry, 'artifact'),
    env: requiredString(state.entry, 'env'),
    contract: {
      id: state.contract.id,
      schema: state.contract.schema,
      version: state.contract.version,
      weldedSurface: state.contract.weldedSurface,
      hash: sha256File(state.contractPath),
    },
    render: {
      mode: 'source-json-replay',
      checkCommand: `kungfu sdk contract render ${surface} --check --json`,
    },
    extraArtifacts: extraArtifacts(state.entry).map((artifact) => ({
      label: artifact.label,
      source: artifact.source,
      artifact: artifact.artifact,
    })),
  };
  if (options.json) {
    process.stdout.write(renderJson(data));
    return;
  }
  process.stdout.write(
    [
      `[contract] adopted ${surface}`,
      `  source: ${data.source}`,
      `  artifact: ${data.artifact}`,
      `  hash: ${data.contract.hash}`,
      `  check: ${data.render.checkCommand}`,
      '',
    ].join('\n'),
  );
}

/**
 * @param {string | undefined} surface
 * @param {CliOptions} options
 * @returns {void}
 */
function contractRender(surface, options) {
  const state = loadContractSurface(surface, options);
  const rendered = renderJson(state.contract);
  if (options.check && options.write) {
    fail('contract render accepts either --check or --write, not both');
  }
  if (options.write) {
    const previousHash = sha256File(state.contractPath);
    fs.writeFileSync(state.contractPath, rendered);
    const data = {
      schema: 'kungfu.sdk.contract-render-write/v1',
      ok: true,
      surface,
      source: rel(state.repoRoot, state.contractPath),
      previousHash,
      hash: sha256File(state.contractPath),
      changed: state.contractText !== rendered,
      mode: 'canonical-json',
    };
    if (options.json) {
      process.stdout.write(renderJson(data));
    } else {
      process.stdout.write(
        `[contract] ${surface} wrote ${data.source} changed=${data.changed}\n`,
      );
    }
    return;
  }
  if (!options.check) {
    process.stdout.write(rendered);
    return;
  }
  const data = {
    schema: 'kungfu.sdk.contract-render-check/v1',
    ok: true,
    surface,
    source: rel(state.repoRoot, state.contractPath),
    hash: sha256File(state.contractPath),
    renderedHash: `sha256:${createHash('sha256').update(rendered).digest('hex')}`,
    mode: 'canonical-json',
    byteForByte: state.contractText === rendered,
  };
  if (options.json) {
    process.stdout.write(renderJson(data));
  } else if (data.ok) {
    process.stdout.write(`[contract] ${surface} render check ok\n`);
  } else {
    process.stderr.write(`[contract] ${surface} render check failed\n`);
  }
  if (!data.ok) process.exit(1);
}

/**
 * @param {ReturnType<typeof loadContractSurface>} state
 * @returns {Record<string, unknown>}
 */
function contractEvidenceRow(state) {
  const source = rel(state.repoRoot, state.contractPath);
  const rendered = renderJson(state.contract);
  const surface = requiredString(state.entry, 'surface');
  const fixture =
    typeof state.entry.probeFixture === 'string'
      ? state.entry.probeFixture
      : contractFixturePath(surface);
  const fixturePath = path.resolve(state.repoRoot, fixture);
  const fixtureExists = fs.existsSync(fixturePath);
  return {
    surface,
    source,
    artifact: requiredString(state.entry, 'artifact'),
    env: requiredString(state.entry, 'env'),
    fixture: {
      path: fixture,
      exists: fixtureExists,
      hash: fixtureExists ? sha256File(fixturePath) : null,
    },
    contract: {
      id: state.contract.id,
      schema: state.contract.schema,
      version: state.contract.version,
      weldedSurface: state.contract.weldedSurface,
      sourceHash: sha256File(state.contractPath),
      renderedHash: `sha256:${createHash('sha256').update(rendered).digest('hex')}`,
      byteForByte: state.contractText === rendered,
    },
    extraArtifacts: extraArtifacts(state.entry).map((artifact) => ({
      label: artifact.label,
      source: artifact.source,
      artifact: artifact.artifact,
    })),
  };
}

/**
 * @param {string | undefined} surface
 * @param {CliOptions} options
 * @returns {void}
 */
function contractEvidence(surface, options) {
  const repoRoot = locateRepoRoot(process.cwd());
  const registryPath = resolveContractRegistryPath(repoRoot);
  const registry = loadContractRegistry(registryPath);
  const metadata = resolveKfd1Metadata();
  const surfaces = surface
    ? [surface]
    : registryContracts(registry).map((entry) =>
        requiredString(entry, 'surface'),
      );
  const contracts = surfaces.map((name) =>
    contractEvidenceRow(loadContractSurface(name, options)),
  );
  const data = {
    schema: 'kungfu.sdk.contract-evidence/v1',
    ok: true,
    registry: rel(repoRoot, registryPath),
    releaseGate: {
      kfd: metadata.label,
      key: metadata.key,
      claim: metadata.title,
      role: 'local-evidence',
      sourceOfTruth: rel(repoRoot, registryPath),
      policy: 'advisory-only; this command does not enforce release policy',
      metadata: {
        package: metadata.package,
        schemaIds: metadata.schemaIds,
        schemaPaths: metadata.schemaPaths,
      },
    },
    summary: {
      count: contracts.length,
      surfaces: contracts.map((contract) => contract.surface),
      byteForByte: contracts.every(
        (contract) =>
          isObject(contract.contract) && contract.contract.byteForByte === true,
      ),
      fixtures: contracts.filter(
        (contract) =>
          isObject(contract.fixture) && contract.fixture.exists === true,
      ).length,
    },
    contracts,
  };
  if (options.json) {
    process.stdout.write(renderJson(data));
    return;
  }
  process.stdout.write(
    [
      `[contract] evidence surfaces=${data.summary.count} fixtures=${data.summary.fixtures}`,
      `  registry: ${data.registry}`,
      `  byte-for-byte: ${data.summary.byteForByte}`,
      '',
    ].join('\n'),
  );
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {{ id: string, surface: string, source: string, artifact: string, contractPath: string, contract: Record<string, unknown>, sourceHash: string, renderedHash: string, byteForByte: boolean }}
 */
function contractPolicySurface(entry) {
  const surface = requiredString(entry, 'surface');
  const state = loadContractSurface(surface, {
    workspace: false,
    name: '',
    source: '',
    dir: '',
    schema: '',
    check: false,
    write: false,
    json: true,
    dryRun: false,
  });
  const rendered = renderJson(state.contract);
  return {
    id: requiredString(entry, 'id'),
    surface,
    source: rel(state.repoRoot, state.contractPath),
    artifact: requiredString(entry, 'artifact'),
    contractPath: state.contractPath,
    contract: state.contract,
    sourceHash: sha256File(state.contractPath),
    renderedHash: `sha256:${createHash('sha256').update(rendered).digest('hex')}`,
    byteForByte: state.contractText === rendered,
  };
}

/**
 * @param {string} repoRoot
 * @param {Record<string, unknown>} registry
 * @returns {Record<string, unknown>}
 */
function buildContractWorld(repoRoot, registry) {
  const metadata = resolveKfd1Metadata();
  const constants = kfd1SchemaConstants(metadata);
  const registryPath = resolveContractRegistryPath(repoRoot);
  const surfaces = registryContracts(registry).map((entry) => {
    const surface = contractPolicySurface(entry);
    return {
      id: surface.id,
      class: 'integration-time',
      description: `${surface.surface} contract source ${surface.source} is copied byte-for-byte to ${surface.artifact}.`,
    };
  });
  return {
    schemaVersion: 1,
    contract: constants.contractWorld,
    standard: metadata.key,
    factSource: rel(repoRoot, registryPath),
    surfaces,
  };
}

/**
 * @param {string} repoRoot
 * @returns {Record<string, unknown>}
 */
function buildCanonicalPolicy(repoRoot) {
  const registryPath = resolveContractRegistryPath(repoRoot);
  const registry = loadContractRegistry(registryPath);
  const metadata = resolveKfd1Metadata();
  const policyPaths = canonicalPolicyPaths(repoRoot);
  const contractWorld = buildContractWorld(repoRoot, registry);
  const surfaces = registryContracts(registry).map((entry) => {
    const surface = contractPolicySurface(entry);
    return {
      surface: surface.surface,
      id: surface.id,
      recipe: {
        path: surface.source,
        generator: 'kungfu sdk contract render',
        evidence: 'kungfu sdk contract evidence',
      },
      source: {
        path: surface.source,
        sha256: surface.sourceHash,
        renderedSha256: surface.renderedHash,
        byteForByte: surface.byteForByte,
      },
      artifact: {
        path: surface.artifact,
        expectedSha256: surface.sourceHash,
      },
    };
  });
  return {
    schema: CANONICAL_POLICY_SCHEMA,
    id: 'kungfu-agent-first-canonical-policy',
    description:
      'Agent-readable policy for deriving Kungfu KFD-1 contract-world evidence from one registry and upstream KFD/Buildchain metadata.',
    upstream: {
      kfd: {
        package: metadata.package,
        standard: {
          key: metadata.key,
          id: metadata.id,
          label: metadata.label,
          title: metadata.title,
          revision: metadata.revision,
          status: metadata.status,
        },
        schemaIds: metadata.schemaIds,
        schemaPaths: metadata.schemaPaths,
      },
      buildchain: {
        package: packageIdentity('@kungfu-tech/buildchain'),
        formatting: BUILDCHAIN_JSON_FORMATTING_POLICY,
        releaseGate: {
          witnessInput: '--kfd-1-witness-json',
          passportKey: metadata.key,
        },
      },
    },
    sourceOfTruth: {
      registry: rel(repoRoot, registryPath),
      registrySchema: registry.schema,
      policySource: policyPaths.source,
      policyArtifact: policyPaths.artifact,
    },
    generation: {
      renderer: 'kungfu sdk contract render <surface> --check --json',
      witness: 'kungfu sdk contract witness --json',
      audit: 'kungfu sdk contract audit --json',
      artifactRule:
        'Each registered source contract is copied byte-for-byte to its declared frozen config artifact.',
    },
    contractWorld: {
      schemaId: metadata.schemaIds.contractWorld,
      digest: `sha256:${sha256KfdJson(contractWorld)}`,
      value: contractWorld,
    },
    surfaces,
  };
}

/**
 * @param {string} repoRoot
 * @returns {Record<string, unknown>}
 */
function buildContractWorldWitness(repoRoot) {
  const registryPath = resolveContractRegistryPath(repoRoot);
  const registry = loadContractRegistry(registryPath);
  const metadata = resolveKfd1Metadata();
  const constants = kfd1SchemaConstants(metadata);
  const policyPaths = canonicalPolicyPaths(repoRoot);
  const policyPath = path.resolve(repoRoot, policyPaths.source);
  const contractWorld = buildContractWorld(repoRoot, registry);
  const policy = buildCanonicalPolicy(repoRoot);
  return normalizeKfd1ContractWorldWitness(
    {
      schemaVersion: 1,
      contract: constants.witness,
      id: 'kungfu-contracts',
      standard: metadata.key,
      source: {
        repo: 'kungfu-systems/kungfu',
        registry: rel(repoRoot, registryPath),
        policy: policyPaths.source,
      },
      contractWorld: {
        schemaId: metadata.schemaIds.contractWorld,
        digest: `sha256:${sha256KfdJson(contractWorld)}`,
      },
      canonicalPolicy: {
        path: policyPaths.source,
        sha256: fs.existsSync(policyPath)
          ? sha256File(policyPath)
          : `sha256:${createHash('sha256').update(renderJson(policy)).digest('hex')}`,
      },
      registry: {
        path: rel(repoRoot, registryPath),
        sha256: sha256File(registryPath),
      },
      surfaces: registryContracts(registry).map((entry) => {
        const surface = contractPolicySurface(entry);
        return {
          name: surface.id,
          sourcePath: surface.source,
          sourceSha256: surface.sourceHash,
          artifactPath: surface.artifact,
          expectedSha256: surface.sourceHash,
          byteForByte: surface.byteForByte,
        };
      }),
    },
    { metadata },
  );
}

/**
 * @param {Record<string, unknown>} data
 * @param {CliOptions} options
 * @param {string[]} lines
 * @returns {void}
 */
function printContractCommand(data, options, lines) {
  if (options.json) {
    process.stdout.write(renderJson(data));
    return;
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * @param {CliOptions} options
 * @returns {void}
 */
function contractPolicy(options) {
  const repoRoot = locateRepoRoot(process.cwd());
  const policyPaths = canonicalPolicyPaths(repoRoot);
  const policyPath = path.resolve(repoRoot, policyPaths.source);
  const policy = buildCanonicalPolicy(repoRoot);
  const rendered = renderJson(policy);
  if (options.check && options.write) {
    fail('contract policy accepts either --check or --write, not both');
  }
  if (options.write) {
    const previousHash = fs.existsSync(policyPath)
      ? sha256File(policyPath)
      : '';
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(policyPath, rendered);
    printContractCommand(
      {
        schema: 'kungfu.sdk.contract-policy-write/v1',
        ok: true,
        source: policyPaths.source,
        previousHash,
        hash: sha256File(policyPath),
        changed: !previousHash || previousHash !== sha256File(policyPath),
      },
      options,
      [
        `[contract] policy wrote ${policyPaths.source}`,
        `  hash: ${sha256File(policyPath)}`,
      ],
    );
    return;
  }
  if (options.check) {
    const existing = fs.existsSync(policyPath)
      ? fs.readFileSync(policyPath, 'utf8')
      : '';
    const data = {
      schema: 'kungfu.sdk.contract-policy-check/v1',
      ok: existing === rendered,
      status: existing === rendered ? 'current' : 'mismatched',
      source: policyPaths.source,
      hash: fs.existsSync(policyPath) ? sha256File(policyPath) : '',
      renderedHash: `sha256:${createHash('sha256').update(rendered).digest('hex')}`,
    };
    printContractCommand(data, options, [
      `[contract] policy ${data.status}`,
      `  source: ${data.source}`,
    ]);
    if (!data.ok) process.exit(1);
    return;
  }
  if (options.json) process.stdout.write(rendered);
  else
    process.stdout.write(
      `[contract] policy ${policyPaths.source} (${registryContracts({ contracts: policy.surfaces }).length} surfaces)\n`,
    );
}

/**
 * @param {CliOptions} options
 * @returns {void}
 */
function contractWitness(options) {
  const repoRoot = locateRepoRoot(process.cwd());
  const witness = buildContractWorldWitness(repoRoot);
  if (options.json) {
    process.stdout.write(renderJson(witness));
    return;
  }
  process.stdout.write(
    `[contract] witness ${witness.id} surfaces=${Array.isArray(witness.surfaces) ? witness.surfaces.length : 0}\n`,
  );
}

/**
 * @param {CliOptions} options
 * @returns {void}
 */
function contractAudit(options) {
  const repoRoot = locateRepoRoot(process.cwd());
  const policyPaths = canonicalPolicyPaths(repoRoot);
  const policyPath = path.resolve(repoRoot, policyPaths.source);
  const policy = buildCanonicalPolicy(repoRoot);
  const renderedPolicy = renderJson(policy);
  const existingPolicy = fs.existsSync(policyPath)
    ? fs.readFileSync(policyPath, 'utf8')
    : '';
  const witness = buildContractWorldWitness(repoRoot);
  const metadata = resolveKfd1Metadata();
  const gate = createKfd1ReleaseGateEvidence({
    cwd: repoRoot,
    artifacts: Array.isArray(witness.surfaces)
      ? witness.surfaces.map((surface) => ({
          name: surface.artifactPath,
          sourcePath: path.resolve(repoRoot, surface.sourcePath),
        }))
      : [],
    witnesses: [witness],
    verifiedAt: '1970-01-01T00:00:00.000Z',
    metadata,
  });
  const gateIssues = validateKfd1ReleaseGateEvidence(gate?.passportSection, {
    metadata,
  });
  const contractRows = /** @type {Array<Record<string, unknown>>} */ (
    policy.surfaces
  ).map((surface) => ({
    surface: surface.surface,
    status:
      isObject(surface.source) && surface.source.byteForByte === true
        ? 'current'
        : 'mismatched',
    source: isObject(surface.source) ? surface.source.path : '',
    artifact: isObject(surface.artifact) ? surface.artifact.path : '',
    sourceHash: isObject(surface.source) ? surface.source.sha256 : '',
    artifactExpectedHash: isObject(surface.artifact)
      ? surface.artifact.expectedSha256
      : '',
  }));
  const failures = [
    ...(existingPolicy === renderedPolicy
      ? []
      : [
          {
            code: 'canonical-policy.mismatched',
            message:
              'framework/contract canonical policy file differs from SDK-rendered policy',
          },
        ]),
    ...contractRows
      .filter((row) => row.status !== 'current')
      .map((row) => ({
        code: 'contract.render.mismatched',
        message: `${row.surface} source is not byte-for-byte canonical`,
      })),
    .../** @type {Array<{ code: string, message: string }>} */ (gateIssues).map(
      (issue) => ({
        code: issue.code,
        message: issue.message,
      }),
    ),
  ];
  const data = {
    schema: 'kungfu.sdk.contract-audit/v1',
    ok: failures.length === 0,
    status: failures.length === 0 ? 'current' : 'mismatched',
    upstream: policy.upstream,
    policy: {
      source: policyPaths.source,
      artifact: policyPaths.artifact,
      status: existingPolicy === renderedPolicy ? 'current' : 'mismatched',
      hash: fs.existsSync(policyPath) ? sha256File(policyPath) : '',
      renderedHash: `sha256:${createHash('sha256').update(renderedPolicy).digest('hex')}`,
    },
    witness: {
      id: witness.id,
      standard: witness.standard,
      contractWorldDigest: isObject(witness.contractWorld)
        ? witness.contractWorld.digest
        : '',
      digest: `sha256:${sha256KfdJson(witness)}`,
    },
    releaseGate: gate?.passportSection || null,
    contracts: contractRows,
    failures,
  };
  printContractCommand(data, options, [
    `[contract] audit ${data.status}`,
    `  policy: ${data.policy.source}`,
    `  contracts: ${data.contracts.length}`,
  ]);
  if (!data.ok) process.exit(1);
}

/**
 * @param {string} surface
 * @param {string} source
 * @param {string} registry
 * @param {Record<string, unknown>} contract
 * @param {string} sourceHash
 * @returns {Record<string, unknown>}
 */
function contractFixture(surface, source, registry, contract, sourceHash) {
  return {
    schema: CONTRACT_FIXTURE_SCHEMA,
    surface,
    source,
    registry,
    expected: {
      id: contract.id,
      schema: contract.schema,
      version: contract.version,
      weldedSurface: contract.weldedSurface,
      sourceHash,
      renderedHash: `sha256:${createHash('sha256').update(renderJson(contract)).digest('hex')}`,
    },
    probe: {
      evidence: `kungfu sdk contract evidence ${surface} --json`,
      renderCheck: `kungfu sdk contract render ${surface} --check --json`,
      runtimeVerify: 'kungfu contract verify --json',
    },
    drift: {
      updateRule:
        'Intentional contract edits must update this fixture with the new source hash.',
      failureSignal:
        'A release gate can compare this fixture against contract evidence before claiming KFD-1 compatibility.',
    },
  };
}

/**
 * @param {string | undefined} surfaceArg
 * @param {CliOptions} options
 * @returns {void}
 */
function contractAdd(surfaceArg, options) {
  if (!surfaceArg) usage(1);
  const surface = normalizeSurface(surfaceArg);
  const repoRoot = locateRepoRoot(process.cwd());
  const registryPath = resolveContractRegistryPath(repoRoot);
  const registry = loadContractRegistry(registryPath);
  if (hasContractEntry(registry, surface)) {
    fail(`contract surface is already registered: ${surface}`);
  }
  const source = options.source
    ? repoRelativePath(repoRoot, options.source)
    : `framework/contract/${surface}.contract.json`;
  const contractPath = path.resolve(repoRoot, source);
  if (fs.existsSync(contractPath)) {
    fail(`contract source already exists: ${source}`);
  }
  const contract = contractTemplate(surface);
  const entry = registryEntryTemplate(surface, source);
  registryContracts(registry).push(entry);
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, renderJson(contract));
  const fixturePath = path.resolve(
    repoRoot,
    requiredString(entry, 'probeFixture'),
  );
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(
    fixturePath,
    renderJson(
      contractFixture(
        surface,
        source,
        rel(repoRoot, registryPath),
        contract,
        sha256File(contractPath),
      ),
    ),
  );
  fs.writeFileSync(registryPath, renderJson(registry));
  const data = {
    schema: 'kungfu.sdk.contract-add/v1',
    ok: true,
    surface,
    registry: rel(repoRoot, registryPath),
    source,
    artifact: entry.artifact,
    env: entry.env,
    contract: {
      id: contract.id,
      schema: contract.schema,
      version: contract.version,
      weldedSurface: contract.weldedSurface,
      hash: sha256File(contractPath),
    },
    fixture: {
      path: rel(repoRoot, fixturePath),
      schema: CONTRACT_FIXTURE_SCHEMA,
      hash: sha256File(fixturePath),
    },
    next: {
      verify: `kungfu sdk contract adopt ${surface} --source ${source} --json`,
      renderCheck: `kungfu sdk contract render ${surface} --check --json`,
      evidence: `kungfu sdk contract evidence ${surface} --json`,
      versioning: `register welded surface ${surface}-contract in docs/versioning.md`,
      knownLimits: `record maturity and limits for ${surface}-contract in docs/known-limits.md`,
    },
  };
  if (options.json) {
    process.stdout.write(renderJson(data));
    return;
  }
  process.stdout.write(
    [
      `[contract] added ${surface}`,
      `  source: ${data.source}`,
      `  registry: ${data.registry}`,
      `  check: ${data.next.renderCheck}`,
      '',
    ].join('\n'),
  );
}

// ── kfx view extension build ──────────────────────────────────────────────
// Modules that stay external and are injected by the shell at load time; a
// view extension must never ship its own copy of these.
const KFX_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@kungfu-tech/api',
  '@kungfu-tech/api/capability',
];

/**
 * The subset of a kfx package.json this driver reads.
 * @typedef {object} Manifest
 * @property {string} [name]
 * @property {{
 *   key?: string,
 *   config?: {
 *     view?: { entry?: string },
 *     adapter?: unknown,
 *   },
 * }} [kungfuConfig]
 * @property {{ python?: unknown }} [kungfuBuild]
 */

/**
 * Read and parse the package.json in the current working directory.
 * @returns {Manifest}
 */
function readManifest() {
  const manifestPath = path.resolve('package.json');
  if (!fs.existsSync(manifestPath))
    fail('no package.json in current directory');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  validateKfxManifest(manifest);
  return manifest;
}

/**
 * @param {string} start
 * @returns {string[]}
 */
function ancestorDirs(start) {
  const dirs = [];
  let current = path.resolve(start);
  for (let i = 0; i < 12; i += 1) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

function resolveKfxContractPath() {
  const explicit = process.env[KFX_CONTRACT_ENV];
  if (explicit) return path.resolve(explicit);
  for (const dir of ancestorDirs(process.cwd())) {
    for (const rel of [
      path.join('framework', 'kfx', KFX_CONTRACT_FILE),
      path.join('kfx', KFX_CONTRACT_FILE),
      path.join('config', KFX_CONTRACT_FILE),
      path.join('node_modules', '@kungfu-tech', 'kfx', KFX_CONTRACT_FILE),
    ]) {
      const candidate = path.join(dir, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`Kungfu kfx contract not found: ${KFX_CONTRACT_FILE}`);
}

function loadKfxContract() {
  const contractPath = resolveKfxContractPath();
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new Error(
      `Kungfu kfx contract must be a JSON object: ${contractPath}`,
    );
  }
  if (contract.schema !== 'kungfu.kfx.contract/v1') {
    throw new Error(
      `Kungfu kfx contract schema mismatch: ${String(contract.schema)}`,
    );
  }
  validateWithSchema(contract, contract.contractSchema, 'KFX contract');
  return contract;
}

/**
 * @param {unknown} value
 * @param {unknown} schema
 * @param {string} label
 * @returns {void}
 */
function validateWithSchema(value, schema, label) {
  const Ajv2020 = require('ajv/dist/2020.js');
  const AjvCtor =
    /** @type {new (options: { allErrors: boolean, strict: boolean }) => { compile: (schema: unknown) => { (value: unknown): boolean, errors?: Array<{ instancePath?: string, message?: string }> } }} */ (
      /** @type {unknown} */ (Ajv2020)
    );
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (validate(value)) return;
  const first = validate.errors?.[0];
  const p = first?.instancePath || '<root>';
  throw new Error(
    `${label} validation failed at ${p}: ${first?.message || 'invalid document'}`,
  );
}

/**
 * @param {unknown} manifest
 * @returns {void}
 */
function validateKfxManifest(manifest) {
  const contract = loadKfxContract();
  validateWithSchema(
    manifest,
    contract.packageManifestSchema,
    'KFX package manifest',
  );
}

// ── kfx C++ extension build ────────────────────────────────────────────────
// A C++ kfx compiles src/cpp/*.cpp against the libkungfu API (headers + the
// built shared library) and its FlatBuffers data structures into a native
// pybind11 module. The extension's CMakeLists.txt includes a libkungfu-only
// helper (cmake/kungfu.cmake); this driver invokes CMake with the core's conan
// toolchain and pins the module to the core's Python so it loads in kfc.

/**
 * Walk up from startDir looking for the monorepo's framework/core.
 * @param {string} startDir
 * @returns {string | null} the core directory, or null if not found
 */
function locateCoreDir(startDir) {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'framework', 'core');
    if (fs.existsSync(path.join(candidate, 'conanfile.py'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Run a child process synchronously, aborting the CLI if it fails.
 * @param {string} cmd
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptions} [opts]
 * @returns {void}
 */
function runOrFail(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.error) fail(`${cmd} not runnable: ${result.error.message}`);
  if (result.status !== 0) {
    fail(
      `${cmd} ${args.join(' ')} failed (exit ${result.status ?? `signal ${result.signal}`})`,
    );
  }
}

/**
 * Configure and build a C++ kfx into a native pybind11 module.
 * @param {Manifest} manifest
 * @returns {void}
 */
function cppBuild(manifest) {
  const coreDir = locateCoreDir(process.cwd());
  if (!coreDir)
    fail(
      'cannot locate framework/core (a cpp kfx build needs the monorepo core)',
    );
  const toolchain = path.join(coreDir, 'build', 'conan_toolchain.cmake');
  if (!fs.existsSync(toolchain)) {
    fail(
      `core not built: ${toolchain} is missing. Run \`./kungfu-code rebuild:core\` first.`,
    );
  }
  const buildDir = path.resolve('build');
  const distDir = path.resolve('dist', manifest.kungfuConfig?.key ?? 'cpp');
  fs.mkdirSync(distDir, { recursive: true });
  const configureArgs = [
    '-S',
    '.',
    '-B',
    buildDir,
    `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_LIBRARY_OUTPUT_DIRECTORY=${distDir}`,
  ];
  // Pin the module to the core's Python (the uv-managed venv) so it is ABI-
  // compatible with the runtime and loads alongside pykungfu. Pass both the
  // classic (FindPythonInterp) and modern (FindPython) hint variables so the
  // pin holds regardless of which pybind11 lookup mode is active.
  const corePython = path.join(coreDir, '.venv', 'bin', 'python3');
  if (fs.existsSync(corePython)) {
    configureArgs.push(
      `-DPYTHON_EXECUTABLE=${corePython}`,
      `-DPython_EXECUTABLE=${corePython}`,
    );
  }
  runOrFail('cmake', configureArgs);
  runOrFail('cmake', ['--build', buildDir, '--config', 'Release']);
  process.stdout.write(
    `built ${manifest.name ?? 'cpp extension'} -> ${path.relative(process.cwd(), distDir)}\n`,
  );
}

// ── kfx Python AOT extension build ─────────────────────────────────────────
// A Python extension (kungfuBuild.python) installs its declared dependencies
// through the bundled toolchain (`kungfu engage pdm install`) and is then
// ahead-of-time compiled into a native module (`kungfu engage nuitka
// --module`) — exercising the same python development lifecycle kfc ships.

/**
 * Install deps and AOT-compile a Python kfx into a native module.
 * @param {Manifest} manifest
 * @returns {void}
 */
function pythonAotBuild(manifest) {
  const coreDir = locateCoreDir(process.cwd());
  if (!coreDir)
    fail(
      'cannot locate framework/core (a python-AOT kfx build needs the monorepo core)',
    );
  const py = path.join(coreDir, '.venv', 'bin', 'python3');
  if (!fs.existsSync(py)) {
    fail(
      `core Python not found: ${py}. Run \`./kungfu-code rebuild:core\` first.`,
    );
  }
  const pkgRoot = path.resolve('src', 'python');
  const pkg = fs.existsSync(pkgRoot)
    ? fs
        .readdirSync(pkgRoot)
        .find((d) => fs.statSync(path.join(pkgRoot, d)).isDirectory())
    : null;
  if (!pkg)
    fail('no src/python/<Package>/ directory for a python-AOT extension');
  const distDir = path.resolve('dist', manifest.kungfuConfig?.key ?? 'python');
  fs.mkdirSync(distDir, { recursive: true });
  // The dev CLI resolves the `kungfu` package from src/python and its native
  // binding from build/Release; make both importable for `python -m kungfu`.
  const env = {
    ...process.env,
    PYTHONPATH: [
      path.join(coreDir, 'src', 'python'),
      path.join(coreDir, 'build', 'Release'),
      process.env.PYTHONPATH,
    ]
      .filter(Boolean)
      .join(path.delimiter),
  };
  // Install the extension's declared dependencies through the bundled pdm.
  runOrFail(py, ['-m', 'kungfu', 'engage', 'pdm', 'install'], { env });
  // AOT-compile just this module: declared deps stay runtime imports, so we do
  // not --follow-imports (we compile the extension, not its dependency tree).
  runOrFail(
    py,
    [
      '-m',
      'kungfu',
      'engage',
      'nuitka',
      '--module',
      `--output-dir=${distDir}`,
      path.join('src', 'python', pkg),
    ],
    { env },
  );
  process.stdout.write(
    `built ${manifest.name ?? 'python extension'} -> ${path.relative(process.cwd(), distDir)}\n`,
  );
}

/**
 * Dispatch `kungfu sdk kfx build` to the right builder for the current package.
 * @returns {Promise<void>}
 */
async function kfxBuild() {
  const manifest = readManifest();
  const config = manifest.kungfuConfig?.config ?? {};
  const view = config.view;
  if (!view) {
    // A C++ extension compiles native code against libkungfu into a pybind11
    // module. It is detected by a CMakeLists.txt at the package root.
    if (fs.existsSync(path.resolve('CMakeLists.txt'))) {
      cppBuild(manifest);
      return;
    }
    // A Python AOT extension declares its dependencies under kungfuBuild.python;
    // the sdk installs them (engage pdm) and compiles src/python (engage nuitka).
    if (manifest.kungfuBuild?.python) {
      pythonAotBuild(manifest);
      return;
    }
    // An adapter facet is a runtime extension: it ships source per child
    // runtime (python/node) and the capture supervisor injects it — there is
    // nothing to bundle. Succeed so `kungfu sdk kfx build` is usable on any kfx.
    if (config.adapter) {
      process.stdout.write(
        `${manifest.name ?? 'adapter extension'}: adapter facet ships source (no bundle step)\n`,
      );
      return;
    }
    fail(
      'package.json has no view/adapter facet, no CMakeLists.txt (cpp), and no kungfuBuild.python (python-AOT)',
    );
  }
  const entry = ['src/view/index.tsx', 'src/view/index.ts'].find((candidate) =>
    fs.existsSync(path.resolve(candidate)),
  );
  if (!entry) fail('no src/view/index.tsx (or .ts) entry');
  const outfile = path.resolve(view.entry || 'dist/view/index.js');
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [path.resolve(entry)],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    jsx: 'automatic',
    external: KFX_EXTERNALS,
    sourcemap: false,
    logLevel: 'warning',
  });
  process.stdout.write(
    `built ${manifest.name ?? 'view extension'} -> ${path.relative(process.cwd(), outfile)}\n`,
  );
}

/**
 * Remove the dist/ and build/ trees produced by `kungfu sdk kfx build`.
 * @returns {void}
 */
function kfxClean() {
  readManifest();
  fs.rmSync(path.resolve('dist'), { recursive: true, force: true });
  // A cpp extension also has a CMake build tree.
  fs.rmSync(path.resolve('build'), { recursive: true, force: true });
  process.stdout.write('cleaned dist\n');
}

/**
 * @param {string} start
 * @param {string} relativePath
 * @returns {string}
 */
function findUp(start, relativePath) {
  let directory = path.resolve(start);
  if (fs.existsSync(directory) && !fs.statSync(directory).isDirectory()) {
    directory = path.dirname(directory);
  }
  while (true) {
    const candidate = path.join(directory, relativePath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return '';
    directory = parent;
  }
}

/**
 * @returns {string}
 */
function resolveKfd3Registry() {
  const override = process.env.KUNGFU_KFD3_REGISTRY || '';
  const candidates = [
    override,
    path.join(process.cwd(), BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH),
    findUp(process.cwd(), BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH),
    findUp(SDK_CLI, BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH),
    SDK_KFD3_CANONICAL_REGISTRY,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  fail(
    'KFD-3 registry not found; run inside a Kungfu checkout or install a SDK package that includes kfd/kfd-3-surfaces.json',
  );
}

/**
 * @param {string} registryPath
 * @returns {{cwd: string, registryPath: string}}
 */
function kfd3RegistryQueryContext(registryPath) {
  const canonicalSuffix = `${path.sep}${BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH.replace(/\//g, path.sep)}`;
  if (registryPath.endsWith(canonicalSuffix)) {
    return {
      cwd: registryPath.slice(0, -canonicalSuffix.length),
      registryPath: BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH,
    };
  }
  return {
    cwd: path.dirname(registryPath),
    registryPath: path.basename(registryPath),
  };
}

/**
 * @returns {string}
 */
function resolveKfdUpstreamAggregate() {
  const override = process.env.KUNGFU_KFD_UPSTREAM_AGGREGATE || '';
  const candidates = [
    override,
    path.join(
      process.cwd(),
      'developer',
      'sdk',
      'kfd',
      'upstream-aggregate.json',
    ),
    findUp(
      process.cwd(),
      path.join('developer', 'sdk', 'kfd', 'upstream-aggregate.json'),
    ),
    SDK_KFD_UPSTREAM_AGGREGATE,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  fail(
    'KFD upstream aggregate not found; run ./kungfu-code kfd:buildchain or install a SDK package that includes kfd/upstream-aggregate.json',
  );
}

/**
 * @returns {{ path: string, registry: Record<string, any> }}
 */
function readKfd3Registry() {
  const registryPath = resolveKfd3Registry();
  return {
    path: registryPath,
    registry: JSON.parse(fs.readFileSync(registryPath, 'utf8')),
  };
}

/**
 * @returns {{ path: string, aggregate: Record<string, any> }}
 */
function readKfdUpstreamAggregate() {
  const aggregatePath = resolveKfdUpstreamAggregate();
  return {
    path: aggregatePath,
    aggregate: JSON.parse(fs.readFileSync(aggregatePath, 'utf8')),
  };
}

/**
 * @param {string} packageName
 * @returns {string}
 */
function packageVersion(packageName) {
  try {
    return String(require(`${packageName}/package.json`).version || '');
  } catch {
    return '';
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeKfdStandard(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  const match = raw.match(/^(?:kfd[-\s]?)?([1-9][0-9]*)$/);
  if (!match) fail(`unsupported KFD standard: ${value || '<empty>'}`);
  return `kfd-${match[1]}`;
}

/**
 * @param {string} standard
 * @param {string} [schemaName]
 * @returns {Record<string, any>}
 */
function readKfdSchemaDocument(standard, schemaName = '') {
  return kfdSchemas.read({
    standard: normalizeKfdStandard(standard),
    schema: schemaName,
  });
}

/**
 * @returns {Record<string, any>}
 */
function kfdSchemaSummary() {
  const schemaList = kfdSchemas.list();
  /** @type {Record<string, Array<{ name: string, schemaId: string, schemaPath: string }>>} */
  const byStandard = {};
  for (const entry of schemaList.schemas || []) {
    byStandard[entry.standard] ||= [];
    byStandard[entry.standard].push({
      name: entry.name,
      schemaId: entry.schemaId,
      schemaPath: entry.schemaPath,
    });
  }
  return {
    package: schemaList.package,
    standards: byStandard,
  };
}

/**
 * @param {Record<string, any>} registry
 * @param {string} registryPath
 * @param {Record<string, any>} aggregate
 * @returns {Record<string, any>}
 */
function buildKfdStandardsStatus(registry, registryPath, aggregate) {
  const ownKfd = aggregate.ownKfd || {};
  const schemas = kfdSchemaSummary();
  return {
    schemaVersion: 1,
    contract: 'kungfu-sdk-kfd-standards-status',
    product: registry.product || { id: 'kungfu', name: 'Kungfu' },
    packages: {
      kfd: packageVersion('@kungfu-tech/kfd'),
      buildchain: packageVersion('@kungfu-tech/buildchain'),
    },
    source: {
      registry: {
        path: path.relative(process.cwd(), registryPath) || '.',
        sha256: sha256File(registryPath),
      },
      upstreamAggregate: {
        path:
          path.relative(process.cwd(), resolveKfdUpstreamAggregate()) || '.',
        sha256: sha256File(resolveKfdUpstreamAggregate()),
      },
    },
    standards: {
      'kfd-1': {
        status: 'supported',
        mode: 'contract-world',
        commands: [
          'kungfu sdk contract witness --json',
          'kungfu sdk contract audit --json',
          'kungfu sdk kfd 1 witness --json',
        ],
        schemaCount: schemas.standards['kfd-1']?.length || 0,
        source: ownKfd.kfd1 || {
          note: 'KFD-1 facts are provided by the SDK contract registry and packaged KFD-3 surface registry.',
        },
      },
      'kfd-2': {
        status: 'supported',
        mode: 'release-claims',
        commands: [
          'kungfu sdk kfd 2 claims --json',
          'kungfu sdk kfd 2 trust-claims --json',
          'kungfu sdk kfd 2 trust-assessment --json',
        ],
        schemaCount: schemas.standards['kfd-2']?.length || 0,
        source: ownKfd.kfd2 || {
          note: 'KFD-2 release trust is finalized by the Buildchain release passport.',
        },
      },
      'kfd-3': {
        status: 'supported',
        mode: registry.buildchain?.kfd3?.mode || 'declared-registry',
        commands: [
          'kungfu sdk kfd query --json',
          'kungfu sdk kfd check --json',
          'kungfu sdk kfd witness --json',
        ],
        schemaCount: schemas.standards['kfd-3']?.length || 0,
        surfaceCount: Array.isArray(registry.surfaces)
          ? registry.surfaces.length
          : 0,
        source: {
          registryPath:
            registry.registryPath || BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH,
          sourceOfTruth: registry.policy?.sourceOfTruth || '',
        },
      },
      'kfd-4': {
        status: kfd4.status || 'schema-only',
        mode: 'schema-only',
        commands: [
          'kungfu sdk kfd 4 schema --json',
          'kungfu sdk kfd schema kfd-4 --json',
        ],
        schemaCount: schemas.standards['kfd-4']?.length || 0,
        source: ownKfd.kfd4 || {
          note: 'Buildchain 2.10.8 exposes KFD-4 as schema-only; Kungfu declares schema visibility, not a verification pass.',
        },
      },
    },
    support: {
      'kfd-1': ['status', 'schema', 'witness'],
      'kfd-2': [
        'status',
        'schema',
        'claims',
        'trust-claims',
        'trust-assessment',
      ],
      'kfd-3': ['query', 'check', 'witness', 'aggregate'],
      'kfd-4': ['status', 'schema'],
    },
    buildchainStatus: collectKfdStatus({ cwd: process.cwd() }),
  };
}

/**
 * @param {Record<string, any>} registry
 * @param {string} registryPath
 * @param {Record<string, any>} aggregate
 * @returns {Record<string, any>}
 */
function kfd1SupportWitness(registry, registryPath, aggregate) {
  return {
    schemaVersion: 1,
    contract: 'kungfu-sdk-kfd-1-support-witness',
    standard: 'kfd-1',
    witnessKind: 'installed-sdk-contract-world-summary',
    metadata: kfd1.resolveMetadata(),
    product: registry.product || { id: 'kungfu', name: 'Kungfu' },
    sourceRegistry: {
      path: path.relative(process.cwd(), registryPath) || '.',
      sha256: sha256File(registryPath),
    },
    contractWorld: aggregate.ownKfd?.kfd1 || null,
    surfaces: (registry.surfaces || []).map(
      (/** @type {Record<string, any>} */ surface) => ({
        id: surface.id,
        kind: surface.kind,
        sourcePath: surface.sourcePath,
        artifactPath: surface.artifactPath || surface.evidencePath,
        digest: `sha256:${sha256KfdJson(surface)}`,
      }),
    ),
    releaseGate: {
      passportInput: '--kfd-1-witness-json',
      finalTrust: 'query-buildchain-release-passport',
    },
  };
}

/**
 * @param {Record<string, any>} aggregate
 * @returns {Record<string, any>}
 */
function kfd2ClaimSummary(aggregate) {
  return {
    schemaVersion: 1,
    contract: 'kungfu-sdk-kfd-2-release-claims',
    standard: 'kfd-2',
    metadata: kfd2.resolveMetadata(),
    product: aggregate.product || {
      id: 'kungfu',
      name: 'Kungfu',
      repository: 'kungfu-systems/kungfu',
    },
    source: aggregate.ownKfd?.kfd2 || null,
    releaseGate: {
      passportInput: '--kfd-2-claim-json',
      finalTrust: 'query-buildchain-release-passport',
    },
    residualRisk: [
      'Installed SDK claim summaries are packaged facts; release trust depends on the Buildchain release passport for the exact artifact.',
    ],
  };
}

/**
 * @param {Record<string, any>} document
 * @param {string} source
 * @returns {Record<string, any>}
 */
function kfd2ValidationDocument(document, source) {
  const validation =
    document?.contract === 'kfd-2-trust-claims'
      ? kfd2.validateTrustClaims(document)
      : kfd2.validateTrustAssessment(document);
  return {
    schemaVersion: 1,
    contract:
      document?.contract === 'kfd-2-trust-claims'
        ? 'kungfu-sdk-kfd-2-trust-claims'
        : 'kungfu-sdk-kfd-2-trust-assessment',
    source,
    document,
    validation,
  };
}

/**
 * @param {Record<string, any>} registry
 * @param {string} registryPath
 * @param {string} [warning]
 * @returns {Record<string, any>}
 */
function registryCapabilityQuery(registry, registryPath, warning = '') {
  return {
    schemaVersion: 1,
    contract: 'kungfu-buildchain-kfd-3-capability-query',
    product: registry.product?.name || 'Kungfu',
    source: {
      type: 'kungfu-sdk-kfd3-registry',
      path: path.relative(process.cwd(), registryPath) || '.',
      note: 'Kungfu SDK projects product KFD-3 surfaces into Buildchain-compatible capability facts.',
    },
    status: 'declared',
    warning,
    capabilities: (registry.surfaces || []).map(
      (/** @type {Record<string, any>} */ surface) => ({
        id: surface.id,
        kind: surface.kind,
        name: surface.name,
        state: surface.state || surface.availability || 'declared',
        detected: true,
        enforced:
          surface.state === 'enforced' || surface.enforcement === 'enforced',
        sourcePath: surface.sourcePath,
        artifactPath: surface.artifactPath || surface.evidencePath,
        kfd1Basis: {
          registryPath: path.relative(process.cwd(), registryPath) || '.',
          sourcePath: surface.sourcePath,
          artifactPath: surface.artifactPath || surface.evidencePath,
          digest: `sha256:${sha256KfdJson(surface)}`,
        },
        kfd2Trust: {
          status: 'release-passport-required',
          trustImpact: 'query-release-passport-for-final-trust',
          residualRisk: [],
        },
        residualRisk: [],
      }),
    ),
    kfd: {
      kfd1: 'registry-facts',
      kfd2: 'release-passport-required',
      kfd3: 'declared',
      kfd4: 'schema-only',
    },
  };
}

/**
 * @param {CliOptions} options
 * @returns {Promise<Record<string, any>>}
 */
async function kfdQuery(options) {
  const { path: registryPath, registry } = readKfd3Registry();
  try {
    const queryContext = kfd3RegistryQueryContext(registryPath);
    const query = await queryKfd3Capabilities({
      cwd: queryContext.cwd,
      product: registry.product?.id || 'kungfu',
      registryPath: queryContext.registryPath,
    });
    if (query.status !== 'failed' && query.kfd?.kfd3 !== 'failed') {
      return query;
    }
    return registryCapabilityQuery(
      registry,
      registryPath,
      'Buildchain standard detector could not cover Kungfu custom declared surfaces; using Kungfu SDK registry projection.',
    );
  } catch (error) {
    return registryCapabilityQuery(registry, registryPath, errorMessage(error));
  }
}

/**
 * @param {CliOptions} options
 * @returns {Promise<Record<string, any>>}
 */
async function kfdAggregate(options) {
  const { path: registryPath, registry } = readKfd3Registry();
  const { path: aggregatePath, aggregate } = readKfdUpstreamAggregate();
  const query = await kfdQuery(options);
  return {
    schemaVersion: 1,
    contract: 'kungfu-sdk-kfd-aggregate',
    product: registry.product || { id: 'kungfu', name: 'Kungfu' },
    source: {
      registry: {
        path: path.relative(process.cwd(), registryPath) || '.',
        sha256: sha256File(registryPath),
      },
      upstreamAggregate: {
        path: path.relative(process.cwd(), aggregatePath) || '.',
        sha256: sha256File(aggregatePath),
      },
    },
    own: {
      query,
      surfaceCount: Array.isArray(registry.surfaces)
        ? registry.surfaces.length
        : 0,
    },
    upstream: aggregate,
    kfd: {
      kfd1: 'registry-and-upstream-facts',
      kfd2: 'release-passport-required',
      kfd3: 'declared-and-aggregated',
      kfd4: 'schema-only',
    },
  };
}

/**
 * @param {string | undefined} command
 * @param {string[]} args
 * @param {CliOptions} options
 * @returns {Promise<void>}
 */
async function kfd(command, args, options) {
  const { path: registryPath, registry } = readKfd3Registry();
  if (command === 'status') {
    const { aggregate } = readKfdUpstreamAggregate();
    const status = buildKfdStandardsStatus(registry, registryPath, aggregate);
    if (options.json)
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    else
      process.stdout.write(
        `Kungfu KFD: kfd-1=${status.standards['kfd-1'].status}, kfd-2=${status.standards['kfd-2'].status}, kfd-3=${status.standards['kfd-3'].status}, kfd-4=${status.standards['kfd-4'].status}\n`,
      );
    return;
  }
  if (command === 'schema') {
    const standard = args[0] || '';
    if (!standard) fail('kfd schema requires <kfd-1|kfd-2|kfd-3|kfd-4>');
    const schema = readKfdSchemaDocument(standard, options.schema || args[1]);
    if (options.json)
      process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
    else process.stdout.write(`${JSON.stringify(schema.schema, null, 2)}\n`);
    return;
  }
  if (['1', 'kfd-1'].includes(String(command || '').toLowerCase())) {
    const action = args[0] || 'status';
    if (action === 'status') {
      const { aggregate } = readKfdUpstreamAggregate();
      const status = buildKfdStandardsStatus(registry, registryPath, aggregate)
        .standards['kfd-1'];
      if (options.json)
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      else process.stdout.write(`Kungfu KFD-1: ${status.status}\n`);
      return;
    }
    if (action === 'schema') {
      const schema = readKfdSchemaDocument('kfd-1', options.schema || args[1]);
      if (options.json)
        process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
      else process.stdout.write(`${JSON.stringify(schema.schema, null, 2)}\n`);
      return;
    }
    if (action === 'witness') {
      const { aggregate } = readKfdUpstreamAggregate();
      const witness = kfd1SupportWitness(registry, registryPath, aggregate);
      if (options.json)
        process.stdout.write(`${JSON.stringify(witness, null, 2)}\n`);
      else
        process.stdout.write(
          `Kungfu KFD-1 witness: ${witness.surfaces.length} surface(s)\n`,
        );
      return;
    }
    fail('unknown kfd 1 command (supported: status, schema, witness)');
  }
  if (['2', 'kfd-2'].includes(String(command || '').toLowerCase())) {
    const action = args[0] || 'status';
    if (action === 'status') {
      const { aggregate } = readKfdUpstreamAggregate();
      const status = buildKfdStandardsStatus(registry, registryPath, aggregate)
        .standards['kfd-2'];
      if (options.json)
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      else process.stdout.write(`Kungfu KFD-2: ${status.status}\n`);
      return;
    }
    if (action === 'schema') {
      const schema = readKfdSchemaDocument('kfd-2', options.schema || args[1]);
      if (options.json)
        process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
      else process.stdout.write(`${JSON.stringify(schema.schema, null, 2)}\n`);
      return;
    }
    if (action === 'claims') {
      const { aggregate } = readKfdUpstreamAggregate();
      const claims = kfd2ClaimSummary(aggregate);
      if (options.json)
        process.stdout.write(`${JSON.stringify(claims, null, 2)}\n`);
      else process.stdout.write('Kungfu KFD-2 claims: packaged\n');
      return;
    }
    if (action === 'trust-claims') {
      const result = kfd2ValidationDocument(
        kfd2.readFoundationTrustClaims(),
        '@kungfu-tech/kfd foundation trust claims',
      );
      if (options.json)
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else
        process.stdout.write(
          `Kungfu KFD-2 trust-claims: ${result.validation.ok ? 'ok' : 'failed'}\n`,
        );
      if (!result.validation.ok) process.exitCode = 1;
      return;
    }
    if (action === 'trust-assessment') {
      const result = kfd2ValidationDocument(
        kfd2.readFoundationTrustAssessment(),
        '@kungfu-tech/kfd foundation trust assessment',
      );
      if (options.json)
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else
        process.stdout.write(
          `Kungfu KFD-2 trust-assessment: ${result.validation.ok ? 'ok' : 'failed'}\n`,
        );
      if (!result.validation.ok) process.exitCode = 1;
      return;
    }
    fail(
      'unknown kfd 2 command (supported: status, schema, claims, trust-claims, trust-assessment)',
    );
  }
  if (['4', 'kfd-4'].includes(String(command || '').toLowerCase())) {
    const action = args[0] || 'status';
    if (action === 'status') {
      const { aggregate } = readKfdUpstreamAggregate();
      const status = buildKfdStandardsStatus(registry, registryPath, aggregate)
        .standards['kfd-4'];
      if (options.json)
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      else process.stdout.write(`Kungfu KFD-4: ${status.status}\n`);
      return;
    }
    if (action === 'schema') {
      const schema = readKfdSchemaDocument('kfd-4', options.schema || args[1]);
      if (options.json)
        process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
      else process.stdout.write(`${JSON.stringify(schema.schema, null, 2)}\n`);
      return;
    }
    fail('unknown kfd 4 command (supported: status, schema)');
  }
  if (command === 'query') {
    const query = await kfdQuery(options);
    if (options.json)
      process.stdout.write(`${JSON.stringify(query, null, 2)}\n`);
    else
      process.stdout.write(
        `Kungfu KFD-3 capabilities: ${query.capabilities?.length || 0} (${query.status || 'unknown'})\n`,
      );
    return;
  }
  if (command === 'check') {
    const query = await kfdQuery(options);
    const { path: aggregatePath, aggregate } = readKfdUpstreamAggregate();
    const output = {
      schema: 'kungfu.sdk.kfd-check/v1',
      ok: true,
      registry: {
        path: path.relative(process.cwd(), registryPath) || '.',
        sha256: sha256File(registryPath),
        surfaceCount: Array.isArray(registry.surfaces)
          ? registry.surfaces.length
          : 0,
        strict: {
          mode: registry.buildchain?.kfd3?.mode || '',
          sourceOfTruth: registry.policy?.sourceOfTruth || '',
          registryPath: registry.registryPath || '',
          contract: registry.contract || '',
        },
      },
      upstreamAggregate: {
        path: path.relative(process.cwd(), aggregatePath) || '.',
        sha256: sha256File(aggregatePath),
        upstreamCount: aggregate.summary?.upstreamCount || 0,
      },
      query: {
        status: query.status || 'unknown',
        capabilityCount: query.capabilities?.length || 0,
        kfd: query.kfd || {},
        warning: query.warning || '',
      },
      standards: buildKfdStandardsStatus(registry, registryPath, aggregate)
        .standards,
    };
    if (options.json)
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else
      process.stdout.write(
        `Kungfu KFD-3 check: ok, capabilities=${output.query.capabilityCount}\n`,
      );
    return;
  }
  if (command === 'upstream') {
    const { aggregate } = readKfdUpstreamAggregate();
    if (options.json)
      process.stdout.write(`${JSON.stringify(aggregate, null, 2)}\n`);
    else
      process.stdout.write(
        `Kungfu upstream KFD aggregate: ${aggregate.summary?.upstreamCount || 0} upstream(s)\n`,
      );
    return;
  }
  if (command === 'aggregate') {
    const aggregate = await kfdAggregate(options);
    if (options.json)
      process.stdout.write(`${JSON.stringify(aggregate, null, 2)}\n`);
    else
      process.stdout.write(
        `Kungfu KFD aggregate: own=${aggregate.own.surfaceCount}, upstream=${aggregate.upstream.summary?.upstreamCount || 0}\n`,
      );
    return;
  }
  if (command === 'witness') {
    const witness = {
      schemaVersion: 1,
      id: 'kungfu-sdk-kfd3-capability-witness',
      standard: 'kfd-3',
      witnessKind: 'installed-sdk-query',
      product: registry.product || { id: 'kungfu', name: 'Kungfu' },
      sourceRegistry: {
        path: path.relative(process.cwd(), registryPath) || '.',
        sha256: sha256File(registryPath),
      },
      exposedSurfaces: registry.surfaces || [],
      residualRisk: [
        'Installed CLI witnesses declare local capability facts; final release trust is determined by the Buildchain release passport KFD-2 context.',
      ],
    };
    if (options.json)
      process.stdout.write(`${JSON.stringify(witness, null, 2)}\n`);
    else
      process.stdout.write(
        `Kungfu KFD-3 witness: ${witness.exposedSurfaces.length} declared surface(s)\n`,
      );
    return;
  }
  fail(
    'unknown kfd command (supported: status, schema, 1, 2, 4, query, check, witness, upstream, aggregate)',
  );
}

const { positional, options } = parseArgs(process.argv.slice(2));
const [command, kind, ...rest] = positional;
const directory = rest[0];

if (!command) usage(1);
if (command === 'create') {
  if (kind === 'app') createApp(directory, options);
  else if (kind === 'extension') createExtension(directory, options);
  else if (kind === 'skill') createSkill(directory, options);
  else fail(`unknown target: ${kind} (supported: app, extension, skill)`);
} else if (command === 'kfx') {
  if (kind === 'build') await kfxBuild();
  else if (kind === 'clean') kfxClean();
  else fail(`unknown kfx command: ${kind} (supported: build, clean)`);
} else if (command === 'product') {
  await product(kind, directory, options);
} else if (command === 'kfd') {
  await kfd(kind, rest, options);
} else if (command === 'contract') {
  if (kind === 'adopt') contractAdopt(directory, options);
  else if (kind === 'render') contractRender(directory, options);
  else if (kind === 'evidence') contractEvidence(directory, options);
  else if (kind === 'policy') contractPolicy(options);
  else if (kind === 'witness') contractWitness(options);
  else if (kind === 'audit') contractAudit(options);
  else if (kind === 'add') contractAdd(directory, options);
  else
    fail(
      `unknown contract command: ${kind} (supported: adopt, render, evidence, policy, witness, audit, add)`,
    );
} else {
  fail(`unknown command: ${command}`);
}
