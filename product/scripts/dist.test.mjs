// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cliLauncherContent } from './cli-launcher.mjs';
import {
  cliArchiveBase,
  cliArchiveLayout,
  desktopUpdaterArtifact,
  esbuildPlatformBinaryPath,
  installedKungfuInvocation,
  kfxBundleExternalModules,
  requiresManagedEsbuildPlatform,
  runInstalledKungfuCommand,
  stageXinfaContract,
  verifyProductObservabilityEvents,
} from './dist.mjs';
import {
  productReleaseChannelConfig,
  releaseChannelKeyId,
} from './release-channel-trust.mjs';

const require = createRequire(import.meta.url);
const workDashboardPackage = require('../../extensions/work-dashboard/package.json');
const sdkPackage = require('../../developer/sdk/package.json');
const agentHubKfdLock = require('../../tests/qualification/agent-hub-20/kfd-lock.json');
const {
  esmEntrypointArgs,
  toEsmEntrypointSpecifier,
} = require('../../framework/gui/scripts/before-pack.cjs');

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
  assert.equal(cliArchiveBase('win32-x64'), 'kungfu-episodes-cli-win32-x64');
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
    compatibility: 'runtime/product-compatibility.json',
  });
  assert.deepEqual(cliArchiveLayout('win32'), {
    launcherName: 'kungfu.cmd',
    runtimeDirectory: 'runtime',
    runtimeEntrypoint: 'runtime/kungfu.exe',
    compatibility: 'runtime/product-compatibility.json',
  });
  assert.match(cliLauncherContent('darwin'), /exec "\$here\/runtime\/kungfu"/);
  assert.match(cliLauncherContent('win32'), /%~dp0runtime\\kungfu\.exe/);
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

test('product observability ignores errors from sibling components', () => {
  const names = [
    ['product.dist.start', 'prepare'],
    ['product.kfx.dependencies.declared', 'dependencies'],
    ['product.dependencies.sync.start', 'dependencies'],
    ['product.core.rebuild.start', 'core'],
    ['product.core.freeze.start', 'core'],
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
    '../../framework/gui/scripts/gen-first-party-manifest.mjs',
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
    '../../framework/gui/scripts/gen-first-party-manifest.mjs',
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
  const config = fs.readFileSync(
    new URL('../electron-builder.yml', import.meta.url),
    'utf8',
  );
  for (const target of ['sdk', 'kfd', 'templates', 'node_modules']) {
    assert.match(
      config,
      new RegExp(`desktop-authoring/${target}\\n\\s+to: ${target}`),
    );
  }
});

test('desktop product carries the externalized Agent Session runtime', () => {
  const config = fs.readFileSync(
    new URL('../electron-builder.yml', import.meta.url),
    'utf8',
  );
  assert.match(config, /from: \.\.\/agent-session/);
  assert.match(config, /to: app\/node_modules\/@kungfu-tech\/agent-session/);
});

test('desktop product declares prerelease update metadata without implicit publishing', () => {
  const config = fs.readFileSync(
    new URL('../electron-builder.yml', import.meta.url),
    'utf8',
  );
  assert.match(config, /publish:\n\s+- provider: github/);
  assert.match(config, /owner: kungfu-systems/);
  assert.match(config, /repo: kungfu/);
  assert.match(config, /channel: alpha/);
  assert.match(config, /releaseType: prerelease/);
  assert.match(config, /generateUpdatesFilesForAllChannels: true/);
  const launcher = fs.readFileSync(
    new URL(
      '../../framework/gui/scripts/run-electron-builder.mjs',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(launcher, /--publish=never/);
  assert.match(
    config,
    /dist\/update\/kungfu-release-manifest\.json\n\s+to: upgrade\/kungfu-release-manifest\.json/,
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
    new URL('../../developer/sdk/src/sdk.js', import.meta.url),
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
  const dist = fs.readFileSync(new URL('./dist.mjs', import.meta.url), 'utf8');
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
