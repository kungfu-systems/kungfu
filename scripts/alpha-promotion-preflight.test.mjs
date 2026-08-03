// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  aggregatePlatformReceipts,
  buildPlatformReceipt,
  buildWindowsContinuityFastReceipt,
  inspectAuditableDemoFastSentinel,
  inspectWindowsFastSentinel,
  runAlphaFastSentinel,
  verifyAggregateReceipt,
  verifyWindowsContinuityFastReceipt,
} from './alpha-promotion-preflight.mjs';

const ROOT_FILES = [
  '.github/actions/require-alpha-preflight/action.yml',
  '.github/workflows/alpha-promotion-preflight.yml',
  '.github/workflows/build.yml',
  '.github/workflows/embedding-membrane-spike.yml',
  '.github/workflows/release-new-version.yml',
  '.github/workflows/shifu-ci.yml',
  '.node-version',
  '.buildchain/alpha-contract-lock.json',
  '.buildchain/contract-lock.json',
  'crates/libwasm-spike/rust-toolchain.toml',
  'crates/libwasm-spike/wasmer/Cargo.lock',
  'crates/libwasm-spike/wasmtime/Cargo.lock',
  'docs/qualification/alpha-release-latency.contract.json',
  'docs/qualification/alpha-ruleset.contract.json',
  'docs/qualification/gates/execution-profiles.json',
  'docs/release-promotion-rehearsal.contract.json',
  'package.json',
  'pnpm-lock.yaml',
  'scripts/alpha-promotion-preflight.mjs',
  '.github/actions/require-alpha-preflight/alpha-macos-overflow.mjs',
  'scripts/alpha-publication-tail-plan.mjs',
  'scripts/alpha-cache-evidence.mjs',
  'scripts/alpha-release-timeline.mjs',
  'scripts/alpha-release-history.mjs',
  'scripts/alpha-ruleset.mjs',
  'scripts/probe-release-platform.mjs',
  'framework/core/src/python/kungfu/peer_lifecycle.py',
  'framework/core/tests/python/test_peer_lifecycle.py',
  'framework/core/tests/python/windows_continuity_sentinel.py',
  'framework/core/tests/fixtures/peer_lifecycle_probe.py',
  'scripts/run-shifu-lifecycle.mjs',
  'shifu.cmd',
  'shifu.gates.json',
];
const PLATFORMS = ['linux-x64', 'linux-arm64', 'macos-arm64', 'windows-x64'];

function git(root, ...args) {
  return childProcess
    .execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    .trim();
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ROOT_FILES) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${file}\n`);
  }
  fs.writeFileSync(
    path.join(root, 'shifu.cmd'),
    'if /i not "%~1"=="check:source" goto native\nsource-acceptance.mjs\n',
  );
  fs.writeFileSync(
    path.join(root, 'scripts/run-shifu-lifecycle.mjs'),
    [
      'export function windowsCmdArgs() {}',
      'windowsVerbatimArguments: true',
      "['/d', '/s', '/c']",
    ].join('\n'),
  );
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Preflight Test');
  git(root, 'config', 'user.email', 'preflight@example.invalid');
  git(root, 'add', '.');
  git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'fixture');
  return root;
}

function continuityScenario() {
  const phaseTimings = Object.fromEntries(
    [
      'initialReadiness',
      'hostCrashAdoption',
      'peerAdoption',
      'staleOwnerFencing',
      'peerRestartHealth',
      'cleanup',
    ].map((phase) => [phase, { durationMs: 25, deadlineMs: 10_000 }]),
  );
  const sample = (number) => ({
    sample: number,
    schema: 'kungfu.windows-continuity-fast-sentinel/v1',
    status: 'passed',
    phaseTimings,
    coverage: {
      realHostCrash: true,
      peerAdoption: true,
      peerRestart: true,
      restartedHealthy: true,
      staleOwnerFenced: true,
      cleanupComplete: true,
    },
  });
  return {
    schema: 'kungfu.windows-continuity-fast-sentinel/v1',
    status: 'passed',
    platform: {
      system: 'win32',
      machine: 'AMD64',
      python: '3.13.14',
      psutil: '6.1.1',
    },
    sampleCount: 2,
    samples: [sample(1), sample(2)],
    retryPolicy: 'none; repeated samples are independent qualifications',
  };
}

function aggregate(root, generatedAt = '2026-07-23T00:00:00.000Z') {
  return aggregatePlatformReceipts({
    root,
    generatedAt,
    receipts: PLATFORMS.map((platform) =>
      buildPlatformReceipt({ root, platform, generatedAt }),
    ),
  });
}

test('early source contracts bypass the platform-specific Shifu bootstrap', () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), '.github/workflows/alpha-promotion-preflight.yml'),
    'utf8',
  );
  assert.doesNotMatch(
    workflow,
    /run: \.\/shifu test:alpha-promotion-preflight/u,
  );
  assert.doesNotMatch(workflow, /scripts\/require-shifu\.mjs/u);
  assert.match(
    workflow,
    /node --test[\s\S]*scripts\/alpha-promotion-preflight\.test\.mjs[\s\S]*product\/scripts\/cli-surface-qualification\.test\.mjs/u,
  );
});

test('automatic hosted preflight does not inherit a private Cargo mirror', () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), '.github/workflows/alpha-promotion-preflight.yml'),
    'utf8',
  );
  assert.doesNotMatch(workflow, /vars\.BUILDCHAIN_CARGO_REGISTRY_INDEX/u);
  assert.match(
    workflow,
    /BUILDCHAIN_CARGO_REGISTRY_INDEX: \$\{\{ inputs\.cargo-registry-index \}\}/u,
  );
});

test('hosted preflight retries the public mirror before the official Rust fallback', () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), '.github/workflows/alpha-promotion-preflight.yml'),
    'utf8',
  );
  assert.match(workflow, /RUSTUP_PRIMARY_DIST_SERVER: https:\/\/rsproxy\.cn/u);
  assert.match(
    workflow,
    /RUSTUP_FALLBACK_DIST_SERVER: https:\/\/static\.rust-lang\.org/u,
  );
  assert.match(
    workflow,
    /install_toolchain[\s\S]*RUSTUP_PRIMARY_DIST_SERVER[\s\S]*3 \|\| install_toolchain[\s\S]*RUSTUP_FALLBACK_DIST_SERVER[\s\S]*1/u,
  );
});

test('formal Build uses Buildchain official Rust defaults after exact-source preflight', () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), '.github/workflows/build.yml'),
    'utf8',
  );
  assert.doesNotMatch(workflow, /rustup-dist-server:/u);
  assert.doesNotMatch(workflow, /rustup-update-root:/u);
});

test('consumer workflow delegates every declared signing request to Buildchain', () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), '.github/workflows/build.yml'),
    'utf8',
  );
  assert.doesNotMatch(workflow, /^ {2}credential-island-macos:$/mu);
  assert.doesNotMatch(workflow, /credential-island-macos-app-path:/u);
  assert.doesNotMatch(workflow, /credential-island-caller-owned:/u);
  assert.doesNotMatch(workflow, /credential-island-macos-platform-id:/u);
});

test('macOS products use Buildchain-native declarative signing', () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), '.github/workflows/build.yml'),
    'utf8',
  );
  const config = fs.readFileSync(
    path.join(process.cwd(), '.buildchain/buildchain.toml'),
    'utf8',
  );
  assert.match(
    workflow,
    /BUILDCHAIN_PROMOTION_TOKEN: \$\{\{ secrets\.KUNGFU_GITHUB_TOKEN \}\}/u,
  );
  assert.doesNotMatch(workflow, /name: buildchain-artifact-signing/u);
  assert.doesNotMatch(workflow, /BUILDCHAIN_MACOS_CERTIFICATE_/u);
  assert.doesNotMatch(workflow, /BUILDCHAIN_MACOS_NOTARY_/u);
  assert.doesNotMatch(
    workflow,
    /BUILDCHAIN_MACOS_EXPECTED_BUNDLE_ID/u,
    'consumer workflows must derive application identity through Buildchain',
  );
  assert.doesNotMatch(workflow, /name: alpha-macos-signing\s*$/mu);
  assert.match(
    config,
    /\[\[signing\.artifacts\]\][\s\S]*id = "kungfu-cli-macos-arm64"[\s\S]*kind = "archive"[\s\S]*platforms = \["macos-arm64"\]/u,
  );
  assert.match(
    config,
    /\[\[signing\.artifacts\]\][\s\S]*id = "kungfu-desktop-macos-arm64"[\s\S]*path = "product\/dist\/desktop\/mac-arm64\/Kungfu Episodes\.app"[\s\S]*kind = "app-bundle"[\s\S]*platforms = \["macos-arm64"\][\s\S]*required = true/u,
  );
});

test('workflow uses setup-node for platform receipts and clean Shifu argv for aggregation', () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), '.github/workflows/alpha-promotion-preflight.yml'),
    'utf8',
  );
  assert.doesNotMatch(workflow, /\.\/shifu alpha:promotion:preflight --/u);
  assert.match(
    workflow,
    /node scripts\/alpha-promotion-preflight\.mjs write-platform/u,
  );
  assert.doesNotMatch(
    workflow,
    /\.\/shifu alpha:promotion:preflight write-platform/u,
  );
  for (const command of ['aggregate', 'verify']) {
    assert.match(
      workflow,
      new RegExp(
        String.raw`\.\/shifu alpha:promotion:preflight ${command}`,
        'u',
      ),
    );
  }
});

test('aggregate receipt binds the exact commit, tree and reusable roots', (t) => {
  const root = fixture(t);
  const receipt = aggregate(root);
  assert.equal(
    verifyAggregateReceipt({
      root,
      receipt,
      expectedSourceCommit: git(root, 'rev-parse', 'HEAD'),
      now: Date.parse('2026-07-23T00:01:00.000Z'),
    }),
    receipt,
  );
  assert.deepEqual(receipt.reuse.excludedEvidence, [
    'credentials',
    'notarization',
    'publication',
    'signing',
  ]);
  assert.deepEqual(
    receipt.platforms.map((entry) => entry.platform),
    PLATFORMS,
  );
});

test('workflow, gate, toolchain and policy drift fail closed', (t) => {
  const root = fixture(t);
  for (const file of [
    '.github/workflows/build.yml',
    'shifu.gates.json',
    'crates/libwasm-spike/rust-toolchain.toml',
    'docs/qualification/gates/execution-profiles.json',
  ]) {
    const receipt = aggregate(root);
    fs.appendFileSync(path.join(root, file), 'drift\n');
    assert.throws(
      () =>
        verifyAggregateReceipt({
          root,
          receipt,
          expectedSourceCommit: git(root, 'rev-parse', 'HEAD'),
          now: Date.parse('2026-07-23T00:01:00.000Z'),
        }),
      /Root mismatch/u,
    );
    git(root, 'checkout', '--', file);
  }
});

test('receipt root, source commit, age and platform coverage fail closed', (t) => {
  const root = fixture(t);
  const now = Date.parse('2026-07-23T00:01:00.000Z');
  const receipt = aggregate(root);
  assert.throws(
    () =>
      verifyAggregateReceipt({
        root,
        receipt: { ...receipt, status: 'failed' },
        expectedSourceCommit: git(root, 'rev-parse', 'HEAD'),
        now,
      }),
    /receipt root mismatch/u,
  );
  assert.throws(
    () =>
      verifyAggregateReceipt({
        root,
        receipt,
        expectedSourceCommit: 'f'.repeat(40),
        now,
      }),
    /sourceCommit mismatch/u,
  );
  assert.throws(
    () =>
      verifyAggregateReceipt({
        root,
        receipt,
        expectedSourceCommit: git(root, 'rev-parse', 'HEAD'),
        now: Date.parse('2026-08-01T00:00:00.000Z'),
      }),
    /receipt age/u,
  );
});

test('current exact source passes both bounded pre-build sentinels', () => {
  assert.deepEqual(runAlphaFastSentinel('windows'), []);
  assert.deepEqual(runAlphaFastSentinel('auditable-demo'), []);
});

test('Windows continuity receipt binds the exact scenario and rejects drift', (t) => {
  const root = fixture(t);
  const sourceSha = git(root, 'rev-parse', 'HEAD');
  const receipt = buildWindowsContinuityFastReceipt({
    root,
    sourceSha,
    platform: 'win32',
    architecture: 'x64',
    nativeReport: continuityScenario(),
    nativeExitCode: 0,
    durationMs: 250,
  });

  assert.equal(receipt.status, 'passed');
  assert.equal(
    verifyWindowsContinuityFastReceipt({
      root,
      receipt,
      expectedSourceCommit: sourceSha,
      expectedPlatform: 'win32',
      expectedArchitecture: 'x64',
    }),
    receipt,
  );
  fs.appendFileSync(
    path.join(
      root,
      'framework/core/tests/python/windows_continuity_sentinel.py',
    ),
    'drift\n',
  );
  assert.throws(
    () =>
      verifyWindowsContinuityFastReceipt({
        root,
        receipt,
        expectedSourceCommit: sourceSha,
        expectedPlatform: 'win32',
      }),
    /Root mismatch/u,
  );
});

test('Windows continuity receipt fails closed for stale, partial, and non-Windows evidence', (t) => {
  const root = fixture(t);
  const sourceSha = git(root, 'rev-parse', 'HEAD');
  const partial = continuityScenario();
  partial.samples[0].coverage.restartedHealthy = false;
  for (const [platform, claimedSha, report] of [
    [
      'linux',
      sourceSha,
      { ...continuityScenario(), platform: { system: 'linux' } },
    ],
    ['win32', 'f'.repeat(40), continuityScenario()],
    ['win32', sourceSha, partial],
  ]) {
    const receipt = buildWindowsContinuityFastReceipt({
      root,
      sourceSha: claimedSha,
      platform,
      architecture: 'x64',
      nativeReport: report,
      nativeExitCode: 0,
    });
    assert.equal(receipt.status, 'failed');
    assert.throws(
      () =>
        verifyWindowsContinuityFastReceipt({
          root,
          receipt,
          expectedSourceCommit: sourceSha,
        }),
      /not qualifying/u,
    );
  }
});

test('fast sentinels fail the representative recent invalid fixtures', () => {
  const windowsIssues = inspectWindowsFastSentinel({
    shifuCmd: '@echo off\nif /i not "%~1"=="build" goto native\n',
    lifecycle: 'export function windowsCmdArgs() { return []; }\n',
  });
  assert.ok(windowsIssues.length >= 3);
  assert.match(
    windowsIssues.join('\n'),
    /source gate|source-acceptance|verbatim/u,
  );
  const demoIssues = inspectAuditableDemoFastSentinel({
    workflow:
      'uses: kungfu-systems/buildchain/.github/workflows/.declarative-auditable-demo.yml@main',
    scenario: {
      schema: 'buildchain.declarative-binary-demo/v1',
      execution: { durationClass: 'standard', totalTimeoutSeconds: 60 },
      authority: { grants: [] },
      demos: [],
    },
    product: '',
  });
  assert.ok(demoIssues.length >= 4);
  assert.match(
    demoIssues.join('\n'),
    /bounded two-demo cut|exact Buildchain SHA/u,
  );
});

test('patrol, normal Alpha builds and sentinels keep one controller authority', () => {
  const patrol = fs.readFileSync(
    '.github/workflows/dev-alpha-candidate-patrol.yml',
    'utf8',
  );
  const build = fs.readFileSync('.github/workflows/build.yml', 'utf8');
  assert.match(
    patrol,
    /group: dev-alpha-candidate-patrol-\$\{\{ github\.repository \}\}-\$\{\{ github\.event\.repository\.default_branch \}\}[\s\S]*cancel-in-progress: false/u,
  );
  assert.match(
    patrol,
    /reactivation-authorized:\s*\$\{\{\s*github\.event_name == 'workflow_dispatch' && inputs\.create-pull-request && inputs\.reactivation-authorized\s*\}\}/u,
  );
  assert.match(
    build,
    /format\('alpha-promotion-build-\{0\}', github\.event\.pull_request\.base\.ref \|\| github\.ref\)/u,
  );
  assert.doesNotMatch(
    build,
    /alpha-promotion-build-\{0\}'.*pull_request\.number/u,
  );
  assert.match(build, /windows-fast-sentinel:[\s\S]*runs-on: windows-2025/u);
  assert.match(
    build,
    /windows-fast-sentinel:[\s\S]*outputs:[\s\S]*receipt-root:[\s\S]*continuity-input-root:/u,
  );
  assert.match(
    build,
    /Run real Windows crash and restart continuity sentinel[\s\S]*verify-fast-sentinel/u,
  );
  assert.match(
    build,
    /KUNGFU_EXACT_SOURCE_SHA:[\s\S]*fast-sentinel --kind windows --source-commit \$env:KUNGFU_EXACT_SOURCE_SHA[\s\S]*verify-fast-sentinel[\s\S]*--source-commit \$env:KUNGFU_EXACT_SOURCE_SHA/u,
  );
  assert.doesNotMatch(
    build.slice(
      build.indexOf('  windows-fast-sentinel:'),
      build.indexOf('  auditable-demo-fast-sentinel:'),
    ),
    /^\s*GITHUB_SHA:/mu,
  );
  assert.match(
    build,
    /auditable-demo-fast-sentinel:[\s\S]*runs-on: ubuntu-24\.04/u,
  );
  assert.match(
    build,
    /needs: \[preflight, windows-fast-sentinel, auditable-demo-fast-sentinel\]/u,
  );
  assert.match(
    build,
    /fast-sentinels-only:[\s\S]*Run only the exact-source Windows continuity and auditable-demo fast sentinels/u,
  );
  assert.match(
    build,
    /preflight:[\s\S]*if: \$\{\{ github\.event_name != 'workflow_dispatch' \|\| !inputs\.fast-sentinels-only \}\}/u,
  );
  assert.match(
    build,
    /windows-fast-sentinel:[\s\S]*always\(\)[\s\S]*inputs\.fast-sentinels-only[\s\S]*needs\.preflight\.result == 'skipped'/u,
  );
  assert.match(build, /build:[\s\S]*!inputs\.fast-sentinels-only/u);
  const preBuild = build.slice(0, build.indexOf('\n  build:'));
  assert.doesNotMatch(
    preBuild,
    /actions\/upload-artifact|npm publish|gh release|git tag/iu,
  );
});
