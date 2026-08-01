// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const INTEL_MACOS_DIAGNOSTIC =
  'unsupported-host: Intel macOS (Darwin x86_64) is not supported by Kungfu';

const SUPPORTED_PRODUCT_TARGETS = new Set([
  'darwin/arm64',
  'linux/arm64',
  'linux/x64',
  'win32/x64',
]);

export const PLATFORM_DEPENDENCY_RUNTIME_OWNER =
  'product/release-assembly-runtime';

const PLATFORM_DEPENDENCY_PACKAGES = {
  libnode: {
    'darwin-arm64': '@kungfu-tech/libnode-darwin-arm64',
    'linux-x64': '@kungfu-tech/libnode-linux-x64',
    'linux-arm64': '@kungfu-tech/libnode-linux-arm64',
    'win32-x64': '@kungfu-tech/libnode-win32-x64',
  },
  rollup: {
    'darwin-arm64': '@rollup/rollup-darwin-arm64',
    'linux-arm64-gnu': '@rollup/rollup-linux-arm64-gnu',
    'linux-arm64-musl': '@rollup/rollup-linux-arm64-musl',
    'linux-x64-gnu': '@rollup/rollup-linux-x64-gnu',
    'linux-x64-musl': '@rollup/rollup-linux-x64-musl',
    'win32-arm64': '@rollup/rollup-win32-arm64-msvc',
    'win32-ia32': '@rollup/rollup-win32-ia32-msvc',
    'win32-x64': '@rollup/rollup-win32-x64-msvc',
  },
  esbuild: {
    'darwin-arm64': '@esbuild/darwin-arm64',
    'linux-x64': '@esbuild/linux-x64',
    'linux-arm64': '@esbuild/linux-arm64',
    'win32-x64': '@esbuild/win32-x64',
  },
};

export function platformDependencyPackageName(
  kind,
  { platform, architecture, libc = '' },
) {
  const suffix = kind === 'rollup' && libc ? `-${libc}` : '';
  return PLATFORM_DEPENDENCY_PACKAGES[kind]?.[
    `${platform}-${architecture}${suffix}`
  ];
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

// Explicit inputs keep package acquisition subordinate to product assembly:
// this owner selects and prepares platform dependencies, but cannot sequence,
// publish, or qualify a product on its own.
export function createPlatformDependencyRuntime({
  root,
  guiDir,
  readJson,
  run,
  logger,
  requireFn,
  env = process.env,
  platform = process.platform,
  architecture = process.arch,
  report = process.report,
}) {
  const platformIdentity = () => `${platform}-${architecture}`;
  const linuxLibc = () => {
    if (platform !== 'linux') return '';
    return report?.getReport?.()?.header?.glibcVersionRuntime ? 'gnu' : 'musl';
  };
  const platformPackage = (kind) =>
    platformDependencyPackageName(kind, {
      platform,
      architecture,
      libc: linuxLibc(),
    });
  const canResolve = (packageName, paths) => {
    try {
      requireFn.resolve(`${packageName}/package.json`, paths ? { paths } : {});
      return true;
    } catch {
      return false;
    }
  };
  const packageJsonPath = (nodePath, packageName) =>
    path.join(nodePath, ...packageName.split('/'), 'package.json');
  const rollupPaths = () => {
    const vite = requireFn.resolve('vite/package.json', { paths: [guiDir] });
    const viteDir = path.dirname(vite);
    const rollup = requireFn.resolve('rollup/package.json', {
      paths: [viteDir],
    });
    return [path.dirname(rollup), viteDir];
  };
  const appendNodePath = (baseEnv, nodePaths) => {
    const value = [...nodePaths, baseEnv.NODE_PATH || '']
      .filter(Boolean)
      .join(path.delimiter);
    return value ? { ...baseEnv, NODE_PATH: value } : baseEnv;
  };
  const ensurePackage = ({ kind, packageName, version, installRoot }) => {
    const nodePath = path.join(installRoot, 'node_modules');
    const packageJson = packageJsonPath(nodePath, packageName);
    const installed = fs.existsSync(packageJson)
      ? readJson(packageJson).version
      : undefined;
    if (installed !== version) {
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
          '--prefer-online',
          '--prefix',
          installRoot,
          `${packageName}@${version}`,
        ],
        {
          phase: 'dependencies',
          event: `product.${kind}.platform.install`,
          attributes: { packageName, version },
        },
      );
    } else {
      logger.mark(`product.${kind}.platform.cached`, {
        phase: 'dependencies',
        attributes: { packageName, version },
      });
    }
    logger.mark(`product.${kind}.platform.ready`, {
      phase: 'dependencies',
      attributes: { packageName, version },
    });
    return nodePath;
  };
  const ensureEsbuildRuntime = ({ slot, paths }) => {
    const packageJson = requireFn.resolve('esbuild/package.json', { paths });
    const version = readJson(packageJson).version;
    const resolvePaths = [path.dirname(packageJson)];
    const packageName = platformPackage('esbuild');
    if (!packageName)
      throw new Error(`unsupported esbuild platform: ${platformIdentity()}`);
    let platformJson;
    try {
      platformJson = requireFn.resolve(`${packageName}/package.json`, {
        paths: resolvePaths,
      });
    } catch {
      platformJson = undefined;
    }
    if (
      requiresManagedEsbuildPlatform({
        noOptional: env.KUNGFU_BUILDCHAIN_NO_OPTIONAL === '1',
        hostVersion: version,
        platformVersion: platformJson
          ? readJson(platformJson).version
          : undefined,
      })
    ) {
      const nodePath = ensurePackage({
        kind: `esbuild.${slot}`,
        packageName,
        version,
        installRoot: path.join(
          root,
          '.buildchain',
          'esbuild-platform',
          slot,
          platformIdentity(),
        ),
      });
      platformJson = packageJsonPath(nodePath, packageName);
      resolvePaths.unshift(path.dirname(nodePath));
    }
    if (!platformJson)
      throw new Error(`missing ${packageName} for esbuild ${version}`);
    const platformVersion = readJson(platformJson).version;
    if (platformVersion !== version)
      throw new Error(
        `esbuild host ${version} does not match ${packageName} ${platformVersion}`,
      );
    const binaryPath = esbuildPlatformBinaryPath(
      path.dirname(platformJson),
      platform,
    );
    if (!fs.existsSync(binaryPath))
      throw new Error(`missing ${packageName} binary: ${binaryPath}`);
    return { packageJson, packageName, resolvePaths, binaryPath };
  };
  const guiEsbuildPackagePaths = () => {
    const electronVite = requireFn.resolve('electron-vite/package.json', {
      paths: [guiDir],
    });
    return [path.dirname(electronVite)];
  };
  const buildchainSourceBuildEnv = () => {
    if (env.KUNGFU_BUILDCHAIN_NO_OPTIONAL !== '1') {
      logger.mark('product.libnode.platform.optional', {
        phase: 'dependencies',
        attributes: { noOptional: false },
      });
      return env;
    }
    const libnode = platformPackage('libnode');
    if (!libnode)
      throw new Error(`unsupported libnode platform: ${platformIdentity()}`);
    const nodePaths = [];
    if (canResolve(libnode))
      logger.mark('product.libnode.platform.resolved', {
        phase: 'dependencies',
        attributes: { packageName: libnode, source: 'workspace-node-path' },
      });
    const corePackage = readJson(
      path.join(root, 'framework', 'core', 'package.json'),
    );
    const libnodeVersion =
      corePackage.devDependencies?.['@kungfu-tech/libnode'];
    if (!libnodeVersion)
      throw new Error('framework/core must declare @kungfu-tech/libnode');
    if (!canResolve(libnode))
      nodePaths.push(
        ensurePackage({
          kind: 'libnode',
          packageName: libnode,
          version: libnodeVersion,
          installRoot: path.join(
            root,
            '.buildchain',
            'libnode-platform',
            platformIdentity(),
          ),
        }),
      );
    const rollup = platformPackage('rollup');
    if (!rollup)
      throw new Error(`unsupported rollup platform: ${platformIdentity()}`);
    const paths = rollupPaths();
    if (canResolve(rollup, paths))
      logger.mark('product.rollup.platform.resolved', {
        phase: 'dependencies',
        attributes: { packageName: rollup, source: 'workspace-node-path' },
      });
    else {
      const rollupJson = requireFn.resolve('rollup/package.json', { paths });
      nodePaths.push(
        ensurePackage({
          kind: 'rollup',
          packageName: rollup,
          version: readJson(rollupJson).version,
          installRoot: path.join(
            root,
            '.buildchain',
            'rollup-platform',
            platformIdentity(),
          ),
        }),
      );
    }
    return appendNodePath(env, nodePaths);
  };
  return {
    owner: PLATFORM_DEPENDENCY_RUNTIME_OWNER,
    buildchainSourceBuildEnv,
    ensureEsbuildRuntime,
    guiEsbuildPackagePaths,
  };
}

export function assertSupportedProductHost({
  platform = process.platform,
  architecture = process.arch,
} = {}) {
  if (platform === 'darwin' && ['x64', 'x86_64'].includes(architecture)) {
    throw new Error(INTEL_MACOS_DIAGNOSTIC);
  }
}

export function assertSupportedProductTarget(platform, architecture) {
  assertSupportedProductHost({ platform, architecture });
  const identity = `${platform}/${architecture}`;
  if (!SUPPORTED_PRODUCT_TARGETS.has(identity)) {
    throw new Error(`unsupported product target: ${identity}`);
  }
}

export function supportedProductTargets() {
  return [...SUPPORTED_PRODUCT_TARGETS].sort();
}

export function readTrunkRuntimePinSnapshot({ runtimePinsPath, repoPinPath }) {
  const runtimePins = fs.readFileSync(runtimePinsPath, 'utf8');
  const uvPin = (runtimePins.match(/^UV_VERSION=(.+)$/m) || [])[1]?.trim();
  const repoPin = fs.readFileSync(repoPinPath, 'utf8').trim();
  if (!uvPin || uvPin !== repoPin) {
    throw new Error(
      `runtime-pins.env pins uv ${uvPin} but .uv-version pins ${repoPin}; update product/runtime-pins.env (version and checksums) alongside .uv-version`,
    );
  }
  return Object.freeze({ runtimePins, uvPin, repoPin });
}

// The source-authoritative runtime pin is the first input to product assembly.
// Keeping its read and the pure stage order together prevents dist.mjs from
// growing another orchestration authority while staying inside the existing
// product/assembly helper budget.
export const PRODUCT_ASSEMBLY_STAGE_IDS = Object.freeze([
  'discover',
  'dependencies',
  'core',
  'extensions',
  'ui',
  'desktop',
  'cli',
]);

export function runProductAssembly({
  productTarget,
  builderArgs,
  logger,
  paths,
  operations,
}) {
  const wantsDesktop = productTarget === 'all' || productTarget === 'desktop';
  const wantsCli = productTarget === 'all' || productTarget === 'cli';
  const trunkRuntimePinSnapshot = readTrunkRuntimePinSnapshot({
    runtimePinsPath: paths.runtimePins,
    repoPinPath: path.join(paths.root, '.uv-version'),
  });

  logger.spanSync(
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
      const kfxPackages = logger.spanSync(
        'product.kfx.discover',
        {
          phase: 'prepare',
          attributes: { root: operations.rel(paths.extensionsRoot) },
        },
        () => operations.listKfxPackages(),
      );
      operations.assertDeclaredKfx(kfxPackages);

      operations.runPnpm('sync dependencies', operations.installArgs(), {
        phase: 'dependencies',
        event: 'product.dependencies.sync',
      });
      const buildEnv = operations.buildchainSourceBuildEnv();
      const sdkEsbuildRuntime = operations.ensureEsbuildRuntime({
        slot: 'sdk',
        paths: [paths.sdkDir, paths.root],
      });
      const tuiEsbuildRuntime = operations.ensureEsbuildRuntime({
        slot: 'tui',
        paths: [paths.tuiDir, paths.root],
      });
      const sdkBuildEnv = {
        ...buildEnv,
        ESBUILD_BINARY_PATH: sdkEsbuildRuntime.binaryPath,
      };
      const tuiBuildEnv = {
        ...buildEnv,
        ESBUILD_BINARY_PATH: tuiEsbuildRuntime.binaryPath,
      };

      operations.runPnpm(
        'rebuild core',
        ['--filter', '@kungfu-tech/core', 'run', 'rebuild'],
        {
          env: buildEnv,
          phase: 'core',
          event: 'product.core.rebuild',
        },
      );
      operations.runPnpm(
        'freeze core runtime',
        ['--filter', '@kungfu-tech/core', 'run', 'freeze'],
        {
          // The product must ship the native host. Product assembly therefore
          // fails closed instead of falling back to the Python node path or
          // doctor stub; ordinary development freeze remains warn-only.
          env: { ...process.env, KF_REQUIRE_NATIVE_HOST: '1' },
          phase: 'core',
          event: 'product.core.freeze',
        },
      );
      operations.assertCoreAssembled();
      operations.stageTrunk(trunkRuntimePinSnapshot);
      operations.runPnpm(
        'pack core npm artifacts',
        ['--filter', '@kungfu-tech/core', 'run', 'pack-platform'],
        {
          env: {
            ...buildEnv,
            KF_PACKAGE_STAGE_DIR: paths.npmReleaseDir,
          },
          phase: 'package',
          event: 'product.core.npm.pack',
        },
      );

      operations.buildKfx(kfxPackages, sdkBuildEnv);
      operations.assertKfxBundleExternals(kfxPackages);
      operations.assembleKfx(kfxPackages);
      operations.runPnpm(
        'bundle tui',
        ['--filter', '@kungfu-tech/tui', 'run', 'bundle'],
        {
          env: tuiBuildEnv,
          phase: 'ui',
          event: 'product.tui.bundle',
        },
      );

      if (wantsDesktop) {
        const guiEsbuildRuntime = operations.ensureEsbuildRuntime({
          slot: 'gui',
          paths: operations.guiEsbuildPackagePaths(),
        });
        const guiBuildEnv = {
          ...buildEnv,
          ESBUILD_BINARY_PATH: guiEsbuildRuntime.binaryPath,
        };
        operations.stageDesktopAuthoringRuntime(sdkEsbuildRuntime);
        operations.runPnpm(
          'ensure electron',
          ['--filter', '@kungfu-tech/gui', 'run', 'ensure-electron'],
          {
            env: buildEnv,
            phase: 'ui',
            event: 'product.gui.ensure-electron',
          },
        );
        operations.runPnpm(
          'build gui',
          ['--filter', '@kungfu-tech/gui', 'run', 'build'],
          {
            env: guiBuildEnv,
            phase: 'ui',
            event: 'product.gui.build',
          },
        );
        operations.writeCompatibilityManifest({
          root: paths.root,
          output: paths.compatibilityManifest,
          includeGui: true,
        });
        operations.run(
          'electron-builder desktop product',
          process.execPath,
          [
            path.join(paths.guiDir, 'scripts', 'run-electron-builder.mjs'),
            `--config=${path.join(paths.productDir, 'electron-builder.yml')}`,
            ...builderArgs,
          ],
          {
            cwd: paths.guiDir,
            env: {
              ...sdkBuildEnv,
              KF_BUNDLED_EXTENSION_ROOT: paths.assembledExtensions,
            },
            phase: 'package',
            event: 'product.desktop.electron-builder',
          },
        );
        operations.finalizeDesktopReleaseManifest();
        operations.stageDesktopRelease();
        // Build registration for `shifu builds` / `shifu promote` is not a
        // build step. The launcher reads KFD-3 and stashes the artifact only
        // after this task exits successfully.
      }

      if (wantsCli) {
        if (!wantsDesktop) {
          operations.writeCompatibilityManifest({
            root: paths.root,
            output: paths.compatibilityManifest,
            includeGui: false,
          });
        }
        operations.buildCliProduct(sdkEsbuildRuntime);
      }
      console.log(`\n[product] output -> ${operations.rel(paths.releaseDir)}`);
    },
  );
}
