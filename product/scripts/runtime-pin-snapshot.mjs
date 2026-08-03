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
