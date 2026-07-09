// SPDX-License-Identifier: Apache-2.0
// Build distributable Kungfu products from source in one command:
// dependency sync -> core rebuild -> freeze -> all declared first-party kfx ->
// product assembly -> TUI bundle -> desktop installer and/or CLI archive under
// product/release.
// Run through the repo entrypoint so Node is pinned:
//   ./kungfu-code dist

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createBuildchainLogger,
  verifyBuildchainLogEvents,
} from '@kungfu-tech/buildchain/logging';
import { writeTarGz, writeZip } from './archive.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PRODUCT_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(PRODUCT_DIR, '..');
const GUI_DIR = path.join(ROOT, 'framework', 'gui');
const TUI_DIR = path.join(ROOT, 'framework', 'tui');
const CORE_DIST = path.join(ROOT, 'framework', 'core', 'dist', 'kungfu');
const SDK_DIR = path.join(ROOT, 'developer', 'sdk');
const EXTENSIONS_ROOT = path.join(ROOT, 'extensions');
const ASSEMBLED_EXTENSIONS = path.join(PRODUCT_DIR, 'extensions');
const DIST_DIR = path.join(PRODUCT_DIR, 'dist');
const DESKTOP_DIST_DIR = path.join(DIST_DIR, 'desktop');
const CLI_DIST_DIR = path.join(DIST_DIR, 'cli');
const RELEASE_DIR = path.join(PRODUCT_DIR, 'release');
const DESKTOP_RELEASE_DIR = path.join(RELEASE_DIR, 'desktop');
const CLI_RELEASE_DIR = path.join(RELEASE_DIR, 'cli');
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
  if (!fs.existsSync(installedPackageJson)) {
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
        '--prefer-offline',
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

function assertCoreFrozen() {
  const kungfuBin = path.join(CORE_DIST, isWin ? 'kungfu.exe' : 'kungfu');
  if (!fs.existsSync(kungfuBin)) {
    throw new Error(`freeze did not produce ${rel(kungfuBin)}`);
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

function bundleSdkForCli(stageRoot) {
  const esbuild = require(
    require.resolve('esbuild', {
      paths: [TUI_DIR, GUI_DIR, ROOT],
    }),
  );
  const sdkOut = path.join(stageRoot, 'sdk', 'sdk.js');
  fs.mkdirSync(path.dirname(sdkOut), { recursive: true });
  esbuild.buildSync({
    entryPoints: [path.join(SDK_DIR, 'src', 'sdk.js')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: sdkOut,
    logLevel: 'silent',
  });
  copyTree(path.join(SDK_DIR, 'kfd'), path.join(stageRoot, 'kfd'));
  copyTree(path.join(SDK_DIR, 'templates'), path.join(stageRoot, 'templates'));
}

function writeCliManifest(stageRoot, archiveName) {
  fs.writeFileSync(
    path.join(stageRoot, 'product.json'),
    `${JSON.stringify(
      {
        schema: 'kungfu.product.cli/v1',
        product: 'cli',
        platform: platformId(),
        archive: archiveName,
        entries: {
          kungfu: isWin ? 'kungfu/kungfu.exe' : 'kungfu/kungfu',
          sdk: 'sdk/sdk.js',
          tui: 'tui/tui.mjs',
          extensions: 'extensions',
        },
      },
      null,
      2,
    )}\n`,
  );
}

function buildCliProduct() {
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
      const archiveBase = `kungfu-cli-${platform}`;
      const archiveName = isWin
        ? `${archiveBase}.zip`
        : `${archiveBase}.tar.gz`;
      const stageRoot = path.join(CLI_DIST_DIR, archiveBase);
      const archivePath = path.join(CLI_RELEASE_DIR, archiveName);

      assertSafeGeneratedDir(CLI_DIST_DIR);
      assertSafeGeneratedDir(CLI_RELEASE_DIR);
      fs.rmSync(CLI_DIST_DIR, { recursive: true, force: true });
      fs.rmSync(CLI_RELEASE_DIR, { recursive: true, force: true });
      fs.mkdirSync(stageRoot, { recursive: true });
      fs.mkdirSync(CLI_RELEASE_DIR, { recursive: true });

      copyTree(CORE_DIST, path.join(stageRoot, 'kungfu'));
      copyTree(ASSEMBLED_EXTENSIONS, path.join(stageRoot, 'extensions'));
      copyTree(path.join(TUI_DIR, 'dist'), path.join(stageRoot, 'tui'));
      bundleSdkForCli(stageRoot);
      writeCliManifest(stageRoot, archiveName);

      if (isWin) {
        writeZip({ sourceDir: CLI_DIST_DIR, outputFile: archivePath });
      } else {
        writeTarGz({ sourceDir: CLI_DIST_DIR, outputFile: archivePath });
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

      const buildEnv = buildchainSourceBuildEnv();
      runPnpm('sync dependencies', installArgs(), {
        phase: 'dependencies',
        event: 'product.dependencies.sync',
      });
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
          phase: 'core',
          event: 'product.core.freeze',
        },
      );
      assertCoreFrozen();

      buildKfx(kfxPackages, buildEnv);
      assembleKfx(kfxPackages);

      runPnpm('bundle tui', ['--filter', '@kungfu-tech/tui', 'run', 'bundle'], {
        env: buildEnv,
        phase: 'ui',
        event: 'product.tui.bundle',
      });
      if (wantsDesktop()) {
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
          env: buildEnv,
          phase: 'ui',
          event: 'product.gui.build',
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
              ...buildEnv,
              KF_FIRST_PARTY_SOURCE_ROOT: ASSEMBLED_EXTENSIONS,
            },
            phase: 'package',
            event: 'product.desktop.electron-builder',
          },
        );
        stageDesktopRelease();
      }
      if (wantsCli()) {
        buildCliProduct();
      }

      console.log(`\n[product] output -> ${rel(RELEASE_DIR)}`);
    },
  );
}

function verifyObservability() {
  if (!buildchainLogger.path) {
    return;
  }
  const requiredEvents = [
    'product.dist.start',
    'product.kfx.dependencies.declared',
    'product.dependencies.sync.start',
    'product.core.rebuild.start',
    'product.core.freeze.start',
    'product.dist.end',
  ];
  if (wantsDesktop()) {
    requiredEvents.push('product.desktop.electron-builder.start');
  }
  if (wantsCli()) {
    requiredEvents.push('product.cli.archive.start');
  }
  const report = verifyBuildchainLogEvents({
    path: buildchainLogger.path,
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

try {
  main();
  verifyObservability();
} catch (error) {
  console.error(
    `[product] failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
