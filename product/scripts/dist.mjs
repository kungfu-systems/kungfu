// SPDX-License-Identifier: Apache-2.0
// Build distributable Kungfu products from source in one command:
// dependency sync -> core rebuild -> freeze -> all declared first-party kfx ->
// product assembly -> TUI bundle -> desktop installer and/or CLI archive under
// product/release.
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
import { extractTarGz, extractZip, writeTarGz, writeZip } from './archive.mjs';
import { cliLauncherContent } from './cli-launcher.mjs';
import { qualifyCliSurface } from './cli-surface-qualification.mjs';
import { writeCompatibilityManifest } from './compatibility.mjs';
import {
  assertLibwasmArtifact,
  runLibwasmArtifactSelfTest,
  runLibwasmExecutionQualification,
} from './libwasm-artifact.mjs';
import {
  buildBundledUpgradeManifest,
  finalizeCliUpgradeManifest,
  finalizeDesktopUpgradeManifest,
  platformUpgradeManifestName,
} from './upgrade-manifest.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PRODUCT_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(PRODUCT_DIR, '..');
const GUI_DIR = path.join(ROOT, 'framework', 'gui');
const TUI_DIR = path.join(ROOT, 'framework', 'tui');
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
const CLI_ARCHIVE_PREFIX = 'kungfu-episodes-cli';
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
    'win32-x64': '@kungfu-tech/libnode-win32-x64',
  };
  return packages[`${process.platform}-${process.arch}`];
}

function rollupPlatformPackageName() {
  const libc = linuxLibc();
  const packages = {
    'darwin-arm64': '@rollup/rollup-darwin-arm64',
    'darwin-x64': '@rollup/rollup-darwin-x64',
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

function installArgs() {
  const args = ['install', '--frozen-lockfile'];
  if (process.env.KUNGFU_BUILDCHAIN_NO_OPTIONAL === '1') {
    args.push('--no-optional');
  }
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

function listKfxPackages() {
  const packages = [];
  const visit = (dir, depth) => {
    if (depth > 2 || !fs.existsSync(dir)) return;
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = readJson(pkgPath);
      if (pkg?.name && pkg?.kungfuConfig) {
        packages.push({
          name: pkg.name,
          dir,
          relDir: path.relative(EXTENSIONS_ROOT, dir),
          config: pkg.kungfuConfig,
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

function productKfxDependencies() {
  const pkg = readJson(path.join(PRODUCT_DIR, 'package.json'));
  return new Set(
    Object.keys(pkg.dependencies || {}).filter((name) =>
      name.startsWith('@kungfu-tech/kfx-'),
    ),
  );
}

function assertDeclaredKfx(packages) {
  const declared = productKfxDependencies();
  const actual = new Set(packages.map((pkg) => pkg.name));
  const missing = [...actual].filter((name) => !declared.has(name)).sort();
  const stale = [...declared].filter((name) => !actual.has(name)).sort();
  if (missing.length || stale.length) {
    throw new Error(
      [
        'product/package.json must declare every first-party kfx dependency',
        missing.length ? `missing: ${missing.join(', ')}` : '',
        stale.length ? `stale: ${stale.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  console.log(`[product] declared kfx dependencies: ${packages.length}`);
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
        base === '__pycache__' ||
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
    runPnpm(`build kfx ${pkg.name}`, ['--filter', pkg.name, 'run', 'build'], {
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

export function desktopUpdaterArtifact(files, platform = process.platform) {
  const suffix = {
    darwin: '.zip',
    win32: '.exe',
    linux: '.AppImage',
  }[platform];
  if (!suffix) throw new Error(`unsupported desktop platform: ${platform}`);
  const matches = files
    .filter((file) => file.endsWith(suffix))
    .sort((left, right) => left.localeCompare(right));
  if (matches.length !== 1) {
    throw new Error(
      `expected one ${platform} desktop updater artifact, found: ${matches.join(', ') || 'none'}`,
    );
  }
  return matches[0];
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
    artifactUrl,
    output: path.join(DESKTOP_DIST_DIR, outputName),
  });
  console.log(
    `[product] desktop upgrade manifest -> ${rel(path.join(DESKTOP_DIST_DIR, outputName))} (${manifest.qualificationEvidenceRef})`,
  );
  return manifest;
}

function assertCoreFrozen() {
  const kungfuBin = path.join(CORE_DIST, isWin ? 'kungfu.exe' : 'kungfu');
  if (!fs.existsSync(kungfuBin)) {
    throw new Error(`freeze did not produce ${rel(kungfuBin)}`);
  }
  // Assembled form (ADR-0046 stage 2): when the dist carries the interpreter
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

// ADR-0046 stage 1: kungfu-trunk (the product trunk carrying the kungfu-owned
// env/package surface) ships next to the frozen binary, together with its
// runtime-pins manifest. UV_VERSION in the manifest must equal the repo's
// .uv-version so the product and the dev launcher pull the same pinned uv.
function stageTrunk() {
  // ADR-0046 stage 3 productionization: link the embedding membrane and ship the
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
  const uvPin = (fs
    .readFileSync(RUNTIME_PINS, 'utf8')
    .match(/^UV_VERSION=(.+)$/m) || [])[1]?.trim();
  const repoPin = fs
    .readFileSync(path.join(ROOT, '.uv-version'), 'utf8')
    .trim();
  if (uvPin !== repoPin) {
    throw new Error(
      `runtime-pins.env pins uv ${uvPin} but .uv-version pins ${repoPin}; update product/runtime-pins.env (version and checksums) alongside .uv-version`,
    );
  }
  fs.copyFileSync(trunkBin, path.join(CORE_DIST, path.basename(trunkBin)));
  fs.copyFileSync(RUNTIME_PINS, path.join(CORE_DIST, 'runtime-pins.env'));
  console.log(
    '[product] kungfu-trunk + runtime-pins.env staged into core dist',
  );
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

function copyTree(source, target, options = {}) {
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
      return ![
        'node_modules',
        'build',
        '.venv',
        '__pycache__',
        '.DS_Store',
      ].includes(base);
    },
  });
  return true;
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
    compatibility: `${runtimeDirectory}/product-compatibility.json`,
  };
}

function writeCliLauncher(stageRoot, layout) {
  const output = path.join(stageRoot, layout.launcherName);
  fs.writeFileSync(output, cliLauncherContent(), 'utf8');
  if (!isWin) fs.chmodSync(output, 0o755);
  return layout.launcherName;
}

function writeCliManifest(stageRoot, archiveName, layout) {
  const surfaceCatalog = readJson(CLI_SURFACE_CATALOG);
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
          kfdAgentRuntime: `runtime/${isWin ? 'kungfu-kfd-agent-runtime.exe' : 'kungfu-kfd-agent-runtime'}`,
          kfdAgentRuntimeManifest: 'runtime/kfd-agent-runtime.manifest.json',
          tui: 'tui/tui.mjs',
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
        if (pkg.name?.startsWith('@kungfu-tech/kfx-')) {
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

export function runInstalledKungfu({
  kungfuBin,
  installRoot,
  home,
  args,
  env,
}) {
  const result = spawnInstalledKungfu(kungfuBin, ['-H', home, ...args], {
    cwd: installRoot,
    env,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `installed kungfu ${args.join(' ')} failed (exit ${exitLabel(result.status, result.signal)})`,
        result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : '',
        result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  return result.stdout || '';
}

export function installedKungfuInvocation(
  kungfuBin,
  args,
  { platform = process.platform, comspec = process.env.ComSpec } = {},
) {
  if (platform !== 'win32') {
    return { command: kungfuBin, args };
  }
  return {
    command: comspec || 'cmd.exe',
    args: ['/d', '/s', '/c', 'call', kungfuBin, ...args],
  };
}

export function runInstalledKungfuCommand(
  { cli, args, env, cwd },
  {
    platform = process.platform,
    comspec = process.env.ComSpec,
    spawn = spawnSync,
  } = {},
) {
  const invocation = installedKungfuInvocation(cli, args, {
    platform,
    comspec,
  });
  const result = spawn(invocation.command, invocation.args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
  if (result.error) throw result.error;
  return result;
}

function spawnInstalledKungfu(kungfuBin, args, options) {
  const invocation = installedKungfuInvocation(kungfuBin, args);
  return spawnSync(invocation.command, invocation.args, {
    ...options,
    shell: false,
  });
}

export function runInstalledCliSemanticSmoke({
  installRoot,
  kungfuBin,
  env,
  home = path.join(installRoot, '.qualification-home'),
}) {
  const episodeId = 49003;
  const exportPath = path.join(installRoot, 'episode-export.json');
  runInstalledKungfu({
    kungfuBin,
    installRoot,
    home,
    args: ['storage', 'layout', '--json'],
    env,
  });
  runInstalledKungfu({
    kungfuBin,
    installRoot,
    home,
    args: [
      'storage',
      'episode',
      'begin',
      '--episode-id',
      String(episodeId),
      '--source',
      'adr0049-cli',
      '--json',
    ],
    env,
  });
  runInstalledKungfu({
    kungfuBin,
    installRoot,
    home,
    args: [
      'storage',
      'episode',
      'heartbeat',
      '--episode-id',
      String(episodeId),
      '--note',
      'qualification',
      '--json',
    ],
    env,
  });
  runInstalledKungfu({
    kungfuBin,
    installRoot,
    home,
    args: [
      'storage',
      'episode',
      'end',
      '--episode-id',
      String(episodeId),
      '--reason',
      'qualified',
      '--json',
    ],
    env,
  });
  const query = parseJsonOutput(
    runInstalledKungfu({
      kungfuBin,
      installRoot,
      home,
      args: [
        'storage',
        'query',
        '--table',
        'episodes',
        '--scope',
        'all',
        '--json',
      ],
      env,
    }),
    'storage query',
  );
  if (!query.ok || query.row_count < 1)
    throw new Error('installed CLI query did not return the recorded Episode');
  const fsck = parseJsonOutput(
    runInstalledKungfu({
      kungfuBin,
      installRoot,
      home,
      args: [
        'storage',
        'fsck',
        '--scope',
        'episode',
        '--episode-id',
        String(episodeId),
        '--json',
      ],
      env,
    }),
    'storage fsck',
  );
  if (!fsck.ok)
    throw new Error('installed CLI fsck rejected the recorded Episode');
  runInstalledKungfu({
    kungfuBin,
    installRoot,
    home,
    args: [
      'storage',
      'export',
      '--scope',
      'episode',
      '--episode-id',
      String(episodeId),
      '--format',
      'bundle-json',
      '--out',
      exportPath,
      '--json',
    ],
    env,
  });
  assertFile(exportPath, 'installed CLI Episode export');
  const brief = runInstalledKungfu({
    kungfuBin,
    installRoot,
    home,
    args: ['agent', 'brief'],
    env,
  });
  if (!brief.trim()) throw new Error('installed CLI agent brief was empty');
  const mode = parseJsonOutput(
    runInstalledKungfu({
      kungfuBin,
      installRoot,
      home,
      args: ['agent', 'choose-mode', '--json'],
      env,
    }),
    'agent choose-mode',
  );
  if (!mode.mode)
    throw new Error('installed CLI agent discovery did not choose a mode');
  return { home, exportPath, episodeId };
}

function runInstalledKungfuKfdSmoke({
  installRoot,
  kungfuBin,
  sdkEntry,
  kfd3Registry,
  kfdUpstreamAggregate,
  extensionsRoot,
  env,
}) {
  const result = spawnInstalledKungfu(kungfuBin, ['kfd', 'status', '--json'], {
    cwd: installRoot,
    env: {
      ...env,
      KUNGFU_SDK_ENTRY: sdkEntry,
      KUNGFU_KFD3_REGISTRY: kfd3Registry,
      KUNGFU_KFD_UPSTREAM_AGGREGATE: kfdUpstreamAggregate,
      KF_FIRST_PARTY_SOURCE_ROOT: extensionsRoot,
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `installed kungfu kfd smoke failed (exit ${exitLabel(result.status, result.signal)})`,
        result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : '',
        result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  const data = parseJsonOutput(result.stdout || '', 'kungfu kfd status');
  if (data.contract !== 'kungfu-sdk-kfd-standards-status') {
    throw new Error(`unexpected kfd status contract: ${data.contract}`);
  }
  if (data.standards?.['kfd-3']?.status !== 'supported') {
    throw new Error('installed kungfu kfd status did not report KFD-3 support');
  }
  if (
    data.agentRuntime?.status !== 'available' ||
    data.agentRuntime?.profile?.id !== 'kfd-agent-runtime'
  ) {
    throw new Error(
      'installed kungfu kfd status did not discover the KFD Agent Runtime adapter',
    );
  }
}

function runInstalledKungfuActionSmoke({
  installRoot,
  kungfuBin,
  actionEntry,
  env,
}) {
  const poisonDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-action-node-poison-'),
  );
  const marker = path.join(poisonDir, 'system-node-used');
  const fakeNode = path.join(poisonDir, isWin ? 'node.cmd' : 'node');
  try {
    fs.writeFileSync(
      fakeNode,
      isWin
        ? `@echo off\r\n>"%KUNGFU_NODE_FALLBACK_MARKER%" echo fallback\r\nexit /b 99\r\n`
        : '#!/bin/sh\nprintf fallback > "$KUNGFU_NODE_FALLBACK_MARKER"\nexit 99\n',
      'utf8',
    );
    if (!isWin) fs.chmodSync(fakeNode, 0o755);
    const result = spawnInstalledKungfu(
      kungfuBin,
      ['action', 'contract', '--json'],
      {
        cwd: installRoot,
        env: {
          ...env,
          KUNGFU_ACTION_ENTRY: actionEntry,
          KUNGFU_NODE_FALLBACK_MARKER: marker,
          PATH: [poisonDir, process.env.PATH || '']
            .filter(Boolean)
            .join(path.delimiter),
        },
        encoding: 'utf8',
      },
    );
    if (result.status !== 0) {
      throw new Error(
        [
          `installed kungfu action smoke failed (exit ${exitLabel(result.status, result.signal)})`,
          result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : '',
          result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
    if (fs.existsSync(marker)) {
      throw new Error('installed kungfu action used PATH node fallback');
    }
    if (!(result.stdout || '').trim()) {
      throw new Error(
        [
          'installed kungfu action produced no stdout',
          result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
    const data = parseJsonOutput(result.stdout || '', 'kungfu action contract');
    if (
      data.schema !== 'kungfu.action.response/v1' ||
      data.host?.runtime !== 'embedded-libnode' ||
      data.host?.layout !== 'installed' ||
      !/^sha256:[0-9a-f]{64}$/.test(data.semanticRoot || '')
    ) {
      throw new Error(
        'installed kungfu action returned an invalid host contract',
      );
    }
  } finally {
    fs.rmSync(poisonDir, { recursive: true, force: true });
  }
}

function runInstalledKungfuXinfaSmoke({ installRoot, kungfuBin, env }) {
  const fixtureRoot = path.join(
    ROOT,
    'crates',
    'xinfa',
    'fixtures',
    'repository-small',
  );
  const project = path.join(fixtureRoot, 'project.json');
  const atlasOutput = path.join(installRoot, 'xinfa-smoke-atlas');
  const installed = spawnInstalledKungfu(
    kungfuBin,
    [
      'xinfa',
      'compile',
      '--project',
      project,
      '--root',
      fixtureRoot,
      '--output',
      atlasOutput,
      '--visibility',
      'public',
      '--json',
    ],
    {
      cwd: installRoot,
      env,
      encoding: 'utf8',
    },
  );
  if (installed.status !== 0) {
    throw new Error(
      `linked kungfu xinfa compile failed (exit ${exitLabel(installed.status, installed.signal)}): ${installed.stderr || ''}`,
    );
  }
  const verification = parseJsonOutput(
    runInstalledKungfu({
      kungfuBin,
      installRoot,
      home: path.join(installRoot, '.xinfa-smoke-home'),
      args: ['xinfa', 'verify', '--atlas', atlasOutput, '--json'],
      env,
    }),
    'kungfu xinfa verify',
  );
  if (verification.valid !== true || !verification.atlas_root) {
    throw new Error('installed kungfu xinfa did not verify its compiled Atlas');
  }

  const defaultWorkspace = path.join(installRoot, 'xinfa-default-workspace');
  fs.cpSync(fixtureRoot, defaultWorkspace, { recursive: true });
  fs.mkdirSync(path.join(defaultWorkspace, '.xinfa'), { recursive: true });
  fs.renameSync(
    path.join(defaultWorkspace, 'project.json'),
    path.join(defaultWorkspace, '.xinfa', 'project.json'),
  );
  const defaultCompile = parseJsonOutput(
    runInstalledKungfu({
      kungfuBin,
      installRoot,
      home: path.join(installRoot, '.xinfa-default-home'),
      args: ['xinfa', 'compile', '--workspace', defaultWorkspace],
      env,
    }),
    'bare kungfu xinfa compile',
  );
  if (
    !defaultCompile.atlas_root ||
    !fs.existsSync(path.join(defaultWorkspace, '.xinfa', 'atlas'))
  ) {
    throw new Error(
      'bare kungfu xinfa compile did not create the default Atlas',
    );
  }
}

function runInstalledActionPrimitiveDiscovery({ installRoot, kungfuBin, env }) {
  const briefHome = path.join(installRoot, '.brief-home-must-not-exist');
  const brief = runInstalledKungfu({
    kungfuBin,
    installRoot,
    home: briefHome,
    args: ['agent', 'brief'],
    env,
  });
  if (!brief.includes('kungfu xinfa compile')) {
    throw new Error(
      'installed Agent brief omitted the single-entry CLI topology',
    );
  }
  if (fs.existsSync(briefHome)) {
    throw new Error('kungfu agent brief initialized runtime state');
  }

  const roleHome = path.join(installRoot, '.role-discovery-home');
  for (const role of ['atlas', 'pursuit', 'warrant', 'episode']) {
    const capabilities = parseJsonOutput(
      runInstalledKungfu({
        kungfuBin,
        installRoot,
        home: roleHome,
        args: [role, 'capabilities', '--json'],
        env,
      }),
      `kungfu ${role} capabilities`,
    );
    if (
      capabilities.schema !== 'kungfu.action-primitive-role-capabilities/v1' ||
      capabilities.role !== role ||
      !capabilities.transitions?.length
    ) {
      throw new Error(`installed kungfu ${role} discovery is invalid`);
    }
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
        assertFile(kfdAgentRuntime, 'installed KFD Agent Runtime adapter');
        assertFile(
          kfdAgentRuntimeManifest,
          'installed KFD Agent Runtime manifest',
        );
        assertFile(tuiEntry, 'installed TUI entry');
        assertDirectory(extensionsRoot, 'installed kfx extensions');
        assertDirectory(templatesRoot, 'installed SDK templates');

        assertSameSet(
          'installed kfx package set',
          productKfxDependencies(),
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
          KF_FIRST_PARTY_SOURCE_ROOT: extensionsRoot,
          KUNGFU_ACTION_ENTRY: actionEntry,
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
        runInstalledCliSemanticSmoke({
          installRoot,
          kungfuBin,
          env: smokeEnv,
        });
        const qualification = qualifyCliSurface({
          cli: kungfuBin,
          expectedCatalog: readJson(CLI_SURFACE_CATALOG),
          label: 'cli-archive',
          identity: {
            archive: path.basename(archivePath),
            archiveSha256: sha256File(archivePath),
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
      bundleSdkForCli(stageRoot, esbuildRuntime);
      const bundledUpgradeManifest = buildBundledUpgradeManifest({
        root: ROOT,
        runtimeRoot: CORE_DIST,
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
  buildchainLogger.spanSync(
    'product.dist',
    {
      phase: 'package',
      attributes: {
        platform: process.platform,
        arch: process.arch,
        product: productTarget,
        builderArgCount: builderArgs.length,
      },
    },
    () => {
      const kfxPackages = buildchainLogger.spanSync(
        'product.kfx.discover',
        {
          phase: 'prepare',
          attributes: {
            root: rel(EXTENSIONS_ROOT),
          },
        },
        () => listKfxPackages(),
      );
      assertDeclaredKfx(kfxPackages);

      runPnpm('sync dependencies', installArgs(), {
        phase: 'dependencies',
        event: 'product.dependencies.sync',
      });
      const buildEnv = buildchainSourceBuildEnv();
      const sdkEsbuildRuntime = ensureEsbuildRuntime({
        slot: 'sdk',
        paths: [SDK_DIR, ROOT],
      });
      const tuiEsbuildRuntime = ensureEsbuildRuntime({
        slot: 'tui',
        paths: [TUI_DIR, ROOT],
      });
      const sdkBuildEnv = {
        ...buildEnv,
        ESBUILD_BINARY_PATH: sdkEsbuildRuntime.binaryPath,
      };
      const tuiBuildEnv = {
        ...buildEnv,
        ESBUILD_BINARY_PATH: tuiEsbuildRuntime.binaryPath,
      };
      runPnpm(
        'rebuild core',
        ['--filter', '@kungfu-tech/core', 'run', 'rebuild'],
        {
          env: buildEnv,
          phase: 'core',
          event: 'product.core.rebuild',
        },
      );
      runPnpm(
        'freeze core runtime',
        ['--filter', '@kungfu-tech/core', 'run', 'freeze'],
        {
          // The product must ship the native host; a missing one is a hard error
          // here rather than a silent fall back to the slow Python node path /
          // doctor stub (ADR-0046 S3). Dev `pnpm run freeze` leaves this unset and
          // keeps warn-only.
          env: { ...process.env, KF_REQUIRE_NATIVE_HOST: '1' },
          phase: 'core',
          event: 'product.core.freeze',
        },
      );
      assertCoreFrozen();
      stageTrunk();

      buildKfx(kfxPackages, sdkBuildEnv);
      assertKfxBundleExternals(kfxPackages);
      assembleKfx(kfxPackages);

      runPnpm('bundle tui', ['--filter', '@kungfu-tech/tui', 'run', 'bundle'], {
        env: tuiBuildEnv,
        phase: 'ui',
        event: 'product.tui.bundle',
      });
      if (wantsDesktop()) {
        const guiEsbuildRuntime = ensureEsbuildRuntime({
          slot: 'gui',
          paths: guiEsbuildPackagePaths(),
        });
        const guiBuildEnv = {
          ...buildEnv,
          ESBUILD_BINARY_PATH: guiEsbuildRuntime.binaryPath,
        };
        stageDesktopAuthoringRuntime(sdkEsbuildRuntime);
        runPnpm(
          'ensure electron',
          ['--filter', '@kungfu-tech/gui', 'run', 'ensure-electron'],
          {
            env: buildEnv,
            phase: 'ui',
            event: 'product.gui.ensure-electron',
          },
        );
        runPnpm('build gui', ['--filter', '@kungfu-tech/gui', 'run', 'build'], {
          env: guiBuildEnv,
          phase: 'ui',
          event: 'product.gui.build',
        });
        writeCompatibilityManifest({
          root: ROOT,
          output: COMPATIBILITY_MANIFEST,
          includeGui: true,
        });
        run(
          'electron-builder desktop product',
          process.execPath,
          [
            path.join(GUI_DIR, 'scripts', 'run-electron-builder.mjs'),
            `--config=${path.join(PRODUCT_DIR, 'electron-builder.yml')}`,
            ...builderArgs,
          ],
          {
            cwd: GUI_DIR,
            env: {
              ...sdkBuildEnv,
              KF_FIRST_PARTY_SOURCE_ROOT: ASSEMBLED_EXTENSIONS,
            },
            phase: 'package',
            event: 'product.desktop.electron-builder',
          },
        );
        finalizeDesktopReleaseManifest();
        stageDesktopRelease();
        // Build registration (for `shifu builds` / `shifu promote`) is not a
        // build step: the launcher reads the KFD-3 distribution declaration
        // and stashes the artifact after this task exits successfully.
      }
      if (wantsCli()) {
        if (!wantsDesktop()) {
          writeCompatibilityManifest({
            root: ROOT,
            output: COMPATIBILITY_MANIFEST,
            includeGui: false,
          });
        }
        buildCliProduct(sdkEsbuildRuntime);
      }

      console.log(`\n[product] output -> ${rel(RELEASE_DIR)}`);
    },
  );
}

export function verifyProductObservabilityEvents(events, target = 'all') {
  const requiredEvents = [
    'product.dist.start',
    'product.kfx.dependencies.declared',
    'product.dependencies.sync.start',
    'product.core.rebuild.start',
    'product.core.freeze.start',
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
