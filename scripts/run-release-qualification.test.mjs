// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  probeAwsMacosJitRunner,
  probeReleasePlatform,
} from './probe-release-platform.mjs';
import {
  executeReleaseQualificationStages,
  loadExecutionProfile,
  parseExecutionProfile,
  parseReleaseQualificationOptions,
  prepareReleaseQualificationHistory,
  prepareReleaseQualificationOutput,
  qualificationHostTemporary,
  releaseQualificationEnvironment,
  releaseQualificationExecutionGroups,
  releaseQualificationStages,
  verifyCorePlatformRelease,
  verifySourceOnlyEvidence,
} from './run-release-qualification.mjs';

function corePlatformReleaseFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-core-release-'));
  const packageName = '@kungfu-tech/core-linux-arm64';
  const version = '4.0.0-alpha.1';
  const archiveName = 'kungfu-tech-core-linux-arm64-4.0.0-alpha.1.tgz';
  const archive = path.join(root, 'product/release/npm', archiveName);
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, 'exact archive\n');
  fs.mkdirSync(path.join(root, 'framework/core'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'framework/core/package.json'),
    JSON.stringify({ name: '@kungfu-tech/core', version }),
  );
  fs.writeFileSync(
    path.join(root, 'framework/core/core-platform-package.contract.json'),
    JSON.stringify({
      platformPackages: [
        {
          key: 'linux-arm64',
          name: packageName,
          os: ['linux'],
          cpu: ['arm64'],
        },
      ],
      platformPayload: {
        requiredPathPatterns: [
          '^dist/kungfu/kungfu$',
          '^dist/kungfu/kungfu_node\\.node$',
        ],
      },
    }),
  );
  fs.writeFileSync(
    `${archive}.receipt.json`,
    JSON.stringify({
      schema: 'kungfu.core-platform-package.receipt/v1',
      package: packageName,
      version,
      platform: 'linux-arm64',
      archive: archiveName,
      sha256: createHash('sha256')
        .update(fs.readFileSync(archive))
        .digest('hex'),
      files: ['dist/kungfu/kungfu', 'dist/kungfu/kungfu_node.node'],
      executables: ['dist/kungfu/kungfu'],
      nativeLibraries: ['dist/kungfu/kungfu_node.node'],
      prohibitedContent: { status: 'passing', paths: [] },
    }),
  );
  return { root, archive };
}

function writeMacApplication(root) {
  const application = path.join(
    root,
    'product',
    'dist',
    'desktop',
    'mac-arm64',
    'Kungfu Episodes.app',
  );
  fs.mkdirSync(path.join(application, 'Contents', 'MacOS'), {
    recursive: true,
  });
  fs.writeFileSync(path.join(application, 'Contents', 'Info.plist'), 'plist\n');
  fs.writeFileSync(
    path.join(application, 'Contents', 'MacOS', 'Kungfu Episodes'),
    'binary\n',
  );
  return application;
}

function writeCredentialIslandPolicy(root, overrides = {}) {
  const policyPath = path.join(
    root,
    'docs',
    'qualification',
    'gates',
    'macos-credential-island-policy.json',
  );
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(
    policyPath,
    JSON.stringify({
      schema: 'kungfu.macos-credential-island-policy/v1',
      repository: 'kungfu-systems/kungfu',
      environment: 'buildchain-artifact-signing',
      platformId: 'macos-arm64',
      app: { bundleId: 'com.kungfu.app', architecture: 'arm64' },
      identity: {
        teamId: 'AAAAAAAAAA',
        certificateSha1: 'a'.repeat(40),
      },
      requiredVerifications: [
        'codesignStrict',
        'hardenedRuntime',
        'appStaple',
        'appGatekeeper',
        'dmgStaple',
        'dmgGatekeeper',
      ],
      ...overrides,
    }),
  );
}

test('qualification temp state is repository scoped on every platform', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-release-env-'));
  try {
    const env = releaseQualificationEnvironment(root, {
      TMPDIR: '/host/tmpdir',
      TEMP: '/host/temp',
      TMP: '/host/tmp',
    });
    const expected = path.join(root, '.buildchain', 'tmp');
    assert.equal(env.TMPDIR, expected);
    assert.equal(env.TEMP, expected);
    assert.equal(env.TMP, expected);
    assert.equal(env.KUNGFU_QUALIFICATION_HOST_TEMP, '/tmp');
    assert.match(env.KF_UPGRADE_QUALIFICATION_REF, /^buildchain-retained:/);
    assert.match(env.KF_RUNTIME_ARTIFACT_SIGNATURE, /#runtime$/);
    assert.match(env.KF_DESKTOP_ARTIFACT_SIGNATURE, /#desktop$/);
    assert.match(env.KF_CLI_ARTIFACT_SIGNATURE, /#cli$/);
    assert.equal(fs.statSync(expected).isDirectory(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('qualification host temp remains short on POSIX and preserves Windows runner temp', () => {
  assert.equal(
    qualificationHostTemporary(
      { TMPDIR: '/very/long/repository/scoped/build/temp' },
      'linux',
    ),
    '/tmp',
  );
  assert.equal(
    qualificationHostTemporary(
      { RUNNER_TEMP: 'D:\\a\\_temp', TEMP: 'D:\\long\\checkout\\tmp' },
      'win32',
    ),
    'D:\\a\\_temp',
  );
});

test('each qualification run replaces only its generated evidence root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-release-output-'));
  const qualification = path.join(root, 'product/release/qualification');
  const releaseArtifact = path.join(root, 'product/release/desktop/app.zip');
  try {
    fs.mkdirSync(qualification, { recursive: true });
    fs.writeFileSync(path.join(qualification, 'stale-report.json'), '{}\n');
    fs.mkdirSync(path.dirname(releaseArtifact), { recursive: true });
    fs.writeFileSync(releaseArtifact, 'artifact\n');

    assert.equal(prepareReleaseQualificationOutput(root), qualification);
    assert.equal(fs.statSync(qualification).isDirectory(), true);
    assert.deepEqual(fs.readdirSync(qualification), []);
    assert.equal(fs.readFileSync(releaseArtifact, 'utf8'), 'artifact\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cheap platform probe runs before every expensive qualification stage', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.equal(
      releaseQualificationStages(platform)[0][0],
      'release:probe:platform',
    );
  }
});

test('AWS macOS JIT probe binds the host, instance, source, and toolchain', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-macos-jit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { report, output } = probeAwsMacosJitRunner({
    root,
    platform: 'darwin',
    env: {
      BUILDCHAIN_RUNNER_LABELS_JSON: JSON.stringify([
        'self-hosted',
        'macOS',
        'ARM64',
        'aws-us-ec2-macos-jit-mac-smoke-01',
      ]),
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_RUN_ID: '1234',
      GITHUB_RUN_ATTEMPT: '1',
      RUNNER_NAME: 'mac-jit',
      AWS_EC2_MAC_HOST_ID: 'h-0123abc',
      AWS_EC2_MAC_HOST_ALLOCATED_AT: '2026-07-30T00:00:00Z',
      AWS_EC2_INSTANCE_ID: 'i-0123abc',
      AWS_EC2_INSTANCE_TYPE: 'mac2.metal',
      AWS_EC2_AMI_ID: 'ami-0123abc',
      AWS_EC2_AMI_NAME: 'amzn-ec2-macos-15.7.7',
      AWS_EC2_AVAILABILITY_ZONE: 'us-east-1a',
      AWS_EC2_LAUNCHED_AT: '2026-07-30T00:05:00Z',
    },
    runCommand: (command, args) => `${command} ${args.join(' ')}`,
  });
  assert.equal(report.contract, 'kungfu.aws-macos-jit-runner-profile/v1');
  assert.equal(report.aws.hostId, 'h-0123abc');
  assert.equal(report.aws.instanceId, 'i-0123abc');
  assert.equal(report.sourceSha, 'a'.repeat(40));
  assert.equal(report.toolchain.developerDirectory, 'xcode-select -p');
  assert.equal(report.toolchain.clang, 'xcrun clang --version');
  assert.equal('xcodebuild' in report.toolchain, false);
  assert.match(report.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(output), true);
});

test('Linux ARM64 release qualification is bounded to the exact Core artifact', () => {
  assert.deepEqual(
    releaseQualificationStages(
      'linux',
      loadExecutionProfile('alpha'),
      'required',
      'product',
      'arm64',
    ),
    [['release:qualify:core-platform']],
  );
});

test('accepts an exact Linux ARM64 Core archive and receipt', (t) => {
  const value = corePlatformReleaseFixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const report = verifyCorePlatformRelease({
    root: value.root,
    platform: 'linux',
    arch: 'arm64',
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.package, '@kungfu-tech/core-linux-arm64');
});

test('fails closed when Core archive bytes differ from the receipt', (t) => {
  const value = corePlatformReleaseFixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  fs.appendFileSync(value.archive, 'tampered\n');
  assert.throws(
    () =>
      verifyCorePlatformRelease({
        root: value.root,
        platform: 'linux',
        arch: 'arm64',
      }),
    /sha256 mismatch/u,
  );
});

test('macOS platform probe defers final signature authority to the credential island', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-macos-probe-'));
  try {
    writeMacApplication(root);
    writeCredentialIslandPolicy(root);
    let codesignCalls = 0;
    const report = probeReleasePlatform({
      root,
      platform: 'darwin',
      runCommand: () => {
        codesignCalls += 1;
      },
    });
    assert.deepEqual(report, {
      platform: 'darwin',
      check: 'credential-island-application-structure',
      finalSignature: 'deferred',
      status: 'passed',
    });
    assert.equal(codesignCalls, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('macOS platform probe keeps codesign verification without credential-island policy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-macos-probe-'));
  try {
    const application = writeMacApplication(root);
    const calls = [];
    const report = probeReleasePlatform({
      root,
      platform: 'darwin',
      runCommand: (...args) => calls.push(args),
    });
    assert.deepEqual(report, {
      platform: 'darwin',
      check: 'codesign-structure',
      status: 'passed',
    });
    assert.deepEqual(calls, [
      [
        'codesign',
        ['--verify', '--deep', '--strict', '--verbose=2', application],
      ],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('macOS platform probe fails closed on incomplete credential-island policy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-macos-probe-'));
  try {
    writeMacApplication(root);
    writeCredentialIslandPolicy(root, {
      requiredVerifications: ['codesignStrict'],
    });
    assert.throws(
      () => probeReleasePlatform({ root, platform: 'darwin' }),
      /macOS credential-island policy is incomplete/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('qualification reuses repository-scoped native optional packages across suites', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-release-env-'));
  try {
    const env = releaseQualificationEnvironment(root, {
      NODE_PATH: '/inherited/node-path',
    });
    const target = `${process.platform}-${process.arch}`;
    const expected = [
      path.join(
        root,
        '.buildchain',
        'libnode-platform',
        target,
        'node_modules',
      ),
      path.join(root, '.buildchain', 'rollup-platform', target, 'node_modules'),
      ...['sdk', 'tui', 'gui'].map((slot) =>
        path.join(
          root,
          '.buildchain',
          'esbuild-platform',
          slot,
          target,
          'node_modules',
        ),
      ),
      '/inherited/node-path',
    ];
    assert.deepEqual(env.NODE_PATH.split(path.delimiter), expected);

    const fixture = path.join(expected[0], '@fixture', 'native-platform');
    fs.mkdirSync(fixture, { recursive: true });
    fs.writeFileSync(
      path.join(fixture, 'package.json'),
      JSON.stringify({ name: '@fixture/native-platform', main: 'index.js' }),
    );
    fs.writeFileSync(path.join(fixture, 'index.js'), 'module.exports = 42;\n');
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        "process.exit(require('@fixture/native-platform') === 42 ? 0 : 1)",
      ],
      { env },
    );
    assert.equal(child.status, 0, child.stderr?.toString());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hosted qualification preserves the short runner temp before redirecting build temp', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-runner-env-'));
  try {
    const env = releaseQualificationEnvironment(root, {
      RUNNER_TEMP: 'D:\\a\\_temp',
      TEMP: 'D:\\a\\kungfu\\kungfu\\.buildchain\\tmp',
    });
    assert.equal(env.KUNGFU_QUALIFICATION_HOST_TEMP, 'D:\\a\\_temp');
    assert.equal(env.TEMP, path.join(root, '.buildchain', 'tmp'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const names = (platform) =>
  releaseQualificationStages(platform).map(([name]) => name);

test('canonical Episode release evidence runs once on the Linux release leg', () => {
  assert.ok(names('linux').includes('episode:qualify:release'));
  assert.ok(!names('darwin').includes('episode:qualify:release'));
  assert.ok(!names('win32').includes('episode:qualify:release'));
});

test('ADR admission follows Episode evidence only on the Linux release leg', () => {
  const linux = names('linux');
  assert.equal(
    linux.indexOf('adr:release:gate'),
    linux.indexOf('episode:qualify:release') + 1,
  );
  assert.ok(!names('darwin').includes('adr:release:gate'));
  assert.ok(!names('win32').includes('adr:release:gate'));
});

test('release qualification hydrates complete Git history only on Linux', () => {
  const calls = [];
  const prepare = (root) => {
    calls.push(root);
    return 'fetched-origin';
  };
  assert.equal(
    prepareReleaseQualificationHistory('/source', 'linux', prepare),
    'fetched-origin',
  );
  assert.equal(
    prepareReleaseQualificationHistory('/source', 'darwin', prepare),
    'not-required',
  );
  assert.equal(
    prepareReleaseQualificationHistory('/source', 'win32', prepare),
    'not-required',
  );
  assert.equal(
    prepareReleaseQualificationHistory('/source', 'linux', prepare, 'arm64'),
    'not-required',
  );
  assert.deepEqual(calls, ['/source']);
});

test('every platform runs the complete qualification stage sequence', () => {
  const required = [
    'release:probe:platform',
    'verify',
    'live-peer:qualify',
    'runtime:qualify',
    'test:upgrade-qualification',
    'zero-burden:qualify',
    'gate',
    'upgrade:qualify:native',
    'invariant:verify',
  ];
  for (const platform of ['linux', 'darwin', 'win32'])
    assert.deepEqual(
      names(platform).filter(
        (name) =>
          name !== 'episode:qualify:release' && name !== 'adr:release:gate',
      ),
      required,
    );
});

test('manual qualification can explicitly omit the credential-bearing native signing campaign', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const stages = releaseQualificationStages(
      platform,
      loadExecutionProfile('alpha'),
      'skip',
    ).map(([name]) => name);
    assert.ok(stages.includes('zero-burden:qualify'));
    assert.ok(stages.includes('gate'));
    assert.ok(!stages.includes('upgrade:qualify:native'));
  }
});

test('cryptographic upgrade qualification runs before artifact layer admission', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const stages = names(platform);
    assert.ok(
      stages.indexOf('test:upgrade-qualification') < stages.indexOf('gate'),
    );
  }
});

test('alpha and release qualification retain the live Peer report and raw bundle', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const continuity = releaseQualificationStages(platform).find(
      ([name]) => name === 'live-peer:qualify',
    );
    assert.deepEqual(continuity, [
      'live-peer:qualify',
      '--',
      '--retain',
      'product/release/qualification/live-peer-continuity',
    ]);
  }
});

test('alpha and release qualification retain the complete runtime report and log bundle', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const runtime = releaseQualificationStages(platform).find(
      ([name]) => name === 'runtime:qualify',
    );
    assert.deepEqual(runtime, [
      'runtime:qualify',
      '--',
      '--mode',
      'execute',
      '--with-product',
      '--retain',
      'product/release/qualification/runtime-activation',
    ]);
  }
});

test('alpha and release qualification retain the cross-layer desktop report and raw bundle', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const aggregate = releaseQualificationStages(platform).find(
      ([name]) => name === 'zero-burden:qualify',
    );
    assert.deepEqual(aggregate, [
      'zero-burden:qualify',
      '--',
      '--retain',
      'product/release/qualification/zero-burden-desktop',
    ]);
  }
});

test('the Buildchain artifact contract requires the common lane summary', () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), '.github', 'workflows', 'build.yml'),
    'utf8',
  );
  const encoded = workflow.match(
    /expected-artifacts-json: >-\n\s+(\{[^\n]+\})/u,
  )?.[1];
  assert.ok(encoded, 'build workflow must declare expected-artifacts-json');
  const expected = JSON.parse(encoded);
  assert.deepEqual(expected.requiredPaths, [
    'product/release/qualification/layer-qualification-summary.json',
  ]);
  assert.equal(expected.minFiles, 3);
});

test('the Gate stage emits one source-bound receipt for all artifact layers', () => {
  const gateStage = releaseQualificationStages('darwin').find(
    ([name]) => name === 'gate',
  );
  assert.deepEqual(gateStage.slice(0, 5), [
    'gate',
    'run',
    'layers.format',
    'layers.sdk',
    'layers.surfaces',
  ]);
  assert.ok(gateStage.includes('--receipt'));
  assert.ok(gateStage.includes('--overwrite'));
  assert.ok(!gateStage.includes('pack:spec'));
  assert.ok(!gateStage.includes('layers:qualify:format'));
});

test('execution profiles propagate bounded Episode and receipt parameters', () => {
  const alpha = loadExecutionProfile('alpha');
  assert.deepEqual(
    {
      budgetSeconds: alpha.parameters.budgetSeconds,
      upstreamBudgetSeconds: alpha.parameters.upstreamBudgetSeconds,
      reserveSeconds: alpha.parameters.reserveSeconds,
    },
    {
      budgetSeconds: 8400,
      upstreamBudgetSeconds: 4200,
      reserveSeconds: 600,
    },
  );
  assert.equal(
    alpha.parameters.budgetSeconds -
      alpha.parameters.upstreamBudgetSeconds -
      alpha.parameters.reserveSeconds,
    3600,
  );
  const release = loadExecutionProfile('release-candidate');
  const stages = releaseQualificationStages('linux', release);
  const episode = stages.find(([name]) => name === 'episode:qualify:release');
  assert.deepEqual(episode.slice(1, 4), [
    '--',
    '--profile',
    'mvp-candidate-v1',
  ]);
  const gate = stages.find(([name]) => name === 'gate');
  const context = JSON.parse(gate[gate.indexOf('--execution-context') + 1]);
  assert.equal(context.executionProfile, 'release-candidate');
  assert.equal(context.effectiveParameters.episodeTimeoutSeconds, 1200);
  assert.match(context.policyDigest, /^sha256:[0-9a-f]{64}$/);
});

test('native upgrade evidence is retained only after exact artifact gates pass', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const stages = names(platform);
    assert.equal(
      stages.indexOf('upgrade:qualify:native'),
      stages.indexOf('gate') + 1,
    );
  }
});

test('Hub CLI scope retains headless evidence without claiming desktop or SDK artifacts', () => {
  const stages = releaseQualificationStages(
    'linux',
    loadExecutionProfile('alpha'),
    'skip',
    'hub-cli',
  );
  const stageNames = stages.map(([name]) => name);
  for (const required of [
    'release:probe:platform',
    'verify',
    'live-peer:qualify',
    'runtime:qualify',
    'test:upgrade-qualification',
    'episode:qualify:release',
    'adr:release:gate',
    'gate',
    'invariant:verify',
  ])
    assert.ok(stageNames.includes(required), required);
  assert.ok(!stageNames.includes('zero-burden:qualify'));
  assert.ok(!stageNames.includes('upgrade:qualify:native'));

  const gate = stages.find(([name]) => name === 'gate');
  assert.deepEqual(gate.slice(0, 3), ['gate', 'run', 'layers.format']);
  assert.ok(!gate.includes('layers.sdk'));
  assert.ok(!gate.includes('layers.surfaces'));
  const context = JSON.parse(gate[gate.indexOf('--execution-context') + 1]);
  assert.deepEqual(Object.keys(context).sort(), [
    'effectiveParameters',
    'executionProfile',
    'policyDigest',
    'policyRef',
  ]);
  assert.ok(!Object.hasOwn(context, 'artifactScope'));
});

test('execution profile parsing fails closed on missing, duplicate, and unknown values', () => {
  assert.equal(
    parseExecutionProfile(['--execution-profile', 'alpha']),
    'alpha',
  );
  assert.throws(() => parseExecutionProfile([]), /is required/);
  assert.throws(
    () =>
      parseExecutionProfile([
        '--execution-profile',
        'alpha',
        '--execution-profile',
        'release-candidate',
      ]),
    /specified once/,
  );
  assert.throws(() => loadExecutionProfile('missing'), /unknown/);
  assert.deepEqual(
    parseReleaseQualificationOptions([
      '--execution-profile',
      'alpha',
      '--native-upgrade-policy',
      'skip',
    ]),
    {
      executionProfile: 'alpha',
      nativeUpgradePolicy: 'skip',
      artifactScope: 'product',
      sourceOnlyEvidence: null,
    },
  );
  assert.deepEqual(
    parseReleaseQualificationOptions([
      '--execution-profile',
      'alpha',
      '--native-upgrade-policy',
      'skip',
      '--artifact-scope',
      'hub-cli',
    ]),
    {
      executionProfile: 'alpha',
      nativeUpgradePolicy: 'skip',
      artifactScope: 'hub-cli',
      sourceOnlyEvidence: null,
    },
  );
  assert.throws(
    () =>
      parseReleaseQualificationOptions([
        '--execution-profile',
        'alpha',
        '--artifact-scope',
        'hub-cli',
      ]),
    /requires --native-upgrade-policy skip/,
  );
  assert.throws(
    () =>
      parseReleaseQualificationOptions([
        '--execution-profile',
        'alpha',
        '--native-upgrade-policy',
        'invalid',
      ]),
    /must be required or skip/,
  );
  assert.throws(
    () =>
      parseReleaseQualificationOptions([
        '--execution-profile',
        'alpha',
        '--native-upgrade-policy',
        'required',
        '--native-upgrade-policy',
        'skip',
      ]),
    /may be specified once/,
  );
  const sourceOnlyEvidence = {
    receiptRoot: `sha256:${'a'.repeat(64)}`,
    sourceTree: 'b'.repeat(40),
    policyRoot: `sha256:${'c'.repeat(64)}`,
  };
  assert.deepEqual(
    parseReleaseQualificationOptions([
      '--execution-profile',
      'alpha',
      '--native-upgrade-policy',
      'skip',
      '--source-only-receipt-root',
      sourceOnlyEvidence.receiptRoot,
      '--source-only-source-tree',
      sourceOnlyEvidence.sourceTree,
      '--source-only-policy-root',
      sourceOnlyEvidence.policyRoot,
    ]).sourceOnlyEvidence,
    sourceOnlyEvidence,
  );
  assert.throws(
    () =>
      parseReleaseQualificationOptions([
        '--execution-profile',
        'alpha',
        '--source-only-receipt-root',
        sourceOnlyEvidence.receiptRoot,
      ]),
    /requires receipt root, source tree, and policy root/,
  );
});

test('source-only evidence fails closed on tree drift', () => {
  const evidence = {
    receiptRoot: `sha256:${'a'.repeat(64)}`,
    sourceTree: 'b'.repeat(40),
    policyRoot: `sha256:${'c'.repeat(64)}`,
  };
  assert.deepEqual(
    verifySourceOnlyEvidence(evidence, { sourceTree: evidence.sourceTree }),
    evidence,
  );
  assert.throws(
    () => verifySourceOnlyEvidence(evidence, { sourceTree: 'd'.repeat(40) }),
    /tree mismatch/,
  );
});

test('artifact admission and invariant verification run as one fail-closed sibling group', async () => {
  const stages = [['gate'], ['invariant:verify']];
  assert.deepEqual(releaseQualificationExecutionGroups(stages, true), [stages]);
  assert.deepEqual(releaseQualificationExecutionGroups(stages, false), [
    [['gate']],
    [['invariant:verify']],
  ]);
  assert.deepEqual(
    releaseQualificationExecutionGroups(
      [['gate'], ['upgrade:qualify:native'], ['invariant:verify']],
      true,
    ),
    [[['gate']], [['upgrade:qualify:native']], [['invariant:verify']]],
  );
  const observed = [];
  let active = 0;
  let peak = 0;
  const asyncRunner = async (args) => {
    active += 1;
    peak = Math.max(peak, active);
    observed.push(args[0]);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return args[0] === 'gate' ? 1 : 0;
  };
  const result = await executeReleaseQualificationStages(stages, {
    env: { SHIFU_CACHE_ACTIVE: '1' },
    asyncRunner,
  });
  assert.equal(peak, 2);
  assert.deepEqual(observed.sort(), ['gate', 'invariant:verify']);
  assert.equal(result.finalStatus, 1);
  assert.equal(result.timings.length, 2);
  assert.equal(
    result.timings.find((row) => row.stage === 'invariant:verify').status,
    0,
  );
});

test('execution profile numeric constraints reject zero and negative values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-profile-'));
  try {
    const valid = JSON.parse(
      fs.readFileSync(
        path.join(
          process.cwd(),
          'docs/qualification/gates/execution-profiles.json',
        ),
        'utf8',
      ),
    );
    valid.profiles.alpha.budgetSeconds = 0;
    const file = path.join(root, 'profiles.json');
    fs.writeFileSync(file, JSON.stringify(valid));
    assert.throws(
      () => loadExecutionProfile('alpha', file),
      /positive integer/,
    );
    valid.profiles.alpha.budgetSeconds = 8400;
    valid.profiles.alpha.reserveSeconds = -1;
    fs.writeFileSync(file, JSON.stringify(valid));
    assert.throws(
      () => loadExecutionProfile('alpha', file),
      /positive integer/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
