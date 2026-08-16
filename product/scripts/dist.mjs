// SPDX-License-Identifier: Apache-2.0
// Build distributable products: sync -> core -> freeze -> KFX -> assembly ->
// TUI -> desktop installer and/or CLI archive under product/release.
// Run through the repo entrypoint so Node is pinned:
//   ./shifu dist

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createBuildchainLogger,
  verifyBuildchainLogEvents,
} from '@kungfu-tech/buildchain/logging';
import {
  qualificationAuthority,
  removalAuthority,
} from '../../tests/fixtures/_kfx-authority.mjs';
import { extractTarGz, extractZip, writeTarGz, writeZip } from './archive.mjs';
import { cliLauncherContent } from './cli-launcher.mjs';
import { qualifyCliSurface } from './cli-surface-qualification.mjs';
import {
  isPythonBytecodePath,
  writeCompatibilityManifest,
} from './compatibility.mjs';
import {
  isShippedKfdSupport,
  runInstalledActionPrimitiveDiscovery,
  runInstalledCliSemanticSmoke,
  runInstalledEmbeddedNodeAddonSmoke,
  runInstalledKfxWebhookAuthoringQualification,
  runInstalledKungfu,
  runInstalledKungfuActionSmoke,
  runInstalledKungfuAgentHubSmoke,
  runInstalledKungfuCommand,
  runInstalledKungfuKfdSmoke,
  runInstalledKungfuXinfaSmoke,
  runInstalledTuiBootstrapSmoke,
} from './installed-kungfu/index.mjs';
export {
  installedKungfuInvocation,
  isShippedKfdSupport,
  runInstalledCliSemanticSmoke,
  runInstalledEmbeddedNodeAddonSmoke,
  runInstalledKungfu,
  runInstalledKungfuAgentHubSmoke,
  runInstalledKungfuCommand,
  runInstalledTuiBootstrapSmoke,
} from './installed-kungfu/index.mjs';
import {
  assertLibwasmArtifact,
  runLibwasmArtifactSelfTest,
  runLibwasmExecutionQualification,
} from './libwasm-artifact.mjs';
import * as symlinks from './portable-symlinks.mjs';
import { productReleaseChannelConfig } from './release-channel-trust.mjs';
import {
  assertNodePtyPackageIdentity,
  assertSupportedProductHost,
  nodePtyRuntimeClosure,
  readTrunkRuntimePinSnapshot,
  runProductAssembly,
  verifyNodePtyRuntimeClosure,
} from './runtime-pin-snapshot.mjs';
import {
  buildCliUpgradeManifest,
  desktopUpdaterArtifact,
  finalizeCliUpgradeManifest,
  finalizeDesktopUpgradeManifest,
  platformUpgradeManifestName,
  resolveDesktopLocalArtifact,
} from './upgrade-manifest.mjs';
export { desktopUpdaterArtifact };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PRODUCT_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(PRODUCT_DIR, '..');
const GUI_DIR = path.join(ROOT, 'framework', 'gui');
const TUI_DIR = path.join(ROOT, 'framework', 'tui');
const AGENT_SESSION_DIR = path.join(ROOT, 'framework', 'agent-session');
const CORE_DIST = path.join(ROOT, 'framework', 'core', 'dist', 'kungfu');
const CRATES_DIR = path.join(ROOT, 'crates');
const RUNTIME_PINS = path.join(PRODUCT_DIR, 'runtime-pins.env');
const SDK_DIR = path.join(ROOT, 'developer', 'sdk');
const ACTION_DIR = path.join(ROOT, 'framework', 'action');
const XINFA_DIR = path.join(ROOT, 'crates', 'xinfa');
const EXTENSIONS_ROOT = path.join(ROOT, 'extensions');
const ASSEMBLED_EXTENSIONS = path.join(PRODUCT_DIR, 'extensions');
const DIST_DIR = path.join(PRODUCT_DIR, 'dist');
const DESKTOP_DIST_DIR = path.join(DIST_DIR, 'desktop');
const DESKTOP_AUTHORING_DIR = path.join(DIST_DIR, 'desktop-authoring');
const CLI_DIST_DIR = path.join(DIST_DIR, 'cli');
const RELEASE_DIR = path.join(PRODUCT_DIR, 'release');
const DESKTOP_RELEASE_DIR = path.join(RELEASE_DIR, 'desktop');
const CLI_RELEASE_DIR = path.join(RELEASE_DIR, 'cli');
const NPM_RELEASE_DIR = path.join(RELEASE_DIR, 'npm');
const CLI_ARCHIVE_PREFIX = 'kungfu-episodes-cli';
const AGENT_SESSION_CONTRACT_FILE = 'kungfu-agent-session.contract.json';
const CODEX_APP_SERVER_CONTRACT_FILE = 'kungfu-codex-app-server.contract.json';
const CLI_SURFACE_CATALOG = path.join(
  ROOT,
  'framework',
  'core',
  'src',
  'python',
  'kungfu',
  'agent',
  'cli_surface.catalog.json',
);
const COMPATIBILITY_MANIFEST = path.join(
  CORE_DIST,
  'product-compatibility.json',
);
const BUNDLED_UPGRADE_MANIFEST = path.join(
  GUI_DIR,
  'dist',
  'update',
  'kungfu-release-manifest.json',
);
const RELEASE_CHANNEL_TRUST = path.join(
  PRODUCT_DIR,
  'release-channel-trust.json',
);
const isWin = process.platform === 'win32';
const require = createRequire(import.meta.url);
const buildchainLogger = createBuildchainLogger({
  source: 'user',
  component: 'kungfu-product',
  attributes: {
    package: '@kungfu-tech/product-kungfu',
  },
});

const parsedArgs = parseArgs(process.argv.slice(2));
const builderArgs = parsedArgs.builderArgs;
const productTarget = parsedArgs.product;

function parseArgs(argv) {
  const parsed = {
    product: 'all',
    builderArgs: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--product') {
      i += 1;
      if (i >= argv.length) throw new Error('--product requires a value');
      parsed.product = argv[i];
    } else if (arg.startsWith('--product=')) {
      parsed.product = arg.slice('--product='.length);
    } else {
      parsed.builderArgs.push(arg);
    }
  }
  if (!['all', 'desktop', 'cli'].includes(parsed.product)) {
    throw new Error(`unsupported product target: ${parsed.product}`);
  }
  return parsed;
}

function wantsDesktop() {
  return productTarget === 'all' || productTarget === 'desktop';
}

function wantsCli() {
  return productTarget === 'all' || productTarget === 'cli';
}

function rel(p) {
  return path.relative(ROOT, p) || '.';
}

function sha256File(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function exitLabel(status, signal) {
  return status == null ? `signal ${signal}` : String(status);
}

function run(label, cmd, args, options = {}) {
  const cwd = options.cwd || ROOT;
  const event = options.event || `product.command.${labelSlug(label)}`;
  return buildchainLogger.spanSync(
    event,
    {
      phase: options.phase || 'build',
      attributes: {
        label,
        command: cmd,
        cwd: rel(cwd),
        argCount: args.length,
        ...options.attributes,
      },
    },
    () => {
      console.log(`\n[product] ${label}`);
      console.log(`[product] $ ${[cmd, ...args].join(' ')}`);
      const result = spawnSync(cmd, args, {
        cwd,
        env: options.env || process.env,
        stdio: 'inherit',
        shell: isWin,
      });
      if (result.status !== 0) {
        throw new Error(
          `${label} failed (exit ${exitLabel(result.status, result.signal)})`,
        );
      }
      return result;
    },
  );
}

function runPnpm(label, args, options = {}) {
  run(label, 'pnpm', args, options);
}

function labelSlug(label) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

function libnodePlatformPackageName() {
  const packages = {
    'darwin-arm64': '@kungfu-tech/libnode-darwin-arm64',
    'linux-x64': '@kungfu-tech/libnode-linux-x64',
    'linux-arm64': '@kungfu-tech/libnode-linux-arm64',
    'win32-x64': '@kungfu-tech/libnode-win32-x64',
  };
  return packages[`${process.platform}-${process.arch}`];
}

function rollupPlatformPackageName() {
  const libc = linuxLibc();
  const packages = {
    'darwin-arm64': '@rollup/rollup-darwin-arm64',
    [`linux-arm64-${libc}`]: `@rollup/rollup-linux-arm64-${libc}`,
    [`linux-x64-${libc}`]: `@rollup/rollup-linux-x64-${libc}`,
    'win32-arm64': '@rollup/rollup-win32-arm64-msvc',
    'win32-ia32': '@rollup/rollup-win32-ia32-msvc',
    'win32-x64': '@rollup/rollup-win32-x64-msvc',
  };
  return packages[
    `${process.platform}-${process.arch}${libc ? `-${libc}` : ''}`
  ];
}

function esbuildPlatformPackageName() {
  const packages = {
    'darwin-arm64': '@esbuild/darwin-arm64',
    'linux-x64': '@esbuild/linux-x64',
    'linux-arm64': '@esbuild/linux-arm64',
    'win32-x64': '@esbuild/win32-x64',
  };
  return packages[`${process.platform}-${process.arch}`];
}

function linuxLibc() {
  if (process.platform !== 'linux') {
    return '';
  }
  const report = process.report?.getReport?.();
  return report?.header?.glibcVersionRuntime ? 'gnu' : 'musl';
}

export function installArgs(
  noOptional = process.env.KUNGFU_BUILDCHAIN_NO_OPTIONAL === '1',
) {
  const args = ['install', '--frozen-lockfile'];
  if (noOptional) {
    args.push('--no-optional');
  }
  // Product distribution is an owned, non-interactive build boundary. A
  // changed Shifu cache overlay may make the generated modules layout stale;
  // authorize pnpm to replace it instead of requiring a TTY prompt.
  args.push('--config.confirmModulesPurge=false');
  return args;
}

function canResolve(packageName) {
  try {
    require.resolve(`${packageName}/package.json`);
    return true;
  } catch {
    return false;
  }
}

function canResolveFrom(packageName, paths) {
  try {
    require.resolve(`${packageName}/package.json`, { paths });
    return true;
  } catch {
    return false;
  }
}

function packageVersionFrom(packageName, paths) {
  return readJson(require.resolve(`${packageName}/package.json`, { paths }))
    .version;
}

function rollupPackagePathsFromGui() {
  const vitePackageJson = require.resolve('vite/package.json', {
    paths: [GUI_DIR],
  });
  const viteDir = path.dirname(vitePackageJson);
  const rollupPackageJson = require.resolve('rollup/package.json', {
    paths: [viteDir],
  });
  return [path.dirname(rollupPackageJson), viteDir];
}

function rollupVersionFromGui() {
  return packageVersionFrom('rollup', rollupPackagePathsFromGui());
}

function packageJsonPath(nodePath, packageName) {
  return path.join(nodePath, ...packageName.split('/'), 'package.json');
}

function appendNodePath(env, nodePaths) {
  const nextNodePath = [...nodePaths, env.NODE_PATH || '']
    .filter(Boolean)
    .join(path.delimiter);
  return nextNodePath ? { ...env, NODE_PATH: nextNodePath } : env;
}

function ensureNoOptionalPlatformPackage({
  kind,
  packageName,
  version,
  installRoot,
}) {
  const nodePath = path.join(installRoot, 'node_modules');
  const installedPackageJson = packageJsonPath(nodePath, packageName);
  const installedVersion = fs.existsSync(installedPackageJson)
    ? readJson(installedPackageJson).version
    : undefined;
  if (installedVersion !== version) {
    fs.rmSync(installRoot, { recursive: true, force: true });
    fs.mkdirSync(installRoot, { recursive: true });
    run(
      `install ${kind} platform package`,
      'npm',
      [
        'install',
        '--no-save',
        '--package-lock=false',
        '--ignore-scripts',
        // Platform packages can be published after a runner cached an older
        // packument. Revalidate metadata through the configured registry so a
        // warm cache cannot turn a real version into a false ETARGET.
        '--prefer-online',
        '--prefix',
        installRoot,
        `${packageName}@${version}`,
      ],
      {
        phase: 'dependencies',
        event: `product.${kind}.platform.install`,
        attributes: {
          packageName,
          version,
        },
      },
    );
  } else {
    buildchainLogger.mark(`product.${kind}.platform.cached`, {
      phase: 'dependencies',
      attributes: {
        packageName,
        version,
      },
    });
  }

  buildchainLogger.mark(`product.${kind}.platform.ready`, {
    phase: 'dependencies',
    attributes: {
      packageName,
      version,
    },
  });
  return nodePath;
}

export function esbuildPlatformBinaryPath(packageRoot, platform) {
  return path.join(
    packageRoot,
    platform === 'win32' ? 'esbuild.exe' : path.join('bin', 'esbuild'),
  );
}

export function requiresManagedEsbuildPlatform({
  noOptional,
  hostVersion,
  platformVersion,
}) {
  return noOptional && platformVersion !== hostVersion;
}

function ensureEsbuildRuntime({ slot, paths }) {
  const packageJson = require.resolve('esbuild/package.json', { paths });
  const esbuildVersion = readJson(packageJson).version;
  const resolvePaths = [path.dirname(packageJson)];
  const packageName = esbuildPlatformPackageName();
  if (!packageName) {
    throw new Error(
      `unsupported esbuild platform: ${process.platform}-${process.arch}`,
    );
  }
  let platformPackageJson;
  try {
    platformPackageJson = require.resolve(`${packageName}/package.json`, {
      paths: resolvePaths,
    });
  } catch {
    platformPackageJson = undefined;
  }
  const resolvedPlatformVersion = platformPackageJson
    ? readJson(platformPackageJson).version
    : undefined;
  if (
    requiresManagedEsbuildPlatform({
      noOptional: process.env.KUNGFU_BUILDCHAIN_NO_OPTIONAL === '1',
      hostVersion: esbuildVersion,
      platformVersion: resolvedPlatformVersion,
    })
  ) {
    const nodePath = ensureNoOptionalPlatformPackage({
      kind: `esbuild.${slot}`,
      packageName,
      version: esbuildVersion,
      installRoot: path.join(
        ROOT,
        '.buildchain',
        'esbuild-platform',
        slot,
        `${process.platform}-${process.arch}`,
      ),
    });
    platformPackageJson = packageJsonPath(nodePath, packageName);
    resolvePaths.unshift(path.dirname(nodePath));
  }
  if (!platformPackageJson) {
    throw new Error(`missing ${packageName} for esbuild ${esbuildVersion}`);
  }
  const platformVersion = readJson(platformPackageJson).version;
  if (platformVersion !== esbuildVersion) {
    throw new Error(
      `esbuild host ${esbuildVersion} does not match ${packageName} ${platformVersion}`,
    );
  }
  const binaryPath = esbuildPlatformBinaryPath(
    path.dirname(platformPackageJson),
    process.platform,
  );
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`missing ${packageName} binary: ${binaryPath}`);
  }
  return {
    packageJson,
    packageName,
    resolvePaths,
    binaryPath,
  };
}

function guiEsbuildPackagePaths() {
  const electronVitePackageJson = require.resolve(
    'electron-vite/package.json',
    { paths: [GUI_DIR] },
  );
  return [path.dirname(electronVitePackageJson)];
}

function buildchainSourceBuildEnv() {
  if (process.env.KUNGFU_BUILDCHAIN_NO_OPTIONAL !== '1') {
    buildchainLogger.mark('product.libnode.platform.optional', {
      phase: 'dependencies',
      attributes: {
        noOptional: false,
      },
    });
    return process.env;
  }

  const packageName = libnodePlatformPackageName();
  if (!packageName) {
    throw new Error(
      `unsupported libnode platform: ${process.platform}-${process.arch}`,
    );
  }
  const nodePaths = [];
  if (canResolve(packageName)) {
    buildchainLogger.mark('product.libnode.platform.resolved', {
      phase: 'dependencies',
      attributes: {
        packageName,
        source: 'workspace-node-path',
      },
    });
  }

  const corePackage = readJson(
    path.join(ROOT, 'framework', 'core', 'package.json'),
  );
  const libnodeVersion = corePackage.devDependencies?.['@kungfu-tech/libnode'];
  if (!libnodeVersion) {
    throw new Error('framework/core must declare @kungfu-tech/libnode');
  }

  const installRoot = path.join(
    ROOT,
    '.buildchain',
    'libnode-platform',
    `${process.platform}-${process.arch}`,
  );
  if (!canResolve(packageName)) {
    nodePaths.push(
      ensureNoOptionalPlatformPackage({
        kind: 'libnode',
        packageName,
        version: libnodeVersion,
        installRoot,
      }),
    );
  }

  const rollupPackageName = rollupPlatformPackageName();
  if (!rollupPackageName) {
    throw new Error(
      `unsupported rollup platform: ${process.platform}-${process.arch}`,
    );
  }
  if (canResolveFrom(rollupPackageName, rollupPackagePathsFromGui())) {
    buildchainLogger.mark('product.rollup.platform.resolved', {
      phase: 'dependencies',
      attributes: {
        packageName: rollupPackageName,
        source: 'workspace-node-path',
      },
    });
  } else {
    nodePaths.push(
      ensureNoOptionalPlatformPackage({
        kind: 'rollup',
        packageName: rollupPackageName,
        version: rollupVersionFromGui(),
        installRoot: path.join(
          ROOT,
          '.buildchain',
          'rollup-platform',
          `${process.platform}-${process.arch}`,
        ),
      }),
    );
  }

  return appendNodePath(process.env, nodePaths);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseJsonOutput(output, label) {
  const text = output.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error(`${label} did not produce JSON output`);
  }
}

export function listKfxPackages() {
  const packages = [];
  const visit = (dir, depth) => {
    if (depth > 2 || !fs.existsSync(dir)) return;
    const packagePath = path.join(dir, 'package.json');
    if (fs.existsSync(packagePath)) {
      const pkg = readJson(packagePath);
      if (pkg.kungfuProduct?.assembly === 'reference-only') return;
    }
    if (fs.existsSync(path.join(dir, 'kungfu.kfx.json'))) {
      const pkg = readJson(packagePath);
      const manifest = readJson(path.join(dir, 'kungfu.kfx.json'));
      if (manifest?.name && manifest?.kungfuConfig) {
        packages.push({
          name: manifest.name,
          dir,
          relDir: path.relative(EXTENSIONS_ROOT, dir),
          config: manifest.kungfuConfig,
          scripts: pkg.scripts || {},
        });
      }
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      visit(path.join(dir, entry.name), depth + 1);
    }
  };
  visit(EXTENSIONS_ROOT, 0);
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

export function isKfxPackageName(name) {
  return (
    name.startsWith('@kungfu-tech/kfx-') || name.startsWith('@kungfu-kfx/')
  );
}

function productKfxDeclarations() {
  const pkg = readJson(path.join(PRODUCT_DIR, 'package.json'));
  const dependencies = Object.keys(pkg.dependencies || {}).filter(
    isKfxPackageName,
  );
  const metadata = pkg.kungfuProduct?.extensionPackages || [];
  return new Set([...dependencies, ...metadata]);
}

export function assertDeclaredKfx(packages) {
  const declared = productKfxDeclarations();
  const actual = new Set(packages.map((pkg) => pkg.name));
  const missing = [...actual].filter((name) => !declared.has(name)).sort();
  const stale = [...declared].filter((name) => !actual.has(name)).sort();
  if (missing.length || stale.length) {
    throw new Error(
      [
        'product/package.json must declare every product-assembled KFX dependency',
        missing.length ? `missing: ${missing.join(', ')}` : '',
        stale.length ? `stale: ${stale.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  console.log(`[product] declared kfx packages: ${packages.length}`);
  buildchainLogger.mark('product.kfx.dependencies.declared', {
    phase: 'prepare',
    attributes: {
      packageCount: packages.length,
    },
  });
}

function assertSafeGeneratedDir(dir) {
  const resolved = path.resolve(dir);
  const relDir = path.relative(PRODUCT_DIR, resolved);
  const first = relDir.split(path.sep)[0];
  if (
    resolved === PRODUCT_DIR ||
    relDir.startsWith('..') ||
    path.isAbsolute(relDir) ||
    !['extensions', 'dist', 'release'].includes(first)
  ) {
    throw new Error(`refusing to clean unexpected directory: ${resolved}`);
  }
}

function copyPackageDir(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    dereference: false,
    filter: (src) => {
      const base = path.basename(src);
      if (
        base === 'node_modules' ||
        base === 'build' ||
        base === '.venv' ||
        isPythonBytecodePath(src) ||
        base === '.DS_Store'
      ) {
        return false;
      }
      return true;
    },
  });
}

function buildKfx(packages, baseEnv = process.env) {
  const env = {
    ...baseEnv,
    PATH: `${CORE_DIST}${path.delimiter}${baseEnv.PATH || process.env.PATH || ''}`,
  };
  for (const pkg of packages) {
    if (!pkg.scripts.build) {
      console.log(`[product] skip ${pkg.name}: no build script`);
      buildchainLogger.mark('product.kfx.build.skipped', {
        phase: 'extensions',
        attributes: {
          packageName: pkg.name,
          reason: 'no-build-script',
        },
      });
      continue;
    }
    runPnpm(`build kfx ${pkg.name}`, ['run', 'build'], {
      cwd: pkg.dir,
      env,
      phase: 'extensions',
      event: 'product.kfx.build',
      attributes: {
        packageName: pkg.name,
      },
    });
    if (pkg.config?.config?.view) {
      const entry = pkg.config.config.view.entry || 'dist/view/index.js';
      const bundlePath = path.join(pkg.dir, entry);
      if (!fs.existsSync(bundlePath)) {
        throw new Error(`${pkg.name} build did not produce ${rel(bundlePath)}`);
      }
    }
  }
}

export function kfxBundleExternalModules(code) {
  const modules = new Set();
  const literalRequire = /(^|[^\w$.])require\(\s*(['"])([^'"]+)\2\s*\)/gm;
  for (const match of code.matchAll(literalRequire)) modules.add(match[3]);
  return [...modules].sort();
}

function assertKfxBundleExternals(packages) {
  const contract = readJson(
    path.join(ROOT, 'framework', 'kfx', 'shared-modules.json'),
  );
  const supported = new Set(contract.modules || []);
  const unsupported = [];
  for (const pkg of packages) {
    if (!pkg.config?.config?.view) continue;
    const entry = pkg.config.config.view.entry || 'dist/view/index.js';
    const bundlePath = path.join(pkg.dir, entry);
    for (const moduleId of kfxBundleExternalModules(
      fs.readFileSync(bundlePath, 'utf8'),
    )) {
      if (!supported.has(moduleId)) {
        unsupported.push(`${pkg.name}: ${moduleId}`);
      }
    }
  }
  if (unsupported.length > 0) {
    throw new Error(
      `kfx bundles require modules the GUI cannot inject:\n${unsupported.join('\n')}`,
    );
  }
  console.log(
    `[product] kfx shared-module contract: ${supported.size} modules`,
  );
}

function assembleKfx(packages) {
  buildchainLogger.spanSync(
    'product.kfx.assemble',
    {
      phase: 'extensions',
      attributes: {
        packageCount: packages.length,
        output: rel(ASSEMBLED_EXTENSIONS),
      },
    },
    () => {
      assertSafeGeneratedDir(ASSEMBLED_EXTENSIONS);
      fs.rmSync(ASSEMBLED_EXTENSIONS, { recursive: true, force: true });
      fs.mkdirSync(ASSEMBLED_EXTENSIONS, { recursive: true });
      for (const pkg of packages) {
        copyPackageDir(pkg.dir, path.join(ASSEMBLED_EXTENSIONS, pkg.relDir));
      }
      console.log(
        `[product] assembled kfx packages -> ${rel(ASSEMBLED_EXTENSIONS)}`,
      );
    },
  );
}

function stageTopLevelFiles({ sourceDir, releaseDir, label }) {
  buildchainLogger.spanSync(
    `product.${label}.release.stage`,
    {
      phase: 'package',
      attributes: {
        source: rel(sourceDir),
        output: rel(releaseDir),
      },
    },
    () => {
      if (!fs.existsSync(sourceDir)) {
        throw new Error(`${label} product did not produce ${rel(sourceDir)}`);
      }
      assertSafeGeneratedDir(releaseDir);
      fs.rmSync(releaseDir, { recursive: true, force: true });
      fs.mkdirSync(releaseDir, { recursive: true });

      const stagedFiles = [];
      for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        if (!entry.isFile()) {
          continue;
        }
        const source = path.join(sourceDir, entry.name);
        const target = path.join(releaseDir, entry.name);
        fs.copyFileSync(source, target);
        stagedFiles.push(entry.name);
      }
      if (!stagedFiles.length) {
        throw new Error(
          `no top-level release files found in ${rel(sourceDir)}`,
        );
      }
      stagedFiles.sort();
      console.log(
        `[product] staged ${label} release files -> ${rel(releaseDir)} (${stagedFiles.join(', ')})`,
      );
    },
  );
}

function stageDesktopRelease() {
  stageTopLevelFiles({
    sourceDir: DESKTOP_DIST_DIR,
    releaseDir: DESKTOP_RELEASE_DIR,
    label: 'desktop',
  });
}

function finalizeDesktopReleaseManifest() {
  if (builderArgs.includes('--dir')) {
    console.log(
      '[product] directory-only desktop build has no publishable update artifact',
    );
    return null;
  }
  const files = fs.readdirSync(DESKTOP_DIST_DIR);
  const artifactName = desktopUpdaterArtifact(files);
  const localArtifact = resolveDesktopLocalArtifact(
    DESKTOP_DIST_DIR,
    artifactName,
  );
  const metadata = files.filter(
    (file) => file.endsWith('.yml') || file.endsWith('.yaml'),
  );
  if (!metadata.length) {
    throw new Error('desktop release did not produce updater channel metadata');
  }
  const bundledManifest = readJson(BUNDLED_UPGRADE_MANIFEST);
  const outputName = platformUpgradeManifestName(
    bundledManifest.productVersion,
    process.platform,
    process.arch,
  );
  const tag = `v${bundledManifest.productVersion}`;
  const artifactUrl =
    process.env.KF_DESKTOP_ARTIFACT_URL ||
    `https://github.com/kungfu-systems/kungfu/releases/download/${tag}/${encodeURIComponent(artifactName)}`;
  const manifest = finalizeDesktopUpgradeManifest({
    bundledManifest,
    desktopArtifact: path.join(DESKTOP_DIST_DIR, artifactName),
    localArtifact,
    artifactUrl,
    output: path.join(DESKTOP_DIST_DIR, outputName),
  });
  console.log(
    `[product] desktop upgrade manifest -> ${rel(path.join(DESKTOP_DIST_DIR, outputName))} (${manifest.qualificationEvidenceRef})`,
  );
  return manifest;
}

function assertCoreAssembled() {
  const kungfuBin = path.join(CORE_DIST, isWin ? 'kungfu.exe' : 'kungfu');
  if (!fs.existsSync(kungfuBin)) {
    throw new Error(`freeze did not produce ${rel(kungfuBin)}`);
  }
  // Assembled form (KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 stage 2): when the dist carries the interpreter
  // tree, it must be well-formed — the host marker declares the form and the
  // tree's python3 is the real sys.executable the entry execs.
  const tree = path.join(CORE_DIST, 'python');
  if (fs.existsSync(tree)) {
    // The interpreter is python.exe at the tree root on Windows, bin/python3 on
    // POSIX (same fork as run-freeze.js assembleLayout and the trunk's
    // tree_python) — the real sys.executable the entry execs.
    const treePython =
      process.platform === 'win32'
        ? path.join(tree, 'python.exe')
        : path.join(tree, 'bin', 'python3');
    for (const required of [path.join(tree, 'kungfu-host.json'), treePython]) {
      if (!fs.existsSync(required)) {
        throw new Error(`assembled runtime tree incomplete: ${rel(required)}`);
      }
    }
  }
  // The product install surface (`kungfu env`) resolves the pykungfu wheel
  // from dist/kungfu/wheels. A bare dev freeze only warns when the wheel is
  // missing; the product chain must not ship without it.
  const wheels = path.join(CORE_DIST, 'wheels');
  const hasWheel =
    fs.existsSync(wheels) &&
    fs.readdirSync(wheels).some((f) => f.endsWith('.whl'));
  if (!hasWheel) {
    throw new Error(
      `no pykungfu wheel under ${rel(wheels)}; the install surface would ship unusable`,
    );
  }
  assertLibwasmArtifact(CORE_DIST);
  runLibwasmArtifactSelfTest(CORE_DIST);
  runLibwasmExecutionQualification(CORE_DIST);
}

// KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 stage 1: kungfu-trunk (the product trunk carrying the kungfu-owned
// env/package surface) ships next to the assembled product, together with its
// runtime-pins manifest. UV_VERSION in the manifest must equal the repo's
// .uv-version so the product and the dev launcher pull the same pinned uv.
export function stageProductTrunkEntrypoints(
  trunkBin,
  runtimeRoot,
  platform = process.platform,
) {
  const suffix = platform === 'win32' ? '.exe' : '';
  for (const name of ['kungfu-trunk', 'kungfu']) {
    fs.copyFileSync(trunkBin, path.join(runtimeRoot, `${name}${suffix}`));
  }
}

function stageTrunk(runtimePinSnapshot) {
  // KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 stage 3 productionization: link the embedding membrane and ship the
  // real embedding-backed doctor on every platform. POSIX links the SHARED
  // libkungfu from build/<type>; Windows links the single-export
  // kungfu_abi.lib standard-ABI import lib from the build root, where MSVC
  // archives colocate. The product core is rebuilt (Release) before this stage,
  // so the native dir is populated; pass it explicitly so build.rs never guesses.
  const buildType = process.env.KF_TRUNK_BUILD_TYPE || 'Release';
  const coreBuild = path.join(ROOT, 'framework', 'core', 'build');
  const cargoArgs = [
    'build',
    '--release',
    '-p',
    'kungfu-trunk',
    '--features',
    'embedding',
  ];
  const runOpts = {
    cwd: CRATES_DIR,
    phase: 'core',
    event: 'product.core.trunk',
    env: {
      ...process.env,
      // Windows: kungfu_abi.lib at the build root; POSIX: libkungfu.* under build/<type>.
      KF_TRUNK_NATIVE_DIR: isWin ? coreBuild : path.join(coreBuild, buildType),
      KF_TRUNK_BUILD_TYPE: buildType,
    },
  };
  run('build kungfu-trunk', 'cargo', cargoArgs, runOpts);
  const trunkBin = path.join(
    CRATES_DIR,
    'target',
    'release',
    isWin ? 'kungfu-trunk.exe' : 'kungfu-trunk',
  );
  if (!fs.existsSync(trunkBin)) {
    throw new Error(`cargo did not produce ${rel(trunkBin)}`);
  }
  stageProductTrunkEntrypoints(trunkBin, CORE_DIST);
  fs.writeFileSync(
    path.join(CORE_DIST, 'runtime-pins.env'),
    runtimePinSnapshot.runtimePins,
    'utf8',
  );
  materializeProductRuntimeEntrypoints(CORE_DIST);
  console.log(
    '[product] kungfu-trunk + runtime-pins.env staged into core dist',
  );
}

export function materializeProductRuntimeEntrypoints(
  runtimeRoot,
  platform = process.platform,
) {
  if (platform === 'win32') return;
  for (const executable of [
    path.join(runtimeRoot, 'kungfu'),
    path.join(runtimeRoot, 'python', 'bin', 'python3'),
  ]) {
    symlinks.materializeRegularFile(executable);
  }
}

function platformId() {
  const platform =
    {
      darwin: 'darwin',
      linux: 'linux',
      win32: 'windows',
    }[process.platform] || process.platform;
  const arch =
    {
      x64: 'x64',
      arm64: 'arm64',
    }[process.arch] || process.arch;
  return `${platform}-${arch}`;
}

export function copyTree(source, target, options = {}) {
  if (!fs.existsSync(source)) {
    if (options.optional) return false;
    throw new Error(`required product input not found: ${rel(source)}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    dereference: false,
    filter: (src) => {
      const base = path.basename(src);
      return (
        !isPythonBytecodePath(src) &&
        !['node_modules', 'build', '.venv', '.DS_Store'].includes(base)
      );
    },
  });
  symlinks.normalizeCopiedSymlinks({ source, target });
  return true;
}

export function stageNodePtyForCli(
  source,
  target,
  platform = process.platform,
  architecture = process.arch,
) {
  assertNodePtyPackageIdentity(source);
  const closure = nodePtyRuntimeClosure(platform, architecture);
  copyTree(source, target);
  const prebuilds = path.join(target, 'prebuilds');
  if (fs.existsSync(prebuilds)) {
    const selected =
      platform === 'darwin' || platform === 'win32'
        ? `${platform}-${architecture}`
        : null;
    for (const entry of fs.readdirSync(prebuilds)) {
      if (entry !== selected) {
        fs.rmSync(path.join(prebuilds, entry), {
          recursive: true,
          force: true,
        });
      }
    }
    if (selected === null) fs.rmSync(prebuilds, { recursive: true });
  }
  if (platform === 'linux') {
    // node-pty 1.1.0 builds spawn-helper only on Darwin. Linux uses forkpty,
    // so restore only the addon that copyTree deliberately excludes with build/.
    for (const relative of closure.requiredFiles) {
      const input = path.join(source, relative);
      if (!fs.existsSync(input) || !fs.lstatSync(input).isFile()) {
        throw new Error(
          `required node-pty runtime file not found: ${rel(input)}`,
        );
      }
      const output = path.join(target, relative);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.copyFileSync(input, output);
    }
  }
  for (const relative of closure.executableFiles) {
    fs.chmodSync(path.join(target, relative), 0o755);
  }
  verifyNodePtyRuntimeClosure(target, platform, architecture);
}

export function verifyDarwinCliExecutableLayout(installRoot, run = spawnSync) {
  if (process.platform !== 'darwin') return null;
  const layout = cliArchiveLayout('darwin');
  const nodePtyRoot = path.join(
    installRoot,
    'tui',
    'node_modules',
    'node-pty',
    'prebuilds',
  );
  const selectedPrebuild = `darwin-${process.arch}`;
  const prebuilds = fs.readdirSync(nodePtyRoot).sort();
  if (prebuilds.join('\0') !== selectedPrebuild) {
    throw new Error(
      `macOS CLI node-pty closure is not architecture-exact: ${prebuilds.join(', ')}`,
    );
  }
  const machObjects = [
    path.join(installRoot, layout.runtimeEntrypoint),
    path.join(installRoot, layout.pythonEntrypoint),
    path.join(nodePtyRoot, selectedPrebuild, 'pty.node'),
    path.join(nodePtyRoot, selectedPrebuild, 'spawn-helper'),
  ];
  const executablePaths = new Set([
    machObjects[0],
    machObjects[1],
    machObjects[3],
  ]);
  for (const executable of machObjects) {
    if (
      executablePaths.has(executable) &&
      (fs.statSync(executable).mode & 0o111) === 0
    ) {
      throw new Error(`macOS CLI executable bit is missing: ${executable}`);
    }
    const architecture = run('file', ['-b', executable], {
      encoding: 'utf8',
    });
    if (
      architecture.status !== 0 ||
      !String(architecture.stdout).includes('arm64') ||
      String(architecture.stdout).includes('x86_64')
    ) {
      throw new Error(
        `macOS CLI executable architecture is not arm64: ${executable}`,
      );
    }
    const signature = run(
      'codesign',
      ['--verify', '--strict', '--verbose=2', executable],
      { encoding: 'utf8' },
    );
    if (signature.status !== 0) {
      throw new Error(
        `macOS CLI executable signature is invalid: ${executable}: ${signature.stderr || signature.stdout}`,
      );
    }
  }
  return {
    architecture: 'arm64',
    architectureExact: true,
    executableBits: true,
    codesignStrict: true,
    nodePtyPrebuild: selectedPrebuild,
    notarization:
      'protected-release-credential-island-not-claimed-by-dev-build',
  };
}

function bundleSdkForCli(stageRoot, esbuildRuntime) {
  const esbuild = require(
    require.resolve('esbuild', {
      paths: [SDK_DIR, TUI_DIR, ROOT],
    }),
  );
  const sdkOut = path.join(stageRoot, 'sdk', 'sdk.js');
  fs.mkdirSync(path.dirname(sdkOut), { recursive: true });
  const previousEsbuildBinaryPath = process.env.ESBUILD_BINARY_PATH;
  try {
    process.env.ESBUILD_BINARY_PATH = esbuildRuntime.binaryPath;
    esbuild.buildSync({
      entryPoints: [path.join(SDK_DIR, 'src', 'sdk.js')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      external: ['esbuild'],
      outfile: sdkOut,
      logLevel: 'silent',
    });
  } finally {
    if (previousEsbuildBinaryPath === undefined) {
      Reflect.deleteProperty(process.env, 'ESBUILD_BINARY_PATH');
    } else {
      process.env.ESBUILD_BINARY_PATH = previousEsbuildBinaryPath;
    }
  }
  fs.writeFileSync(
    path.join(stageRoot, 'sdk', 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
  );
  copyTree(path.join(SDK_DIR, 'kfd'), path.join(stageRoot, 'kfd'));
  copyTree(path.join(SDK_DIR, 'templates'), path.join(stageRoot, 'templates'));
  copySdkRuntimePackageForCli(
    stageRoot,
    'esbuild',
    esbuildRuntime.resolvePaths,
  );
  copySdkRuntimePackageForCli(
    stageRoot,
    esbuildRuntime.packageName,
    esbuildRuntime.resolvePaths,
  );
  copySdkRuntimePackageForCli(stageRoot, '@kungfu-tech/kfd');
  stageActionPackage(stageRoot);
  stageXinfaContract(stageRoot);
}

export function stageXinfaContract(stageRoot) {
  const target = path.join(stageRoot, 'xinfa');
  const contractTarget = path.join(target, 'contract', 'xinfa-product-v2.json');
  const engineSource = path.join(XINFA_DIR, 'engine', 'xinfa.wasm');
  const manifestSource = path.join(XINFA_DIR, 'engine', 'manifest.json');
  const manifest = readJson(manifestSource);
  if (manifest.schema !== 'xinfa.engine-manifest/v1') {
    throw new Error(
      `unexpected Xinfa engine manifest schema: ${manifest.schema}`,
    );
  }
  if (manifest.wasm_sha256 !== sha256File(engineSource)) {
    throw new Error(
      'Xinfa verification engine SHA-256 does not match its manifest',
    );
  }
  if (manifest.size !== fs.statSync(engineSource).size) {
    throw new Error(
      'Xinfa verification engine size does not match its manifest',
    );
  }
  fs.mkdirSync(path.dirname(contractTarget), { recursive: true });
  fs.copyFileSync(
    path.join(XINFA_DIR, 'contract', 'xinfa-product-v2.json'),
    contractTarget,
  );
  copyTree(path.join(XINFA_DIR, 'engine'), path.join(target, 'engine'));
  const stagedEngine = path.join(target, 'engine', 'xinfa.wasm');
  if (manifest.wasm_sha256 !== sha256File(stagedEngine)) {
    throw new Error(
      'staged Xinfa verification engine SHA-256 changed during copy',
    );
  }
  return target;
}

export function stageActionPackage(stageRoot) {
  const target = path.join(stageRoot, 'action');
  const manifestPath = path.join(ACTION_DIR, 'manifest.json');
  const manifest = readJson(manifestPath);
  const files = [
    'manifest.json',
    ...(manifest.files || []).map(({ path }) => path),
  ];
  fs.mkdirSync(target, { recursive: true });
  for (const relative of files) {
    const source = path.join(ACTION_DIR, relative);
    const destination = path.join(target, relative);
    assertFile(source, `Action package file ${relative}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  return target;
}

function stageAgentSessionContractsForCli(stageRoot) {
  for (const relative of [
    AGENT_SESSION_CONTRACT_FILE,
    CODEX_APP_SERVER_CONTRACT_FILE,
  ]) {
    const source = path.join(AGENT_SESSION_DIR, relative);
    const destination = path.join(stageRoot, relative);
    assertFile(source, `Agent Session contract ${relative}`);
    fs.copyFileSync(source, destination);
  }
  copyTree(
    path.join(AGENT_SESSION_DIR, 'schemas'),
    path.join(stageRoot, 'schemas'),
  );

  const codexContract = readJson(
    path.join(stageRoot, CODEX_APP_SERVER_CONTRACT_FILE),
  );
  const schemaManifest = codexContract.surfacePin?.schemaManifest;
  if (
    typeof schemaManifest !== 'string' ||
    path.isAbsolute(schemaManifest) ||
    schemaManifest.split(/[\\/]/u).includes('..')
  ) {
    throw new Error(
      'Codex App Server contract declares an unsafe schema manifest path',
    );
  }
  assertFile(
    path.join(stageRoot, schemaManifest),
    'Codex App Server schema manifest',
  );
}

function stageDesktopAuthoringRuntime(esbuildRuntime) {
  assertSafeGeneratedDir(DESKTOP_AUTHORING_DIR);
  fs.rmSync(DESKTOP_AUTHORING_DIR, { recursive: true, force: true });
  fs.mkdirSync(DESKTOP_AUTHORING_DIR, { recursive: true });
  bundleSdkForCli(DESKTOP_AUTHORING_DIR, esbuildRuntime);
  console.log(
    `[product] staged installed Agent authoring runtime -> ${rel(DESKTOP_AUTHORING_DIR)}`,
  );
}

function copySdkRuntimePackageForCli(
  stageRoot,
  packageName,
  resolvePaths = [SDK_DIR, ROOT],
) {
  const packageJson = require.resolve(`${packageName}/package.json`, {
    paths: resolvePaths,
  });
  const source = path.dirname(packageJson);
  const target = path.join(
    stageRoot,
    'node_modules',
    ...packageName.split('/'),
  );
  copyTree(source, target);
}

export function cliArchiveLayout(platform = process.platform) {
  const runtimeDirectory = 'runtime';
  return {
    launcherName: platform === 'win32' ? 'kungfu.cmd' : 'kungfu',
    runtimeDirectory,
    runtimeEntrypoint: `${runtimeDirectory}/${
      platform === 'win32' ? 'kungfu.exe' : 'kungfu'
    }`,
    pythonEntrypoint: `${runtimeDirectory}/python/${
      platform === 'win32' ? 'python.exe' : 'bin/python3'
    }`,
    compatibility: `${runtimeDirectory}/product-compatibility.json`,
  };
}

function writeCliLauncher(stageRoot, layout) {
  const output = path.join(stageRoot, layout.launcherName);
  fs.writeFileSync(output, cliLauncherContent(), 'utf8');
  if (!isWin) fs.chmodSync(output, 0o755);
  return layout.launcherName;
}

export function writeAuditableDemoBinaryMetadata(
  stageRoot,
  layout,
  platform = platformId(),
  artifactRoot = ROOT,
) {
  const binary = path.join(stageRoot, layout.launcherName);
  const runtime = path.join(stageRoot, layout.runtimeEntrypoint);
  const python = path.join(stageRoot, layout.pythonEntrypoint);
  const executableFiles = [binary, runtime, python];
  executableFiles.forEach(symlinks.materializeRegularFile);
  const metadata = {
    contract: 'kungfu.declarative-demo-binary/v1',
    platformId: platform,
    sha256: sha256File(binary),
    executableFiles: executableFiles.map((file) => ({
      path: path.relative(artifactRoot, file).split(path.sep).join('/'),
      sha256: sha256File(file).slice('sha256:'.length),
    })),
    runtimeDependencies: [],
  };
  fs.writeFileSync(
    path.join(stageRoot, 'auditable-demo-binary.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  return metadata;
}

function writeCliManifest(stageRoot, archiveName, layout) {
  const surfaceCatalog = readJson(CLI_SURFACE_CATALOG);
  const codexAppServerContract = readJson(
    path.join(stageRoot, CODEX_APP_SERVER_CONTRACT_FILE),
  );
  const update = fs.existsSync(RELEASE_CHANNEL_TRUST)
    ? {
        channels: {
          alpha: productReleaseChannelConfig(
            readJson(RELEASE_CHANNEL_TRUST),
            'alpha',
          ),
        },
      }
    : undefined;
  if (!update && process.env.KUNGFU_REQUIRE_RELEASE_CHANNEL_TRUST === '1') {
    throw new Error(
      `release channel trust is required: ${RELEASE_CHANNEL_TRUST}`,
    );
  }
  fs.writeFileSync(
    path.join(stageRoot, 'product.json'),
    `${JSON.stringify(
      {
        schema: 'kungfu.product.cli/v1',
        product: 'cli',
        platform: platformId(),
        archive: archiveName,
        install: {
          source: 'archive',
          frontendAuthority: 'archive-updater',
          runtimeAuthority: 'kungfu-core-runtime-upgrade-controller',
          backgroundUpdater: false,
        },
        ...(update ? { update } : {}),
        cliSurface: {
          catalogRoot: surfaceCatalog.catalogRoot,
          surfaceRoot: surfaceCatalog.surfaceRoot,
          contractRoot: surfaceCatalog.contractRoot,
          registryRoot: surfaceCatalog.registryRoot,
        },
        entries: {
          kungfu: layout.launcherName,
          runtime: layout.runtimeEntrypoint,
          compatibility: layout.compatibility,
          sdk: 'sdk/sdk.js',
          sdkPackage: 'sdk/package.json',
          action: 'action/action.mjs',
          actionManifest: 'action/manifest.json',
          actionContract: 'action/action.contract.json',
          actionCliTopology: 'action/cli-topology.contract.json',
          actionResponseSchema: 'action/action-response.schema.json',
          actionMigrationMap: 'action/migration-map.json',
          xinfaProductContract: 'xinfa/contract/xinfa-product-v2.json',
          xinfaVerificationEngine: 'xinfa/engine/xinfa.wasm',
          xinfaVerificationManifest: 'xinfa/engine/manifest.json',
          kfd3Registry: 'kfd/kfd-3-surfaces.json',
          kfdUpstreamAggregate: 'kfd/upstream-aggregate.json',
          kfdPackage: 'node_modules/@kungfu-tech/kfd/package.json',
          kfdEntry: 'node_modules/@kungfu-tech/kfd/bin/kfd.mjs',
          kfdAgentHubRunner:
            'node_modules/@kungfu-tech/kfd/scripts/agent-hub-runner.mjs',
          kfdAgentHubVerifier:
            'node_modules/@kungfu-tech/kfd/scripts/agent-hub-report-verifier.mjs',
          kfdAgentRuntime: `runtime/${isWin ? 'kungfu-kfd-agent-runtime.exe' : 'kungfu-kfd-agent-runtime'}`,
          kfdAgentRuntimeManifest: 'runtime/kfd-agent-runtime.manifest.json',
          tui: 'tui/tui.mjs',
          agentSessionContract: AGENT_SESSION_CONTRACT_FILE,
          codexAppServerContract: CODEX_APP_SERVER_CONTRACT_FILE,
          codexAppServerSchemaManifest:
            codexAppServerContract.surfacePin.schemaManifest,
          extensions: 'extensions',
          templates: 'templates',
          upgradeManifest: 'upgrade/kungfu-release-manifest.json',
        },
      },
      null,
      2,
    )}\n`,
  );
}

export function cliArchiveBase(platform) {
  return `${CLI_ARCHIVE_PREFIX}-${platform}`;
}

function assertFile(file, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`${label} not found: ${file}`);
  }
}

function assertDirectory(dir, label) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`${label} not found: ${dir}`);
  }
}

function entryPath(installRoot, entries, key) {
  const entry = entries?.[key];
  if (!entry) throw new Error(`CLI product manifest missing entries.${key}`);
  return path.join(installRoot, ...entry.split('/'));
}

function listInstalledKfxPackages(extensionsRoot) {
  const names = new Set();
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      const pkgPath = path.join(full, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = readJson(pkgPath);
        if (pkg.name && isKfxPackageName(pkg.name)) {
          names.add(pkg.name);
        }
      }
      visit(full);
    }
  };
  visit(extensionsRoot);
  return names;
}

function assertSameSet(label, expected, actual) {
  const missing = [...expected].filter((name) => !actual.has(name)).sort();
  const stale = [...actual].filter((name) => !expected.has(name)).sort();
  if (missing.length || stale.length) {
    throw new Error(
      [
        `${label} mismatch`,
        missing.length ? `missing: ${missing.join(', ')}` : '',
        stale.length ? `stale: ${stale.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
}

function listRelativeFiles(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile())
        files.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  visit(root);
  return files.sort();
}

export function runInstalledKungfuAssignmentAdmissionSmoke({
  installRoot,
  kungfuBin,
  env,
  run = runInstalledKungfu,
}) {
  const home = path.join(installRoot, '.assignment-admission-home');
  const userHome = path.join(installRoot, '.assignment-admission-user-home');
  const workspace = path.join(installRoot, 'assignment-admission-workspace');
  const requestPath = path.join(
    installRoot,
    'assignment-admission-request.json',
  );
  const initiativeId = 'installed-product-qualification';
  const assignmentId = 'installed-product-admission-smoke';
  const retentionPolicy = 'explicit-expiry-retain-bytes-v1';
  const assignmentEnv = {
    ...env,
    HOME: userHome,
    USERPROFILE: userHome,
  };
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(
    requestPath,
    `${JSON.stringify(
      {
        schema: 'kungfu.assignment-request/v1',
        source: { kind: initiativeId, sourceId: assignmentId },
        retention: { policy: retentionPolicy, expiresAt: null },
        workDefinition: {
          goal_id: assignmentId,
          assignment_id: assignmentId,
          mission_id: initiativeId,
          initiative_id: initiativeId,
          title: 'Verify installed Assignment admission',
          objective: 'Prove the packaged Work Control Suite is closed.',
          owner_agent: 'product-qualification',
          responsibility: 'installed product regression',
        },
      },
      null,
      2,
    )}\n`,
  );
  const captured = parseJsonOutput(
    run({
      kungfuBin,
      installRoot,
      home,
      args: [
        'work',
        'capture',
        '--request',
        requestPath,
        '--workspace',
        workspace,
        '--json',
      ],
      env: assignmentEnv,
    }),
    'work capture',
  );
  const admitted = parseJsonOutput(
    run({
      kungfuBin,
      installRoot,
      home,
      args: [
        'work',
        'admit',
        captured.requestPath,
        '--workspace',
        workspace,
        '--initiative-id',
        initiativeId,
        '--assignment-id',
        assignmentId,
        '--actor',
        'product-qualification',
        '--actor-type',
        'agent',
      ],
      env: assignmentEnv,
    }),
    'work admit',
  );
  if (
    admitted.admitted !== true ||
    admitted.status !== 'admitted' ||
    admitted.next_actions?.[0]?.input?.assignment_id !== assignmentId ||
    !admitted.assignment_receipt?.receipt?.episode_id
  ) {
    throw new Error(
      'installed kungfu Assignment admission returned invalid evidence',
    );
  }
}
export function smokeCliProductArchive({ archivePath, archiveBase }) {
  return buildchainLogger.spanSync(
    'product.cli.smoke',
    {
      phase: 'package',
      attributes: {
        archive: rel(archivePath),
      },
    },
    () => {
      const tempRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'kungfu-cli-product-smoke-'),
      );
      try {
        if (archivePath.endsWith('.zip')) {
          extractZip({ archiveFile: archivePath, targetDir: tempRoot });
        } else {
          extractTarGz({ archiveFile: archivePath, targetDir: tempRoot });
        }
        const installRoot = path.join(tempRoot, archiveBase);
        assertDirectory(installRoot, 'extracted CLI product root');
        const manifestPath = path.join(installRoot, 'product.json');
        assertFile(manifestPath, 'CLI product manifest');
        const manifest = readJson(manifestPath);
        if (manifest.schema !== 'kungfu.product.cli/v1') {
          throw new Error(`unexpected CLI product schema: ${manifest.schema}`);
        }
        if (manifest.product !== 'cli' || manifest.platform !== platformId()) {
          throw new Error('CLI product manifest does not match this platform');
        }

        const kungfuBin = entryPath(installRoot, manifest.entries, 'kungfu');
        const runtimeEntry = entryPath(
          installRoot,
          manifest.entries,
          'runtime',
        );
        const compatibility = entryPath(
          installRoot,
          manifest.entries,
          'compatibility',
        );
        const sdkEntry = entryPath(installRoot, manifest.entries, 'sdk');
        const sdkPackage = entryPath(
          installRoot,
          manifest.entries,
          'sdkPackage',
        );
        const actionEntry = entryPath(installRoot, manifest.entries, 'action');
        const actionManifest = entryPath(
          installRoot,
          manifest.entries,
          'actionManifest',
        );
        const actionContract = entryPath(
          installRoot,
          manifest.entries,
          'actionContract',
        );
        const actionCliTopology = entryPath(
          installRoot,
          manifest.entries,
          'actionCliTopology',
        );
        const actionResponseSchema = entryPath(
          installRoot,
          manifest.entries,
          'actionResponseSchema',
        );
        const actionMigrationMap = entryPath(
          installRoot,
          manifest.entries,
          'actionMigrationMap',
        );
        const xinfaProductContract = entryPath(
          installRoot,
          manifest.entries,
          'xinfaProductContract',
        );
        const xinfaVerificationEngine = entryPath(
          installRoot,
          manifest.entries,
          'xinfaVerificationEngine',
        );
        const xinfaVerificationManifest = entryPath(
          installRoot,
          manifest.entries,
          'xinfaVerificationManifest',
        );
        const kfd3Registry = entryPath(
          installRoot,
          manifest.entries,
          'kfd3Registry',
        );
        const kfdUpstreamAggregate = entryPath(
          installRoot,
          manifest.entries,
          'kfdUpstreamAggregate',
        );
        const kfdPackage = entryPath(
          installRoot,
          manifest.entries,
          'kfdPackage',
        );
        const kfdEntry = entryPath(installRoot, manifest.entries, 'kfdEntry');
        const kfdAgentHubRunner = entryPath(
          installRoot,
          manifest.entries,
          'kfdAgentHubRunner',
        );
        const kfdAgentHubVerifier = entryPath(
          installRoot,
          manifest.entries,
          'kfdAgentHubVerifier',
        );
        const kfdAgentRuntime = entryPath(
          installRoot,
          manifest.entries,
          'kfdAgentRuntime',
        );
        const kfdAgentRuntimeManifest = entryPath(
          installRoot,
          manifest.entries,
          'kfdAgentRuntimeManifest',
        );
        const tuiEntry = entryPath(installRoot, manifest.entries, 'tui');
        const agentSessionContract = entryPath(
          installRoot,
          manifest.entries,
          'agentSessionContract',
        );
        const codexAppServerContract = entryPath(
          installRoot,
          manifest.entries,
          'codexAppServerContract',
        );
        const codexAppServerSchemaManifest = entryPath(
          installRoot,
          manifest.entries,
          'codexAppServerSchemaManifest',
        );
        const extensionsRoot = entryPath(
          installRoot,
          manifest.entries,
          'extensions',
        );
        const templatesRoot = entryPath(
          installRoot,
          manifest.entries,
          'templates',
        );
        const upgradeManifest = entryPath(
          installRoot,
          manifest.entries,
          'upgradeManifest',
        );
        assertFile(kungfuBin, 'installed kungfu runtime');
        assertFile(runtimeEntry, 'installed assembled runtime entry');
        assertFile(upgradeManifest, 'installed product upgrade manifest');
        const upgradeIdentity = readJson(upgradeManifest);
        if (upgradeIdentity.schema !== 'kungfu.product-upgrade.manifest/v1') {
          throw new Error(
            `unexpected product upgrade schema: ${upgradeIdentity.schema}`,
          );
        }
        assertFile(compatibility, 'installed compatibility manifest');
        assertFile(sdkEntry, 'installed Kungfu SDK entry');
        assertFile(sdkPackage, 'installed Kungfu SDK package metadata');
        assertFile(actionEntry, 'installed Action entry');
        assertFile(actionManifest, 'installed Action package manifest');
        assertFile(actionContract, 'installed Action contract');
        assertFile(actionCliTopology, 'installed Action CLI topology');
        assertFile(actionResponseSchema, 'installed Action response schema');
        assertFile(actionMigrationMap, 'installed Action migration map');
        assertFile(xinfaProductContract, 'installed Xinfa product contract');
        assertFile(
          xinfaVerificationEngine,
          'installed Xinfa verification engine',
        );
        assertFile(
          xinfaVerificationManifest,
          'installed Xinfa verification manifest',
        );
        assertFile(kfd3Registry, 'installed KFD-3 registry');
        assertFile(kfdUpstreamAggregate, 'installed KFD upstream aggregate');
        assertFile(kfdPackage, 'installed KFD package metadata');
        assertFile(kfdEntry, 'installed KFD executable');
        assertFile(kfdAgentHubRunner, 'installed KFD Agent Hub runner');
        assertFile(kfdAgentHubVerifier, 'installed KFD Agent Hub verifier');
        assertFile(kfdAgentRuntime, 'installed KFD Agent Runtime adapter');
        assertFile(
          kfdAgentRuntimeManifest,
          'installed KFD Agent Runtime manifest',
        );
        assertFile(tuiEntry, 'installed TUI entry');
        assertFile(agentSessionContract, 'installed Agent Session contract');
        assertFile(
          codexAppServerContract,
          'installed Codex App Server contract',
        );
        assertFile(
          codexAppServerSchemaManifest,
          'installed Codex App Server schema manifest',
        );
        const installedCodexContract = readJson(codexAppServerContract);
        if (
          path.resolve(
            installRoot,
            installedCodexContract.surfacePin?.schemaManifest ?? '',
          ) !== path.resolve(codexAppServerSchemaManifest)
        ) {
          throw new Error(
            'CLI product manifest Codex schema entry drifted from its contract',
          );
        }
        assertDirectory(extensionsRoot, 'installed kfx extensions');
        assertDirectory(templatesRoot, 'installed SDK templates');

        assertSameSet(
          'installed kfx package set',
          productKfxDeclarations(),
          listInstalledKfxPackages(extensionsRoot),
        );

        const forbidden = listRelativeFiles(installRoot).filter((file) =>
          /(^|\/)(electron|@kungfu-tech\/gui)(\/|$)/i.test(file),
        );
        if (forbidden.length) {
          throw new Error(
            `CLI archive contains GUI/Electron entries: ${forbidden.join(', ')}`,
          );
        }
        const publicXinfaLaunchers = fs
          .readdirSync(installRoot, { withFileTypes: true })
          .filter(
            (entry) =>
              entry.isFile() && /^xinfa(?:\.exe|\.cmd)?$/i.test(entry.name),
          );
        if (publicXinfaLaunchers.length) {
          throw new Error('CLI archive exposes a second public Xinfa launcher');
        }
        const packagedXinfaEngines = listRelativeFiles(installRoot).filter(
          (file) => /(^|\/)xinfa-engine(?:\.exe)?$/i.test(file),
        );
        if (packagedXinfaEngines.length) {
          throw new Error(
            `CLI archive contains a standalone Xinfa engine: ${packagedXinfaEngines.join(', ')}`,
          );
        }

        const smokeEnv = {
          ...process.env,
          KUNGFU_SDK_ENTRY: sdkEntry,
          KUNGFU_KFD3_REGISTRY: kfd3Registry,
          KUNGFU_KFD_UPSTREAM_AGGREGATE: kfdUpstreamAggregate,
          KUNGFU_KFD_AGENT_RUNTIME_ADAPTER: kfdAgentRuntime,
          KUNGFU_KFD_AGENT_RUNTIME_MANIFEST: kfdAgentRuntimeManifest,
          KF_BUNDLED_EXTENSION_ROOT: extensionsRoot,
          KUNGFU_ACTION_ENTRY: actionEntry,
          KUNGFU_CONTROLLER_ENTRYPOINT: runtimeEntry,
        };
        runInstalledKungfuXinfaSmoke({
          installRoot,
          kungfuBin,
          env: smokeEnv,
        });
        runInstalledActionPrimitiveDiscovery({
          installRoot,
          kungfuBin,
          env: smokeEnv,
        });
        runInstalledKungfuAssignmentAdmissionSmoke({
          installRoot,
          kungfuBin,
          env: smokeEnv,
        });
        runInstalledKungfuActionSmoke({
          installRoot,
          kungfuBin,
          actionEntry,
          env: smokeEnv,
        });
        runInstalledKungfuKfdSmoke({
          installRoot,
          kungfuBin,
          sdkEntry,
          kfd3Registry,
          kfdUpstreamAggregate,
          extensionsRoot,
          env: smokeEnv,
        });
        runInstalledKungfuAgentHubSmoke({
          installRoot,
          kungfuBin,
          env: smokeEnv,
        });
        runInstalledEmbeddedNodeAddonSmoke({
          installRoot,
          runtimeEntry,
          env: smokeEnv,
        });
        runInstalledTuiBootstrapSmoke({
          installRoot,
          kungfuBin,
          runtimeEntry,
          tuiEntry,
          env: smokeEnv,
        });
        runInstalledCliSemanticSmoke({
          installRoot,
          kungfuBin,
          env: smokeEnv,
        });
        runInstalledKfxWebhookAuthoringQualification({
          installRoot,
          kungfuBin,
          env: smokeEnv,
          authorityFactory: (packageRoot, declaredCapabilities) =>
            qualificationAuthority(ROOT, packageRoot, declaredCapabilities),
          removalAuthorityFactory: removalAuthority,
          reportPath: path.join(
            RELEASE_DIR,
            'qualification',
            'kfx-webhook-installed-agent',
            `${process.platform}-${process.arch}.json`,
          ),
          artifactIdentity: {
            archive: path.basename(archivePath),
            archiveRoot: sha256File(archivePath),
            sourceCommit: upgradeIdentity.sourceCommit,
          },
        });
        const platformVerification =
          verifyDarwinCliExecutableLayout(installRoot);
        const qualification = qualifyCliSurface({
          cli: kungfuBin,
          expectedCatalog: readJson(CLI_SURFACE_CATALOG),
          label: 'cli-archive',
          identity: {
            archive: path.basename(archivePath),
            archiveSha256: sha256File(archivePath),
            sourceCommit: upgradeIdentity.sourceCommit,
            ...(platformVerification ? { platformVerification } : {}),
          },
          environment: smokeEnv,
          runCommand: runInstalledKungfuCommand,
        });
        if (
          JSON.stringify(manifest.cliSurface) !==
          JSON.stringify(qualification.roots)
        ) {
          throw new Error('CLI product manifest surface roots drifted');
        }
        console.log('[product] CLI installed-layout smoke passed');
        return qualification;
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );
}

function buildCliProduct(esbuildRuntime) {
  buildchainLogger.spanSync(
    'product.cli.archive',
    {
      phase: 'package',
      attributes: {
        platform: platformId(),
        output: rel(CLI_RELEASE_DIR),
      },
    },
    () => {
      const platform = platformId();
      const archiveBase = cliArchiveBase(platform);
      const archiveName = isWin
        ? `${archiveBase}.zip`
        : `${archiveBase}.tar.gz`;
      const stageRoot = path.join(CLI_DIST_DIR, archiveBase);
      const archivePath = path.join(CLI_RELEASE_DIR, archiveName);
      const layout = cliArchiveLayout();

      assertSafeGeneratedDir(CLI_DIST_DIR);
      assertSafeGeneratedDir(CLI_RELEASE_DIR);
      fs.rmSync(CLI_DIST_DIR, { recursive: true, force: true });
      fs.rmSync(CLI_RELEASE_DIR, { recursive: true, force: true });
      fs.mkdirSync(stageRoot, { recursive: true });
      fs.mkdirSync(CLI_RELEASE_DIR, { recursive: true });

      copyTree(CORE_DIST, path.join(stageRoot, layout.runtimeDirectory));
      copyTree(ASSEMBLED_EXTENSIONS, path.join(stageRoot, 'extensions'));
      copyTree(path.join(TUI_DIR, 'dist'), path.join(stageRoot, 'tui'));
      stageNodePtyForCli(
        fs.realpathSync(
          path.join(AGENT_SESSION_DIR, 'node_modules', 'node-pty'),
        ),
        path.join(stageRoot, 'tui', 'node_modules', 'node-pty'),
      );
      stageAgentSessionContractsForCli(stageRoot);
      bundleSdkForCli(stageRoot, esbuildRuntime);
      const bundledUpgradeManifest = buildCliUpgradeManifest({
        stageRoot,
        layout,
      });
      const bundledUpgradePath = path.join(
        stageRoot,
        'upgrade',
        'kungfu-release-manifest.json',
      );
      fs.mkdirSync(path.dirname(bundledUpgradePath), { recursive: true });
      fs.writeFileSync(
        bundledUpgradePath,
        `${JSON.stringify(bundledUpgradeManifest, null, 2)}\n`,
        'utf8',
      );
      writeCliLauncher(stageRoot, layout);
      writeAuditableDemoBinaryMetadata(stageRoot, layout);
      writeCliManifest(stageRoot, archiveName, layout);

      if (isWin) {
        writeZip({ sourceDir: CLI_DIST_DIR, outputFile: archivePath });
      } else {
        writeTarGz({ sourceDir: CLI_DIST_DIR, outputFile: archivePath });
      }
      const qualification = smokeCliProductArchive({
        archivePath,
        archiveBase,
      });
      fs.writeFileSync(
        path.join(CLI_RELEASE_DIR, `${archiveBase}.qualification.json`),
        `${JSON.stringify(qualification, null, 2)}\n`,
      );
      const outputName = platformUpgradeManifestName(
        bundledUpgradeManifest.productVersion,
        process.platform,
        process.arch,
      );
      const desktopManifestPath = path.join(DESKTOP_DIST_DIR, outputName);
      const releaseBase =
        wantsDesktop() && fs.existsSync(desktopManifestPath)
          ? readJson(desktopManifestPath)
          : bundledUpgradeManifest;
      const tag = `v${bundledUpgradeManifest.productVersion}`;
      const artifactUrl =
        process.env.KF_CLI_ARTIFACT_URL ||
        `https://github.com/kungfu-systems/kungfu/releases/download/${tag}/${encodeURIComponent(archiveName)}`;
      const combinedManifestPath = path.join(CLI_RELEASE_DIR, outputName);
      finalizeCliUpgradeManifest({
        bundledManifest: releaseBase,
        embeddedManifest: bundledUpgradeManifest,
        cliArtifact: archivePath,
        artifactUrl,
        output: combinedManifestPath,
      });
      if (wantsDesktop()) {
        fs.copyFileSync(combinedManifestPath, desktopManifestPath);
        fs.copyFileSync(
          combinedManifestPath,
          path.join(DESKTOP_RELEASE_DIR, outputName),
        );
      }
      console.log(`[product] CLI archive -> ${rel(archivePath)}`);
    },
  );
}

function main() {
  assertSupportedProductHost();
  runProductAssembly({
    productTarget,
    builderArgs,
    logger: buildchainLogger,
    paths: {
      root: ROOT,
      productDir: PRODUCT_DIR,
      guiDir: GUI_DIR,
      tuiDir: TUI_DIR,
      sdkDir: SDK_DIR,
      runtimePins: RUNTIME_PINS,
      extensionsRoot: EXTENSIONS_ROOT,
      assembledExtensions: ASSEMBLED_EXTENSIONS,
      releaseDir: RELEASE_DIR,
      npmReleaseDir: NPM_RELEASE_DIR,
      compatibilityManifest: COMPATIBILITY_MANIFEST,
    },
    operations: {
      assertCoreAssembled,
      assertDeclaredKfx,
      assertKfxBundleExternals,
      assembleKfx,
      buildCliProduct,
      buildKfx,
      buildchainSourceBuildEnv,
      ensureEsbuildRuntime,
      finalizeDesktopReleaseManifest,
      guiEsbuildPackagePaths,
      installArgs,
      listKfxPackages,
      readTrunkRuntimePinSnapshot,
      rel,
      run,
      runPnpm,
      stageDesktopAuthoringRuntime,
      stageDesktopRelease,
      stageTrunk,
      writeCompatibilityManifest,
    },
  });
}

export function verifyProductObservabilityEvents(events, target = 'all') {
  const requiredEvents = [
    'product.dist.start',
    'product.kfx.dependencies.declared',
    'product.dependencies.sync.start',
    'product.core.rebuild.start',
    'product.core.freeze.start',
    'product.core.npm.pack.start',
    'product.dist.end',
  ];
  if (target === 'all' || target === 'desktop') {
    requiredEvents.push('product.desktop.electron-builder.start');
  }
  if (target === 'all' || target === 'cli') {
    requiredEvents.push('product.cli.archive.start');
    requiredEvents.push('product.cli.smoke.start');
  }
  return verifyBuildchainLogEvents({
    events: events.filter((event) => event.component === 'kungfu-product'),
    minEvents: 12,
    requireComponents: ['kungfu-product'],
    requirePhases: [
      'prepare',
      'dependencies',
      'core',
      'extensions',
      'ui',
      'package',
    ],
    requireEvents: requiredEvents,
  });
}

function verifyObservability() {
  if (!buildchainLogger.path) {
    return;
  }
  const report = verifyProductObservabilityEvents(
    // The persisted Buildchain log is shared by lifecycle processes and may
    // survive a failed self-hosted runner job. Verify only this product
    // invocation's events so an earlier run cannot poison a clean retry.
    buildchainLogger.events,
    productTarget,
  );
  if (!report.ok) {
    throw new Error(
      `Buildchain observability verification failed: ${report.issues
        .map((issue) => issue.message)
        .join('; ')}`,
    );
  }
  console.log(
    `[product] buildchain observability events: ${report.summary.components['kungfu-product']?.count ?? 0}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    main();
    verifyObservability();
  } catch (error) {
    console.error(
      `[product] failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
