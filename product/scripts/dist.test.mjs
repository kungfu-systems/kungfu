// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readElectronBuilderProjection } from '../../framework/maintainability/semantic-amplification.mjs';
import { cliLauncherContent } from './cli-launcher.mjs';
import { isPythonBytecodePath, sha256Tree } from './compatibility.mjs';
import {
  cliArchiveBase,
  cliArchiveLayout,
  copyTree,
  desktopUpdaterArtifact,
  esbuildPlatformBinaryPath,
  installArgs,
  installedKungfuInvocation,
  isShippedKfdSupport,
  kfxBundleExternalModules,
  listKfxPackages,
  materializeProductRuntimeEntrypoints,
  requiresManagedEsbuildPlatform,
  runInstalledKungfuAgentHubSmoke,
  runInstalledKungfuAssignmentAdmissionSmoke,
  runInstalledKungfuCommand,
  runInstalledTuiBootstrapSmoke,
  stageNodePtyForCli,
  stageXinfaContract,
  verifyProductObservabilityEvents,
  writeAuditableDemoBinaryMetadata,
} from './dist.mjs';
import {
  productReleaseChannelConfig,
  releaseChannelKeyId,
} from './release-channel-trust.mjs';
import {
  INTEL_MACOS_DIAGNOSTIC,
  PRODUCT_ASSEMBLY_STAGE_IDS,
  assertSupportedProductHost,
  assertSupportedProductTarget,
  readTrunkRuntimePinSnapshot,
  supportedProductTargets,
} from './runtime-pin-snapshot.mjs';
import { buildCliUpgradeManifest } from './upgrade-manifest.mjs';

const require = createRequire(import.meta.url);
const workDashboardPackage = require('../../extensions/work-dashboard/kungfu.kfx.json');
const sdkPackage = require('../../developer/sdk/package.json');
const agentHubKfdLock = require('../../tests/qualification/agent-hub-20/kfd-lock.json');
const {
  esmEntrypointArgs,
  toEsmEntrypointSpecifier,
} = require('../../framework/gui/scripts/before-pack.cjs');

test('reference-only KFX suites stay outside product assembly', () => {
  const packageNames = listKfxPackages().map((pkg) => pkg.name);
  assert.ok(packageNames.includes('@kungfu-tech/kfx-suite-agent-work-lab'));
  assert.ok(
    packageNames.every((name) => !name.includes('github-webhook')),
    packageNames.join(', '),
  );
  assert.ok(!packageNames.includes('@kungfu-kfx/github-dogfood-bridge'));
});

test('Intel macOS is rejected by the product-wide host policy', () => {
  for (const architecture of ['x64', 'x86_64']) {
    for (const operation of [
      () => assertSupportedProductHost({ platform: 'darwin', architecture }),
      () => assertSupportedProductTarget('darwin', architecture),
    ]) {
      assert.throws(operation, (error) => {
        assert.equal(error.message, INTEL_MACOS_DIAGNOSTIC);
        return true;
      });
    }
  }
});

test('the supported product matrix is exact', () => {
  assert.deepEqual(supportedProductTargets(), [
    'darwin/arm64',
    'linux/arm64',
    'linux/x64',
    'win32/x64',
  ]);
  for (const target of supportedProductTargets()) {
    const [platform, architecture] = target.split('/');
    assert.doesNotThrow(() =>
      assertSupportedProductTarget(platform, architecture),
    );
  }
});

test('installed TUI binds child CLI calls to the manifest runtime entry', () => {
  const installRoot = path.resolve('installed-product');
  const kungfuBin = path.join(installRoot, 'kungfu.cmd');
  const runtimeEntry = path.join(installRoot, 'runtime', 'kungfu.exe');
  const tuiEntry = path.join(installRoot, 'tui', 'tui.mjs');
  let invocation;

  runInstalledTuiBootstrapSmoke(
    {
      installRoot,
      kungfuBin,
      runtimeEntry,
      tuiEntry,
      env: {},
    },
    {
      spawn(command, args, options) {
        invocation = { command, args, options };
        return {
          status: 0,
          signal: null,
          stdout: '{"schema":"kungfu.agent-work-lab.report/v1"}\n',
          stderr: '',
        };
      },
    },
  );

  assert.equal(invocation.command, kungfuBin);
  assert.deepEqual(invocation.args, [tuiEntry, '--agent-work-lab-demo']);
  assert.equal(invocation.options.env.KUNGFU_DIR, path.dirname(runtimeEntry));
  assert.notEqual(invocation.options.env.KUNGFU_DIR, path.dirname(kungfuBin));
});

test('trunk staging retains one source-authoritative runtime pin snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-pin-test-'));
  const runtimePinsPath = path.join(root, 'runtime-pins.env');
  const repoPinPath = path.join(root, '.uv-version');
  try {
    fs.writeFileSync(
      runtimePinsPath,
      '# source pin\nUV_VERSION=0.11.23\n',
      'utf8',
    );
    fs.writeFileSync(repoPinPath, '0.11.23\n', 'utf8');
    const snapshot = readTrunkRuntimePinSnapshot({
      runtimePinsPath,
      repoPinPath,
    });

    fs.rmSync(runtimePinsPath);
    fs.rmSync(repoPinPath);
    assert.deepEqual(snapshot, {
      runtimePins: '# source pin\nUV_VERSION=0.11.23\n',
      uvPin: '0.11.23',
      repoPin: '0.11.23',
    });
    assert.equal(Object.isFrozen(snapshot), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('trunk runtime pin snapshot rejects source drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-pin-test-'));
  const runtimePinsPath = path.join(root, 'runtime-pins.env');
  const repoPinPath = path.join(root, '.uv-version');
  try {
    fs.writeFileSync(runtimePinsPath, 'UV_VERSION=0.11.24\n', 'utf8');
    fs.writeFileSync(repoPinPath, '0.11.23\n', 'utf8');
    assert.throws(
      () =>
        readTrunkRuntimePinSnapshot({
          runtimePinsPath,
          repoPinPath,
        }),
      /runtime-pins\.env pins uv 0\.11\.24 but \.uv-version pins 0\.11\.23/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installed KFD smoke accepts only release-qualified shipped support', () => {
  assert.equal(isShippedKfdSupport({ status: 'supported' }), true);
  assert.equal(
    isShippedKfdSupport({
      status: 'source-supported',
      verification: { status: 'passed' },
      buildchain: { gateStatus: 'passed' },
      claimClass: 'release-qualified-support',
      releaseQualification: {
        status: 'alpha-release-passport',
        shippedSupport: true,
      },
    }),
    true,
  );
  assert.equal(
    isShippedKfdSupport({
      status: 'source-supported',
      verification: { status: 'passed' },
      buildchain: { gateStatus: 'failed' },
      claimClass: 'release-qualified-support',
      releaseQualification: {
        status: 'alpha-release-passport',
        shippedSupport: true,
      },
    }),
    false,
  );
  assert.equal(
    isShippedKfdSupport({
      status: 'candidate',
      verification: { status: 'passed' },
      buildchain: { gateStatus: 'passed' },
      claimClass: 'adoption-candidate',
      releaseQualification: {
        status: 'not-qualified',
        shippedSupport: false,
      },
    }),
    false,
  );
});

test('CLI authoring runtime resolves the exact Agent Hub KFD package', () => {
  const packageJson = require.resolve('@kungfu-tech/kfd/package.json', {
    paths: [path.resolve('developer/sdk')],
  });
  const kfdRoot = path.dirname(packageJson);
  const installed = require(packageJson);
  assert.equal(
    sdkPackage.dependencies['@kungfu-tech/kfd'],
    agentHubKfdLock.version,
  );
  assert.equal(installed.version, agentHubKfdLock.version);
  for (const relative of [
    'bin/kfd.mjs',
    'scripts/agent-hub-runner.mjs',
    'scripts/agent-hub-report-verifier.mjs',
  ]) {
    assert.equal(
      fs.statSync(path.join(kfdRoot, relative)).isFile(),
      true,
      `missing installed KFD Agent Hub entry: ${relative}`,
    );
  }
});

test('CLI product archive name uses the Kungfu Episodes product prefix', () => {
  assert.equal(
    cliArchiveBase('darwin-arm64'),
    'kungfu-episodes-cli-darwin-arm64',
  );
  assert.equal(cliArchiveBase('linux-x64'), 'kungfu-episodes-cli-linux-x64');
  assert.equal(
    cliArchiveBase('linux-arm64'),
    'kungfu-episodes-cli-linux-arm64',
  );
  assert.equal(
    cliArchiveBase('windows-x64'),
    'kungfu-episodes-cli-windows-x64',
  );
});

test('CLI product emits exact standalone demo metadata beside the launcher', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-demo-binary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const layout = cliArchiveLayout('linux');
  fs.writeFileSync(path.join(root, layout.launcherName), '#!/bin/sh\nexit 0\n');
  fs.mkdirSync(path.dirname(path.join(root, layout.pythonEntrypoint)), {
    recursive: true,
  });
  fs.writeFileSync(path.join(root, layout.runtimeEntrypoint), 'runtime\n');
  fs.writeFileSync(
    path.join(root, 'runtime/python/bin/python3.13'),
    'python\n',
  );
  fs.symlinkSync('python3.13', path.join(root, layout.pythonEntrypoint));
  const metadata = writeAuditableDemoBinaryMetadata(
    root,
    layout,
    'linux-x64',
    root,
  );
  assert.deepEqual(metadata, {
    contract: 'kungfu.declarative-demo-binary/v1',
    platformId: 'linux-x64',
    sha256: `sha256:${crypto.createHash('sha256').update('#!/bin/sh\nexit 0\n').digest('hex')}`,
    executableFiles: [
      {
        path: 'kungfu',
        sha256: crypto
          .createHash('sha256')
          .update('#!/bin/sh\nexit 0\n')
          .digest('hex'),
      },
      {
        path: 'runtime/kungfu',
        sha256: crypto.createHash('sha256').update('runtime\n').digest('hex'),
      },
      {
        path: 'runtime/python/bin/python3',
        sha256: crypto.createHash('sha256').update('python\n').digest('hex'),
      },
    ],
    runtimeDependencies: [],
  });
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(root, 'auditable-demo-binary.json'), 'utf8'),
    ),
    metadata,
  );
});

test('CLI product materializes symlinked demo executables as regular files', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX symlink contract');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-demo-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const layout = cliArchiveLayout('linux');
  fs.writeFileSync(path.join(root, layout.launcherName), '#!/bin/sh\nexit 0\n');
  fs.mkdirSync(path.dirname(path.join(root, layout.pythonEntrypoint)), {
    recursive: true,
  });
  fs.writeFileSync(path.join(root, layout.runtimeEntrypoint), 'runtime\n');
  const pythonTarget = path.join(root, layout.runtimeDirectory, 'python-real');
  fs.writeFileSync(pythonTarget, 'python\n');
  fs.chmodSync(pythonTarget, 0o755);
  fs.symlinkSync(
    path.relative(
      path.dirname(path.join(root, layout.pythonEntrypoint)),
      pythonTarget,
    ),
    path.join(root, layout.pythonEntrypoint),
  );
  writeAuditableDemoBinaryMetadata(root, layout, 'linux-x64', root);

  const python = path.join(root, layout.pythonEntrypoint);
  assert.equal(fs.lstatSync(python).isFile(), true);
  assert.equal(fs.lstatSync(python).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(python, 'utf8'), 'python\n');
  assert.notEqual(fs.statSync(python).mode & 0o111, 0);
  assert.equal(fs.statSync(python).ino, fs.statSync(pythonTarget).ino);
  assert.equal(fs.statSync(python).nlink, 2);
});

test('CLI runtime identity is stable after demo executable metadata', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-runtime-id-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const layout = cliArchiveLayout('linux');
  const runtimeRoot = path.join(root, layout.runtimeDirectory);
  const python = path.join(root, layout.pythonEntrypoint);
  const pythonTarget = path.join(path.dirname(python), 'python3.13');
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(path.join(root, layout.launcherName), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(root, layout.runtimeEntrypoint), 'runtime\n');
  fs.writeFileSync(pythonTarget, 'python\n');
  fs.chmodSync(pythonTarget, 0o755);
  fs.symlinkSync('python3.13', python);
  materializeProductRuntimeEntrypoints(runtimeRoot, 'linux');
  const manifest = buildCliUpgradeManifest({ stageRoot: root, layout });
  writeAuditableDemoBinaryMetadata(root, layout, 'linux-x64', root);

  assert.equal(fs.lstatSync(python).isFile(), true);
  assert.equal(
    manifest.runtimeArtifactDigest,
    `sha256:${sha256Tree(runtimeRoot)}`,
  );
});

test('CLI product rejects demo executable symlinks to non-files', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX symlink contract');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-demo-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const layout = cliArchiveLayout('linux');
  const python = path.join(root, layout.pythonEntrypoint);
  fs.writeFileSync(path.join(root, layout.launcherName), '#!/bin/sh\nexit 0\n');
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(path.join(root, layout.runtimeEntrypoint), 'runtime\n');
  const directory = path.join(root, layout.runtimeDirectory, 'python-dir');
  fs.mkdirSync(directory);
  fs.symlinkSync(path.relative(path.dirname(python), directory), python);

  assert.throws(
    () => writeAuditableDemoBinaryMetadata(root, layout, 'linux-x64', root),
    /executable symlink target is not a regular file/u,
  );
  assert.equal(fs.lstatSync(python).isSymbolicLink(), true);
});

test('CLI product manifest channel config contains only runtime trust fields', () => {
  const publicKey = Buffer.alloc(32, 7).toString('base64');
  const keyId = releaseChannelKeyId(publicKey);
  const config = productReleaseChannelConfig({
    schema: 'kungfu.release-channel-trust/v1',
    channels: {
      alpha: {
        indexUrl: 'https://kungfu.tech/.well-known/kungfu/alpha.json',
        activeKeyId: keyId,
        trustedKeys: [{ keyId, publicKey, status: 'active' }],
      },
    },
  });
  assert.deepEqual(config, {
    indexUrl: 'https://kungfu.tech/.well-known/kungfu/alpha.json',
    trustedKeys: [{ keyId, publicKey }],
  });
});

test('CLI archive keeps the launcher distinct from its runtime tree', () => {
  assert.deepEqual(cliArchiveLayout('darwin'), {
    launcherName: 'kungfu',
    runtimeDirectory: 'runtime',
    runtimeEntrypoint: 'runtime/kungfu',
    pythonEntrypoint: 'runtime/python/bin/python3',
    compatibility: 'runtime/product-compatibility.json',
  });
  assert.deepEqual(cliArchiveLayout('win32'), {
    launcherName: 'kungfu.cmd',
    runtimeDirectory: 'runtime',
    runtimeEntrypoint: 'runtime/kungfu.exe',
    pythonEntrypoint: 'runtime/python/python.exe',
    compatibility: 'runtime/product-compatibility.json',
  });
  assert.match(cliLauncherContent('darwin'), /exec "\$here\/runtime\/kungfu"/);
  assert.match(cliLauncherContent('win32'), /%~dp0runtime\\kungfu\.exe/);
});

test('product staging rewrites internal absolute symlinks as portable relative links', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX symlink contract');
    return;
  }
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-dist-test-'));
  try {
    const source = path.join(parent, 'source');
    const target = path.join(parent, 'target');
    fs.mkdirSync(path.join(source, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(source, 'bin', 'python3'), 'runtime');
    fs.symlinkSync(
      path.join(source, 'bin', 'python3'),
      path.join(source, 'bin', 'python'),
    );
    copyTree(source, target);
    const copied = path.join(target, 'bin', 'python');
    assert.equal(fs.lstatSync(copied).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(copied), 'python3');
    assert.equal(fs.readFileSync(copied, 'utf8'), 'runtime');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('Linux CLI staging restores only the exact node-pty native runtime closure', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-node-pty-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const source = path.join(parent, 'source');
  const target = path.join(parent, 'target');
  for (const [relative, content] of [
    ['package.json', '{"name":"node-pty","version":"1.1.0"}\n'],
    ['index.js', 'export {};\n'],
    ['build/Release/pty.node', 'native-addon\n'],
    ['build/Release/spawn-helper', 'native-helper\n'],
    ['build/Debug/pty.node', 'debug-addon\n'],
    ['build/Release/obj.target/unshipped.o', 'object\n'],
  ]) {
    const file = path.join(source, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  stageNodePtyForCli(source, target, 'linux', 'x64');

  assert.equal(
    fs.readFileSync(path.join(target, 'index.js'), 'utf8'),
    'export {};\n',
  );
  assert.equal(
    fs.readFileSync(path.join(target, 'build/Release/pty.node'), 'utf8'),
    'native-addon\n',
  );
  assert.equal(
    fs.existsSync(path.join(target, 'build/Release/spawn-helper')),
    false,
  );
  assert.equal(fs.existsSync(path.join(target, 'build/Debug')), false);
  assert.equal(
    fs.existsSync(path.join(target, 'build/Release/obj.target')),
    false,
  );
});
test('Darwin CLI staging preserves the prebuilt node-pty helper contract', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-node-pty-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const source = path.join(parent, 'source');
  const target = path.join(parent, 'target');
  const prebuild = path.join(source, 'prebuilds', 'darwin-arm64');
  fs.mkdirSync(prebuild, { recursive: true });
  fs.writeFileSync(
    path.join(source, 'package.json'),
    '{"name":"node-pty","version":"1.1.0"}\n',
  );
  fs.writeFileSync(path.join(prebuild, 'pty.node'), 'native-addon\n');
  fs.writeFileSync(path.join(prebuild, 'spawn-helper'), 'native-helper\n');
  fs.mkdirSync(path.join(source, 'prebuilds', 'darwin-x64'));
  fs.writeFileSync(
    path.join(source, 'prebuilds', 'darwin-x64', 'pty.node'),
    'foreign-native-addon\n',
  );
  fs.chmodSync(path.join(prebuild, 'spawn-helper'), 0o644);
  stageNodePtyForCli(source, target, 'darwin', 'arm64');
  const addon = path.join(target, 'prebuilds/darwin-arm64/pty.node');
  assert.equal(fs.readFileSync(addon, 'utf8'), 'native-addon\n');
  const helper = path.join(target, 'prebuilds/darwin-arm64/spawn-helper');
  assert.equal(fs.readFileSync(helper, 'utf8'), 'native-helper\n');
  assert.notEqual(fs.statSync(helper).mode & 0o111, 0);
  assert.deepEqual(fs.readdirSync(path.join(target, 'prebuilds')), [
    'darwin-arm64',
  ]);
});

test('Linux CLI staging fails closed when the node-pty native addon is missing', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-node-pty-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const source = path.join(parent, 'source');
  const target = path.join(parent, 'target');
  fs.mkdirSync(path.join(source, 'build', 'Release'), { recursive: true });
  fs.writeFileSync(
    path.join(source, 'package.json'),
    '{"name":"node-pty","version":"1.1.0"}\n',
  );

  assert.throws(
    () => stageNodePtyForCli(source, target, 'linux', 'x64'),
    /required node-pty runtime file not found/u,
  );
});

test('product staging rejects an absolute symlink outside its source tree', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX symlink contract');
    return;
  }
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-dist-test-'));
  try {
    const source = path.join(parent, 'source');
    const target = path.join(parent, 'target');
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(path.join(source, 'bin'), { recursive: true });
    fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, path.join(source, 'bin', 'python'));
    assert.throws(() => copyTree(source, target), /escaping symlink/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('CLI upgrade identity binds the filtered staged runtime', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX symlink contract');
    return;
  }
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-dist-test-'));
  try {
    const source = path.join(parent, 'source');
    const stageRoot = path.join(parent, 'stage');
    const runtime = path.join(stageRoot, 'runtime');
    fs.mkdirSync(path.join(source, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(source, 'kungfu'), 'runtime');
    fs.writeFileSync(path.join(source, 'bin', 'python3'), 'interpreter');
    fs.writeFileSync(path.join(source, 'bin', 'ignored.pyc'), 'bytecode');
    fs.symlinkSync('python3', path.join(source, 'bin', 'python'));
    copyTree(source, runtime);

    const manifest = buildCliUpgradeManifest({
      stageRoot,
      layout: cliArchiveLayout(),
    });

    assert.equal(
      manifest.runtimeArtifactDigest,
      `sha256:${sha256Tree(runtime)}`,
    );
    assert.equal(
      manifest.runtimeArtifactDigest,
      `sha256:${sha256Tree(source, {
        filter: (file) => !isPythonBytecodePath(file),
      })}`,
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('product staging excludes every Python bytecode form', () => {
  assert.equal(
    isPythonBytecodePath('/runtime/pkg/__pycache__/module.pyc'),
    true,
  );
  assert.equal(isPythonBytecodePath('C:\\runtime\\pkg\\module.pyc'), true);
  assert.equal(isPythonBytecodePath('/runtime/pkg/module.PYC'), true);
  assert.equal(isPythonBytecodePath('/runtime/pkg/module.py'), false);
  for (const configPath of [
    '../electron-builder.yml',
    '../../framework/gui/electron-builder.yml',
  ]) {
    const config = readElectronBuilderProjection(
      new URL(configPath, import.meta.url),
    );
    const filters = config.extraResources.flatMap(
      (resource) => resource.filter ?? [],
    );
    assert.ok(filters.includes('!**/__pycache__/**'));
    assert.ok(filters.includes('!**/*.pyc'));
  }
});

test('installed CLI launcher uses cmd.exe explicitly on Windows', () => {
  assert.deepEqual(
    installedKungfuInvocation('C:\\Kungfu Episodes\\kungfu.cmd', ['--help'], {
      platform: 'win32',
      comspec: 'C:\\Windows\\System32\\cmd.exe',
    }),
    {
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        'call',
        'C:\\Kungfu Episodes\\kungfu.cmd',
        '--help',
      ],
    },
  );
  assert.deepEqual(
    installedKungfuInvocation('/opt/kungfu/kungfu', ['--help'], {
      platform: 'linux',
    }),
    { command: '/opt/kungfu/kungfu', args: ['--help'] },
  );
});

test('installed CLI surface runner uses the Windows launcher invocation', () => {
  let observed;
  const result = runInstalledKungfuCommand(
    {
      cli: 'C:\\Kungfu Episodes\\kungfu.cmd',
      args: ['--help-json'],
      cwd: 'C:\\Kungfu Episodes',
      env: { KUNGFU_HOME: 'C:\\Kungfu Home' },
    },
    {
      platform: 'win32',
      comspec: 'C:\\Windows\\System32\\cmd.exe',
      spawn(command, args, options) {
        observed = { command, args, options };
        return { status: 0, stdout: '{}', stderr: '', signal: null };
      },
    },
  );
  assert.equal(result.status, 0);
  assert.deepEqual(observed, {
    command: 'C:\\Windows\\System32\\cmd.exe',
    args: [
      '/d',
      '/s',
      '/c',
      'call',
      'C:\\Kungfu Episodes\\kungfu.cmd',
      '--help-json',
    ],
    options: {
      cwd: 'C:\\Kungfu Episodes',
      env: { KUNGFU_HOME: 'C:\\Kungfu Home' },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      shell: false,
    },
  });
});

test('Assignment admission smoke isolates the operator Workspace Catalog', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-assignment-smoke-isolation-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installRoot = path.join(root, 'installed');
  const operatorHome = path.join(root, 'operator-home');
  const operatorCatalog = path.join(
    operatorHome,
    '.kungfu-config',
    'workspaces',
    'catalog.json',
  );
  const operatorBytes = '{"operator":"catalog-authority"}\n';
  fs.mkdirSync(path.dirname(operatorCatalog), { recursive: true });
  fs.mkdirSync(installRoot, { recursive: true });
  fs.writeFileSync(operatorCatalog, operatorBytes);

  const invocations = [];
  let capturedRequest;
  runInstalledKungfuAssignmentAdmissionSmoke({
    installRoot,
    kungfuBin: path.join(installRoot, 'kungfu'),
    env: {
      ...process.env,
      HOME: operatorHome,
      USERPROFILE: operatorHome,
    },
    run(invocation) {
      invocations.push(invocation);
      const isolatedCatalog = path.join(
        invocation.env.HOME,
        '.kungfu-config',
        'workspaces',
        'catalog.json',
      );
      if (invocation.args.includes('capture')) {
        const requestIndex = invocation.args.indexOf('--request');
        capturedRequest = JSON.parse(
          fs.readFileSync(invocation.args[requestIndex + 1], 'utf8'),
        );
        fs.mkdirSync(path.dirname(isolatedCatalog), { recursive: true });
        fs.writeFileSync(
          isolatedCatalog,
          `${JSON.stringify({
            locator: path.join(installRoot, 'assignment-admission-workspace'),
          })}\n`,
        );
        return `${JSON.stringify({
          requestPath: path.join(installRoot, 'captured-request.json'),
        })}\n`;
      }
      return `${JSON.stringify({
        admitted: true,
        status: 'admitted',
        next_actions: [
          {
            input: {
              assignment_id: 'installed-product-admission-smoke',
            },
          },
        ],
        assignment_receipt: { receipt: { episode_id: '1' } },
      })}\n`;
    },
  });

  assert.equal(fs.readFileSync(operatorCatalog, 'utf8'), operatorBytes);
  assert.equal(
    capturedRequest.workDefinition.initiative_id,
    'installed-product-qualification',
  );
  assert.equal(
    capturedRequest.workDefinition.assignment_id,
    'installed-product-admission-smoke',
  );
  assert.equal(invocations.length, 2);
  assert.deepEqual(
    invocations.map(({ args }) => args.slice(0, 2)),
    [
      ['work', 'capture'],
      ['work', 'admit'],
    ],
  );
  const admissionRequest = JSON.parse(
    fs.readFileSync(
      path.join(installRoot, 'assignment-admission-request.json'),
      'utf8',
    ),
  );
  assert.equal(
    admissionRequest.workDefinition.initiative_id,
    'installed-product-qualification',
  );
  assert.equal(
    admissionRequest.workDefinition.assignment_id,
    'installed-product-admission-smoke',
  );
  assert.deepEqual(
    invocations[1].args.slice(
      invocations[1].args.indexOf('--initiative-id'),
      invocations[1].args.indexOf('--actor'),
    ),
    [
      '--initiative-id',
      'installed-product-qualification',
      '--assignment-id',
      'installed-product-admission-smoke',
    ],
  );
  for (const invocation of invocations) {
    assert.equal(
      invocation.env.HOME,
      path.join(installRoot, '.assignment-admission-user-home'),
    );
    assert.equal(invocation.env.USERPROFILE, invocation.env.HOME);
    assert.equal(invocation.env.KUNGFU_INSTALL_SOURCE, undefined);
    assert.equal(invocation.env.KUNGFU_DIR, undefined);
    assert.equal(invocation.env.KUNGFU_UPGRADE_MANIFEST, undefined);
  }
  const isolatedCatalog = path.join(
    installRoot,
    '.assignment-admission-user-home',
    '.kungfu-config',
    'workspaces',
    'catalog.json',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(isolatedCatalog, 'utf8')).locator,
    path.join(installRoot, 'assignment-admission-workspace'),
  );
});

test('Agent Hub smoke redirects Python cache outside its isolated user home', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-agent-hub-cache-isolation-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installRoot = path.join(root, 'installed');
  fs.mkdirSync(installRoot, { recursive: true });

  const invocations = [];
  const meaning = 'Agent Hub qualification passed';
  const nonClaims = ['KFD certification'];
  runInstalledKungfuAgentHubSmoke({
    installRoot,
    kungfuBin: path.join(installRoot, 'kungfu'),
    env: process.env,
    run(invocation) {
      invocations.push(invocation);
      fs.mkdirSync(invocation.env.KF_CACHE_HOME, { recursive: true });
      fs.writeFileSync(
        path.join(invocation.env.KF_CACHE_HOME, 'qualification.pyc'),
        'cache',
      );
      if (invocation.args.includes('qualify')) {
        return `${JSON.stringify({
          valid: true,
          coverage: { passed: 20, total: 20 },
          isolation: { realHomeUnchanged: true },
          meaning,
          nonClaims,
          next: { verify: 'kungfu agent hub verify' },
          evidence: { reportDigest: `sha256:${'1'.repeat(64)}` },
        })}\n`;
      }
      return `${JSON.stringify({
        valid: true,
        coverage: { passed: 20, total: 20 },
        meaning,
        nonClaims,
        checks: [{ passed: true }],
      })}\n`;
    },
  });

  assert.equal(invocations.length, 2);
  const expectedUserHome = path.join(installRoot, '.agent-hub-user-home');
  const expectedCacheHome = path.join(installRoot, '.agent-hub-cache-home');
  for (const invocation of invocations) {
    assert.equal(invocation.env.HOME, expectedUserHome);
    assert.equal(invocation.env.USERPROFILE, expectedUserHome);
    assert.equal(invocation.env.KF_CACHE_HOME, expectedCacheHome);
  }
  assert.equal(fs.existsSync(expectedUserHome), false);
  assert.equal(fs.existsSync(expectedCacheHome), true);
});

test('product observability ignores errors from sibling components', () => {
  const names = [
    ['product.dist.start', 'prepare'],
    ['product.kfx.dependencies.declared', 'dependencies'],
    ['product.dependencies.sync.start', 'dependencies'],
    ['product.core.rebuild.start', 'core'],
    ['product.core.freeze.start', 'core'],
    ['product.core.npm.pack.start', 'package'],
    ['product.extensions.build.start', 'extensions'],
    ['product.ui.bundle.start', 'ui'],
    ['product.desktop.electron-builder.start', 'package'],
    ['product.cli.archive.start', 'package'],
    ['product.cli.smoke.start', 'package'],
    ['product.cli.smoke.end', 'package'],
    ['product.dist.end', 'package'],
  ];
  const events = names.map(([event, phase]) => ({
    contract: 'kungfu-buildchain-log-event',
    timestamp: '2026-07-12T00:00:00.000Z',
    level: 'info',
    source: 'user',
    component: 'kungfu-product',
    event,
    phase,
  }));
  events.push({
    ...events[0],
    level: 'error',
    component: 'buildchain-lifecycle',
    event: 'unrelated.error',
  });

  const report = verifyProductObservabilityEvents(events);
  assert.equal(report.ok, true);
  assert.equal(report.summary.errorCount, 0);
  assert.equal(report.summary.eventCount, names.length);
});

test('electron before-pack uses a file URL only on Windows', () => {
  const entryPath = new URL(
    '../../framework/gui/scripts/gen-system-profile-kfd3.mjs',
    import.meta.url,
  ).pathname;
  assert.equal(toEsmEntrypointSpecifier(entryPath, 'linux'), entryPath);
  assert.equal(toEsmEntrypointSpecifier(entryPath, 'darwin'), entryPath);
  assert.equal(
    new URL(toEsmEntrypointSpecifier('C:\\kungfu\\manifest.mjs', 'win32'))
      .protocol,
    'file:',
  );
});

test('electron before-pack imports its ESM entrypoint through eval', () => {
  const entryPath = new URL(
    '../../framework/gui/scripts/gen-system-profile-kfd3.mjs',
    import.meta.url,
  ).pathname;
  const specifier = toEsmEntrypointSpecifier(entryPath);
  assert.deepEqual(esmEntrypointArgs(entryPath), [
    '--eval',
    `import(${JSON.stringify(specifier)})`,
  ]);
});

test('work dashboard declares the storage handle used by its query stream', () => {
  assert.ok(
    workDashboardPackage.kungfuConfig.config.view.capabilities.includes(
      'storage',
    ),
  );
});

test('product kfx gate sees bundle externals but ignores window.require', () => {
  const code = [
    'var query = require("@kungfu-tech/api/query");',
    'var react = require("react");',
    'window.require("node:fs");',
    'win.require("node:path");',
  ].join('\n');
  assert.deepEqual(kfxBundleExternalModules(code), [
    '@kungfu-tech/api/query',
    'react',
  ]);
});

test('desktop product carries the installed Agent authoring runtime', () => {
  const config = readElectronBuilderProjection(
    new URL('../electron-builder.yml', import.meta.url),
  );
  for (const target of ['sdk', 'kfd', 'templates', 'node_modules']) {
    assert.ok(
      config.extraResources.some(
        (resource) =>
          resource.from === `../../product/dist/desktop-authoring/${target}` &&
          resource.to === target,
      ),
    );
  }
});

test('desktop product carries the externalized Agent Session runtime', () => {
  const config = readElectronBuilderProjection(
    new URL('../electron-builder.yml', import.meta.url),
  );
  assert.ok(
    config.extraResources.some(
      (resource) =>
        resource.from === '../agent-session' &&
        resource.to === 'app/node_modules/@kungfu-tech/agent-session',
    ),
  );
});

test('desktop product declares prerelease update metadata without implicit publishing', () => {
  const config = readElectronBuilderProjection(
    new URL('../electron-builder.yml', import.meta.url),
  );
  assert.deepEqual(config.publish, [
    {
      provider: 'github',
      owner: 'kungfu-systems',
      repo: 'kungfu',
      channel: 'alpha',
      releaseType: 'prerelease',
    },
  ]);
  assert.equal(config.generateUpdatesFilesForAllChannels, true);
  const launcher = fs.readFileSync(
    new URL(
      '../../framework/gui/scripts/run-electron-builder.mjs',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(launcher, /--publish=never/);
  assert.ok(
    config.extraResources.some(
      (resource) =>
        resource.from === 'dist/update/kungfu-release-manifest.json' &&
        resource.to === 'upgrade/kungfu-release-manifest.json',
    ),
  );
});

test('desktop updater artifact selection is exact per platform', () => {
  assert.equal(
    desktopUpdaterArtifact(
      [
        'latest-mac.yml',
        'Kungfu Episodes-4.0.0-arm64.zip.blockmap',
        'Kungfu Episodes-4.0.0-arm64.zip',
      ],
      'darwin',
    ),
    'Kungfu Episodes-4.0.0-arm64.zip',
  );
  assert.equal(
    desktopUpdaterArtifact(
      ['latest.yml', 'Kungfu Episodes Setup.exe'],
      'win32',
    ),
    'Kungfu Episodes Setup.exe',
  );
  assert.throws(
    () => desktopUpdaterArtifact(['one.zip', 'two.zip'], 'darwin'),
    /expected one/,
  );
});

test('installed SDK resolves the packaged KFX contract beside its resources', () => {
  const sdk = fs.readFileSync(
    new URL('../../developer/sdk/src/sdk-shared.js', import.meta.url),
    'utf8',
  );
  assert.match(
    sdk,
    /path\.join\(SDK_ROOT, 'kungfu', 'config', KFX_CONTRACT_FILE\)/,
  );
});

test('CLI staging carries the Xinfa contract and verification engine', () => {
  const stageRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-xinfa-stage-'),
  );
  try {
    stageXinfaContract(stageRoot);
    assert.ok(
      fs
        .statSync(
          path.join(stageRoot, 'xinfa', 'contract', 'xinfa-product-v2.json'),
        )
        .isFile(),
    );
    assert.ok(
      fs
        .statSync(path.join(stageRoot, 'xinfa', 'engine', 'xinfa.wasm'))
        .isFile(),
    );
    assert.ok(
      fs
        .statSync(path.join(stageRoot, 'xinfa', 'engine', 'manifest.json'))
        .isFile(),
    );
    const engine = fs.readFileSync(
      path.join(stageRoot, 'xinfa', 'engine', 'xinfa.wasm'),
    );
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(stageRoot, 'xinfa', 'engine', 'manifest.json'),
        'utf8',
      ),
    );
    assert.equal(
      manifest.wasm_sha256,
      `sha256:${crypto.createHash('sha256').update(engine).digest('hex')}`,
    );
    assert.equal(manifest.size, engine.length);
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
});

test('installed SDK keeps esbuild external and carries its native runtime', () => {
  const dist = fs.readFileSync(new URL('./dist.mjs', import.meta.url), 'utf8');
  assert.match(dist, /external: \['esbuild'\]/);
  assert.match(dist, /'esbuild',\s+esbuildRuntime\.resolvePaths/);
  assert.match(dist, /function esbuildPlatformPackageName\(\)/);
  assert.match(dist, /function ensureEsbuildRuntime\(\{ slot, paths \}\)/);
  assert.match(
    dist,
    /process\.env\.ESBUILD_BINARY_PATH = esbuildRuntime\.binaryPath/,
  );
  assert.match(
    dist,
    /Reflect\.deleteProperty\(process\.env, 'ESBUILD_BINARY_PATH'\)/,
  );
});

test('Buildchain stages exact esbuild binaries per product surface', () => {
  const dist = ['./dist.mjs', './runtime-pin-snapshot.mjs']
    .map((relative) =>
      fs.readFileSync(new URL(relative, import.meta.url), 'utf8'),
    )
    .join('\n');
  for (const slot of ['sdk', 'tui', 'gui']) {
    assert.match(dist, new RegExp(`slot: '${slot}'`));
  }
  assert.match(dist, /esbuild-platform',\s+slot/);
  assert.match(dist, /installedVersion !== version/);
  assert.match(dist, /requiresManagedEsbuildPlatform/);
  assert.match(dist, /resolvePaths\.unshift\(path\.dirname\(nodePath\)\)/);
  assert.match(
    dist,
    /esbuild host \$\{esbuildVersion\} does not match \$\{packageName\} \$\{platformVersion\}/,
  );
  assert.match(dist, /buildKfx\(kfxPackages, sdkBuildEnv\)/);
  assert.match(dist, /'bundle tui',[\s\S]+?env: tuiBuildEnv/);
  assert.match(dist, /'build gui',[\s\S]+?env: guiBuildEnv/);
  assert.match(
    dist,
    /electron-builder desktop product[\s\S]+?\.\.\.sdkBuildEnv/,
  );
  assert.doesNotMatch(
    dist,
    /process\.env\.ESBUILD_BINARY_PATH = buildEnv\.ESBUILD_BINARY_PATH/,
  );
});

test('product assembly stages have one ordered lifecycle owner', () => {
  assert.deepEqual(PRODUCT_ASSEMBLY_STAGE_IDS, [
    'discover',
    'dependencies',
    'core',
    'extensions',
    'ui',
    'desktop',
    'cli',
  ]);
  const dist = fs.readFileSync(new URL('./dist.mjs', import.meta.url), 'utf8');
  assert.match(dist, /runProductAssembly\(\{/);
  assert.doesNotMatch(dist, /buildchainLogger\.spanSync\(\s*'product\.dist'/);
});

test('platform package installs revalidate registry metadata', () => {
  const dist = fs.readFileSync(new URL('./dist.mjs', import.meta.url), 'utf8');
  assert.match(dist, /'--prefer-online'/);
  assert.doesNotMatch(dist, /'--prefer-offline'/);
});

test('esbuild platform binary follows the native package layout', () => {
  assert.equal(
    esbuildPlatformBinaryPath('C:\\pkg', 'win32'),
    path.join('C:\\pkg', 'esbuild.exe'),
  );
  assert.equal(
    esbuildPlatformBinaryPath('/pkg', 'linux'),
    path.join('/pkg', 'bin', 'esbuild'),
  );
  assert.equal(
    esbuildPlatformBinaryPath('/pkg', 'darwin'),
    path.join('/pkg', 'bin', 'esbuild'),
  );
});

test('no-optional builds isolate a mismatched esbuild platform binary', () => {
  assert.equal(
    requiresManagedEsbuildPlatform({
      noOptional: true,
      hostVersion: '0.25.12',
      platformVersion: '0.28.1',
    }),
    true,
  );
  assert.equal(
    requiresManagedEsbuildPlatform({
      noOptional: true,
      hostVersion: '0.25.12',
      platformVersion: '0.25.12',
    }),
    false,
  );
  assert.equal(
    requiresManagedEsbuildPlatform({
      noOptional: false,
      hostVersion: '0.25.12',
      platformVersion: '0.28.1',
    }),
    false,
  );
});

test('all product installs authorize deterministic non-interactive purges', () => {
  assert.deepEqual(installArgs(false), [
    'install',
    '--frozen-lockfile',
    '--config.confirmModulesPurge=false',
  ]);
  assert.deepEqual(installArgs(true), [
    'install',
    '--frozen-lockfile',
    '--no-optional',
    '--config.confirmModulesPurge=false',
  ]);
});
