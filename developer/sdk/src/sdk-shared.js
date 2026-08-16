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
import kfxSharedModuleContract from '@kungfu-tech/kfx/shared-modules' with {
  type: 'json',
};

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
const SDK_CLI = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'sdk.js',
);
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
const SDK_KFD_SUPPORT_MATRIX = path.join(
  SDK_ROOT,
  'kfd',
  'support-matrix.json',
);
const SDK_KFD1_WITNESS = path.join(
  SDK_ROOT,
  'kfd',
  'kfd-1',
  'contract-world.witness.json',
);
const SDK_KFD1_RELEASE_GATE = path.join(
  SDK_ROOT,
  'kfd',
  'kfd-1',
  'release-gate.json',
);
const SDK_KFD1_VERIFY_RESULT = path.join(
  SDK_ROOT,
  'kfd',
  'kfd-1',
  'verify-result.json',
);
const SDK_KFD2_RELEASE_CLAIMS = path.join(
  SDK_ROOT,
  'kfd',
  'kfd-2',
  'release-claims.json',
);
const SDK_KFD2_CLAIMS_DIR = path.join(SDK_ROOT, 'kfd', 'kfd-2', 'claims');
const SDK_KFD2_CLAIM_ARGS = path.join(
  SDK_ROOT,
  'kfd',
  'kfd-2',
  'buildchain-claim-args.txt',
);
const KFD_AGENT_RUNTIME_MANIFEST = 'kfd-agent-runtime.manifest.json';
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
      '       kungfu sdk kfd schema <kfd-1..kfd-13> [--schema <name>] [--json]',
      '       kungfu sdk kfd 1 status|schema|witness|gate|verify [--json]',
      '       kungfu sdk kfd 2 status|schema|claims|trust-claims|trust-assessment [--json]',
      '       kungfu sdk kfd 4 status|schema [--json]',
      '       kungfu sdk kfd agent-runtime status [--json]',
      '       kungfu sdk kfd query|check|witness|upstream|aggregate [--json]',
      '       kungfu sdk kfx build | clean',
      '       kungfu sdk product gui dev|build|pack|dist [--dir <app-dir>] [--dry-run]',
      '       kungfu sdk product tui dev|build|bundle|dist [--dir <tui-dir>] [--dry-run]',
      '       kungfu sdk product cli dist [--dir <product-dir>] [--dry-run]',
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
      'exports the View component, kungfu.kfx.json carries the kungfuConfig',
      'manifest; package.json remains npm transport metadata. kfx commands run',
      'inside that package; build bundles src/view/ to dist/view/index.js',
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
      'kfd status/schema expose the governed KFD-1 through KFD-13 matrix;',
      'individual kfd 1/2/4 commands retain their specialized evidence views.',
      'kfd agent-runtime exposes the installed reference adapter, exact profile,',
      'suite root, and an explicitly supplied latest report without self-certifying it.',
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
    __KF_DEP_VERSION__: options.workspace ? 'workspace:*' : '^4.0.0-alpha.3',
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
    __KF_DEP_VERSION__: options.workspace ? 'workspace:*' : '^4.0.0-alpha.3',
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
function readPackageJson(cwd, filename = 'package.json') {
  const packageJson = path.join(cwd, filename);
  if (!fs.existsSync(packageJson)) {
    fail(`${filename} not found: ${packageJson}`);
  }
  const parsed = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
  if (!isObject(parsed)) {
    fail(`${filename} must be a JSON object: ${packageJson}`);
  }
  return parsed;
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
  for (const candidate of [
    path.join(SDK_ROOT, 'kungfu', 'config', KFX_CONTRACT_FILE),
    path.join(SDK_ROOT, 'config', KFX_CONTRACT_FILE),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
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

/** @param {string} cwd */
function readKfxManifest(cwd) {
  const parsed = readPackageJson(cwd, 'kungfu.kfx.json');
  validateKfxManifest(parsed);
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
function isProductAssemblyManifest(pkg) {
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
 * @param {string} file
 * @param {string[]} args
 * @param {CliOptions} options
 * @returns {void}
 */
function runNodeFile(cwd, file, args, options) {
  if (options.dryRun) {
    process.stdout.write(
      `[dry-run] cd ${cwd}\n[dry-run] ${shellLine([process.execPath, file, ...args])}\n`,
    );
    return;
  }
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    fail(
      `${path.relative(cwd, file)} failed (exit ${result.status ?? `signal ${result.signal}`})`,
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
    const manifestPath = path.join(sourceDir, 'kungfu.kfx.json');
    if (!fs.existsSync(manifestPath)) return;
    const manifest = readKfxManifest(sourceDir);
    const key = packageInstallKey(manifest, path.basename(sourceDir));
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
  const manifestPath = path.join(cwd, 'kungfu.kfx.json');
  if (!fs.existsSync(manifestPath)) return false;
  const manifest = readKfxManifest(cwd);
  const config = isObject(manifest.kungfuConfig) ? manifest.kungfuConfig : {};
  const facets = isObject(config.config) ? config.config : {};
  return (
    Boolean(facets.view) ||
    Boolean(facets.adapter) ||
    Boolean(facets.service) ||
    fs.existsSync(path.join(cwd, 'CMakeLists.txt')) ||
    isObject(manifest.kungfuBuild)
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
    KF_BUNDLED_EXTENSION_ROOT: extensionRoot,
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
      'kfx product gui supports dev and build; use a product assembly for pack/dist',
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
      `[dry-run] KF_BUNDLED_EXTENSION_ROOT=${referenceRoot}\n`,
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
function productAssemblyGui(cwd, verb, options) {
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
      KF_BUNDLED_EXTENSION_ROOT: extensionRoot,
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
    fail(`product config not found: ${config}`);
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
      `[dry-run] cd ${guiDir}\n[dry-run] KF_BUNDLED_EXTENSION_ROOT=${extensionRoot} ${shellLine([process.execPath, builderScript, ...args])}\n`,
    );
    return;
  }
  const result = spawnSync(process.execPath, [builderScript, ...args], {
    cwd: guiDir,
    env: {
      ...process.env,
      KF_BUNDLED_EXTENSION_ROOT: extensionRoot,
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
async function productAssemblyTui(cwd, verb, options) {
  const tuiDir = resolvePackageDir(cwd, '@kungfu-tech/tui');
  if (!tuiDir) fail('product assembly does not declare @kungfu-tech/tui');
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
 * @param {string} cwd
 * @param {string} verb
 * @param {CliOptions} options
 * @returns {void}
 */
function productAssemblyCli(cwd, verb, options) {
  if (verb !== 'dist') {
    fail('unknown product cli command (supported: dist)');
  }
  const pkg = readPackageJson(cwd);
  const scripts = scriptsOf(pkg);
  if (scripts['dist:cli']) {
    runPackageScript(cwd, 'dist:cli', options);
    return;
  }
  if (scripts['cli:dist']) {
    runPackageScript(cwd, 'cli:dist', options);
    return;
  }
  const distScript = path.join(cwd, 'scripts', 'dist.mjs');
  if (fs.existsSync(distScript)) {
    runNodeFile(cwd, distScript, ['--product', 'cli'], options);
    return;
  }
  fail('product assembly has no dist:cli script or scripts/dist.mjs');
}

/**
 * @param {string} verb
 * @param {CliOptions} options
 * @returns {void}
 */
function productGui(verb, options) {
  const cwd = productCwd(options.dir);
  const pkg = readPackageJson(cwd);
  if (fs.existsSync(path.join(cwd, 'kungfu.kfx.json'))) {
    productKfxGui(cwd, verb, options);
    return;
  }
  if (isProductAssemblyManifest(pkg)) {
    productAssemblyGui(cwd, verb, options);
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
  if (isProductAssemblyManifest(pkg)) {
    await productAssemblyTui(cwd, verb, options);
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
 * @param {string} verb
 * @param {CliOptions} options
 * @returns {void}
 */
function productCli(verb, options) {
  const cwd = productCwd(options.dir);
  const pkg = readPackageJson(cwd);
  if (isProductAssemblyManifest(pkg)) {
    productAssemblyCli(cwd, verb, options);
    return;
  }
  fail('product cli requires a product assembly package');
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
  if (surface === 'cli') {
    productCli(verb, options);
    return;
  }
  fail('unknown product target (supported: gui, tui, cli)');
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

export {
  spawnSync,
  createHash,
  fs,
  createRequire,
  os,
  path,
  fileURLToPath,
  BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH,
  collectKfdStatus,
  kfd1,
  kfd2,
  kfd3,
  kfd4,
  kfdSchemas,
  BUILDCHAIN_JSON_FORMATTING_POLICY,
  createKfd1ReleaseGateEvidence,
  normalizeKfd1ContractWorldWitness,
  resolveKfd1Metadata,
  sha256KfdJson,
  validateKfd1ReleaseGateEvidence,
  kfxSharedModuleContract,
  TEMPLATE_ROOT,
  KFX_CONTRACT_FILE,
  KFX_CONTRACT_ENV,
  CONTRACT_REGISTRY_FILE,
  CONTRACT_REGISTRY_ENV,
  CONTRACT_REGISTRY_SCHEMA,
  CONTRACT_FIXTURE_SCHEMA,
  CANONICAL_POLICY_SCHEMA,
  CANONICAL_POLICY_FILE,
  require,
  SDK_CLI,
  SDK_ROOT,
  SDK_KFD3_CANONICAL_REGISTRY,
  SDK_KFD_UPSTREAM_AGGREGATE,
  SDK_KFD_SUPPORT_MATRIX,
  SDK_KFD1_WITNESS,
  SDK_KFD1_RELEASE_GATE,
  SDK_KFD1_VERIFY_RESULT,
  SDK_KFD2_RELEASE_CLAIMS,
  SDK_KFD2_CLAIMS_DIR,
  SDK_KFD2_CLAIM_ARGS,
  KFD_AGENT_RUNTIME_MANIFEST,
  isWin,
  TUI_BUNDLE_BANNER,
  stubDevtools,
  usage,
  fail,
  errorMessage,
  parseArgs,
  toAppId,
  scaffold,
  createApp,
  createExtension,
  createSkill,
  productCwd,
  readPackageJson,
  ancestorDirs,
  resolveKfxContractPath,
  loadKfxContract,
  validateWithSchema,
  validateKfxManifest,
  readKfxManifest,
  dependencyMap,
  isProductAssemblyManifest,
  scriptsOf,
  packageRunner,
  localBin,
  shellLine,
  runLocalBin,
  runPackageScript,
  runSdkCommand,
  runNodeFile,
  resolvePackageDir,
  findRepoRootWithExtensions,
  resolveReferenceGuiDir,
  resolveReferenceExtensionsRoot,
  copyProductPackage,
  packageInstallKey,
  assembleProductExtensions,
  declaredKfxDependencies,
  isBuildableKfxPackage,
  electronDist,
  kfxProductEnv,
  productKfxGui,
  productAssemblyGui,
  productAssemblyTui,
  productAssemblyCli,
  productGui,
  productTuiBundle,
  productTui,
  productCli,
  product,
  isObject,
  readJson,
  renderJson,
  sha256File,
};
