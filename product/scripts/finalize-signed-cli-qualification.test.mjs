// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  cliQualificationNonClaims,
  cliQualificationRoot,
} from './cli-surface-qualification.mjs';
import {
  bindSignedMacosRuntimeQualification,
  finalizeSignedCliQualification,
  ptyDriverSource,
  signedMacosRuntimeReceiptRoot,
  verifyCodesignEntitlements,
} from './verify-cli-surface-qualification.mjs';

const SCRIPT = fileURLToPath(
  new URL('./verify-cli-surface-qualification.mjs', import.meta.url),
);
const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SOURCE = '1'.repeat(40);
const BEFORE = `sha256:${'a'.repeat(64)}`;
const AFTER = `sha256:${'b'.repeat(64)}`;
const PROVIDER_EVIDENCE = `sha256:${'d'.repeat(64)}`;
const EVIDENCE_DIGEST = `sha256:${'e'.repeat(64)}`;
const JIT_EXECUTABLES = [
  'kungfu-episodes-cli-darwin-arm64/runtime/kungfu',
  'kungfu-episodes-cli-darwin-arm64/runtime/python/bin/python3',
  'kungfu-episodes-cli-darwin-arm64/runtime/python/bin/python3.13',
];

test('post-sign PTY driver does not leak embedded Node mode into the CLI', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-pty-driver-'));
  try {
    const fakeNodePty = path.join(root, 'node-pty.cjs');
    fs.writeFileSync(
      fakeNodePty,
      [
        'module.exports = {',
        '  spawn(command, args, options) {',
        "    const output = `KUNGFU_TUI_DEMO_COMPLETE variant=${Object.hasOwn(options.env, 'KUNGFU_AS_VARIANT')}`;",
        '    return {',
        '      onData(callback) { callback(output); },',
        '      onExit(callback) { callback({exitCode: 0}); },',
        '      kill() {},',
        '    };',
        '  },',
        '};',
      ].join('\n'),
    );
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        ptyDriverSource(),
        fakeNodePty,
        '/fixture/kungfu',
        JSON.stringify(['agent-work-lab', 'autoplay']),
        'KUNGFU_TUI_DEMO_COMPLETE variant=false',
        '1000',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, KUNGFU_AS_VARIANT: 'node' },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /KUNGFU_TUI_DEMO_COMPLETE variant=false/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function qualification() {
  const report = {
    schema: 'kungfu.cli-installed-product-qualification/v1',
    qualified: true,
    label: 'cli-archive',
    identity: {
      archive: 'kungfu-episodes-cli-darwin-arm64.tar.gz',
      archiveSha256: BEFORE,
      sourceCommit: SOURCE,
    },
    platform: 'darwin-arm64',
    architecture: 'arm64',
    version: '4.0.0-alpha.1',
    claims: {
      installedProduct: true,
      qualifiedPlatform: 'darwin-arm64',
    },
    productIdentity: {
      verifiedFromInstalledCommand: true,
    },
    checks: {
      kfd3: { linkedApiCount: 1 },
      mutationPlanReceipt: {
        planReplayStable: true,
        receiptVerified: true,
      },
    },
    isolation: {
      sourceCheckoutRequired: false,
      guiPrivateStateRequired: false,
    },
    nonClaims: cliQualificationNonClaims('darwin-arm64'),
  };
  report.qualificationRoot = cliQualificationRoot(report);
  return report;
}

function signing() {
  const requestDigest = `sha256:${'c'.repeat(64)}`;
  return {
    result: {
      contract: 'kungfu-buildchain-artifact-signing-result/v1',
      requestDigest,
      source: { sha: SOURCE },
      artifact: { digest: AFTER },
      evidence: [
        {
          kind: 'apple-developer-id-verification',
          path: 'provider-evidence.json',
          digest: PROVIDER_EVIDENCE,
        },
      ],
      evidenceDigest: EVIDENCE_DIGEST,
      verification: { status: 'passed' },
    },
    receipt: {
      contract: 'kungfu-buildchain-artifact-signing-receipt/v1',
      requestDigest,
      status: 'passed',
      result: {
        artifactDigest: AFTER,
        evidenceDigest: EVIDENCE_DIGEST,
      },
    },
    providerEvidence: {
      contract: 'kungfu-buildchain-apple-developer-id-evidence/v1',
      status: 'passed',
      compound: {
        entitlementsProfile: 'jit-executable-v1',
        entitledExecutableCount: JIT_EXECUTABLES.length,
        entitledPaths: JIT_EXECUTABLES,
      },
    },
  };
}

function finalize(changes = {}) {
  const evidence = signing();
  return finalizeSignedCliQualification({
    report: qualification(),
    expectedPlatform: 'darwin-arm64',
    archiveName: 'kungfu-episodes-cli-darwin-arm64.tar.gz',
    archiveSha256: AFTER,
    signingResult: evidence.result,
    signingReceipt: evidence.receipt,
    signingProviderEvidence: evidence.providerEvidence,
    signingProviderEvidenceDigest: PROVIDER_EVIDENCE,
    expectedSourceCommit: SOURCE,
    ...changes,
  });
}

function runtimeReceipt(changes = {}) {
  const receipt = {
    schema: 'kungfu.signed-macos-cli-runtime-verification/v1',
    verified: true,
    platform: 'darwin-arm64',
    architecture: 'arm64',
    sourceCommit: SOURCE,
    archive: {
      name: 'kungfu-episodes-cli-darwin-arm64.tar.gz',
      sha256: AFTER,
    },
    checks: {
      entitlements: JIT_EXECUTABLES.map((entry) => ({
        path: entry,
        allowJit: true,
      })),
      workProfile: { verdict: 'compatible' },
      tuiAutoplay: { pty: 'node-pty', exitCode: 0 },
      codexPlan: { fixtureOnly: true, credentialsRead: false },
    },
    isolation: {
      realCodexRequired: false,
      providerCredentialsRead: false,
    },
    ...changes,
  };
  receipt.receiptRoot = signedMacosRuntimeReceiptRoot(receipt);
  return receipt;
}

test('signed CLI finalization rebinds the qualification to final archive bytes', () => {
  const report = finalize();
  assert.equal(report.identity.archiveSha256, AFTER);
  assert.notEqual(report.qualificationRoot, qualification().qualificationRoot);
  const { qualificationRoot, ...subject } = report;
  assert.equal(qualificationRoot, cliQualificationRoot(subject));
});

test('signed CLI finalization binds the real post-sign runtime receipt', () => {
  const report = bindSignedMacosRuntimeQualification({
    report: finalize(),
    signedRuntimeReceipt: runtimeReceipt(),
    expectedPlatform: 'darwin-arm64',
    archiveName: 'kungfu-episodes-cli-darwin-arm64.tar.gz',
    archiveSha256: AFTER,
    expectedSourceCommit: SOURCE,
  });
  assert.equal(report.checks.signedMacosRuntime.verified, true);
  const { qualificationRoot, ...subject } = report;
  assert.equal(qualificationRoot, cliQualificationRoot(subject));
});

test('signed CLI finalization rejects a runtime receipt for different archive bytes', () => {
  const signedRuntimeReceipt = runtimeReceipt({
    archive: {
      name: 'kungfu-episodes-cli-darwin-arm64.tar.gz',
      sha256: BEFORE,
    },
  });
  assert.throws(
    () =>
      bindSignedMacosRuntimeQualification({
        report: finalize(),
        signedRuntimeReceipt,
        expectedPlatform: 'darwin-arm64',
        archiveName: 'kungfu-episodes-cli-darwin-arm64.tar.gz',
        archiveSha256: AFTER,
        expectedSourceCommit: SOURCE,
      }),
    /does not bind the qualified artifact/u,
  );
});

test('signed CLI finalization rejects tampered pre-signing qualification', () => {
  const report = qualification();
  report.checks.kfd3.linkedApiCount = 2;
  assert.throws(
    () => finalize({ report }),
    /pre-signing qualification semantic root mismatch/u,
  );
});

test('signed CLI finalization rejects archive bytes outside signing evidence', () => {
  assert.throws(
    () => finalize({ archiveSha256: `sha256:${'d'.repeat(64)}` }),
    /does not match the Buildchain signing result and receipt/u,
  );
});

test('signed CLI finalization rejects a provider evidence file outside the signing result', () => {
  assert.throws(
    () =>
      finalize({
        signingProviderEvidenceDigest: `sha256:${'f'.repeat(64)}`,
      }),
    /does not bind the exact provider evidence file/u,
  );
});

test('signed CLI finalization rejects divergent aggregate evidence digests', () => {
  const evidence = signing();
  evidence.receipt.result.evidenceDigest = `sha256:${'f'.repeat(64)}`;
  assert.throws(
    () => finalize({ signingReceipt: evidence.receipt }),
    /result and receipt evidence digests differ/u,
  );
});

test('signed CLI finalization rejects provider evidence without JIT entitlements', () => {
  const evidence = signing();
  evidence.providerEvidence.compound = {
    entitlementsProfile: 'none',
    entitledExecutableCount: 0,
    entitledPaths: [],
  };
  assert.throws(
    () => finalize({ signingProviderEvidence: evidence.providerEvidence }),
    /omitted the jit-executable-v1 entitlement profile/u,
  );
});

test('signed CLI finalization rejects incomplete JIT executable coverage', () => {
  const evidence = signing();
  evidence.providerEvidence.compound.entitledExecutableCount = 1;
  evidence.providerEvidence.compound.entitledPaths = [JIT_EXECUTABLES[0]];
  assert.throws(
    () => finalize({ signingProviderEvidence: evidence.providerEvidence }),
    /must bind the JIT executables/u,
  );
});

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-entitlements-'));
  for (const file of [
    'runtime/kungfu',
    'runtime/python/bin/python3',
    'runtime/python/bin/python3.13',
  ]) {
    const target = path.join(root, ...file.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'fixture');
  }
  return root;
}

function codesignSpawn({ allowJit = true } = {}) {
  return (command, args) => {
    if (command === 'plutil') {
      return {
        status: 0,
        stdout: JSON.stringify({
          'com.apple.security.cs.allow-jit': allowJit,
        }),
        stderr: '',
      };
    }
    assert.equal(command, 'codesign');
    return {
      status: 0,
      stdout: args.includes('--display')
        ? '<?xml version="1.0"?><plist><dict></dict></plist>'
        : '',
      stderr: '',
    };
  };
}

test('codesign readback requires allow-jit on every declared executable', (t) => {
  const installRoot = fixtureRoot();
  t.after(() => fs.rmSync(installRoot, { recursive: true, force: true }));
  const result = verifyCodesignEntitlements(
    { installRoot },
    { spawn: codesignSpawn() },
  );
  assert.equal(result.length, 3);
  assert.ok(result.every((entry) => entry.allowJit === true));
});

test('codesign readback fails closed when allow-jit is absent', (t) => {
  const installRoot = fixtureRoot();
  t.after(() => fs.rmSync(installRoot, { recursive: true, force: true }));
  assert.throws(
    () =>
      verifyCodesignEntitlements(
        { installRoot },
        { spawn: codesignSpawn({ allowJit: false }) },
      ),
    /omitted com\.apple\.security\.cs\.allow-jit/u,
  );
});

test('signed runtime receipt root changes with runtime evidence', () => {
  const receipt = {
    schema: 'kungfu.signed-macos-cli-runtime-verification/v1',
    verified: true,
    checks: { tuiAutoplay: { exitCode: 0 } },
  };
  const root = signedMacosRuntimeReceiptRoot(receipt);
  assert.match(root, /^sha256:[0-9a-f]{64}$/u);
  assert.notEqual(
    root,
    signedMacosRuntimeReceiptRoot({
      ...receipt,
      checks: { tuiAutoplay: { exitCode: 1 } },
    }),
  );
});

test('post-sign Codex planning is credential-free and selects only the fixture profile', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(source, /!\['CODEX_HOME', 'OPENAI_API_KEY'\]\.includes\(key\)/u);
  assert.match(source, /agent\.defaultRuntimeProfile/u);
  assert.match(
    source,
    /'starter-create',[\s\S]*?'--expected-plan-root',[\s\S]*?'--execute',[\s\S]*?'--json'/u,
  );
  assert.match(
    source,
    /'run',[\s\S]*?'codex',[\s\S]*?projectPlan\.initialWork\.title,[\s\S]*?'--workspace',[\s\S]*?'--plan'/u,
  );
  assert.match(source, /realCodexRequired: false/u);
  assert.match(source, /providerCredentialsRead: false/u);
});

test('Buildchain signing-finalization runs the consumer-owned qualification rebind', () => {
  const config = fs.readFileSync(
    path.join(ROOT, '.buildchain', 'buildchain.toml'),
    'utf8',
  );
  const finalizer = fs.readFileSync(
    path.join(
      ROOT,
      'product',
      'scripts',
      'verify-cli-surface-qualification.mjs',
    ),
    'utf8',
  );
  assert.match(config, /\[lifecycle\.signing-finalization\]/u);
  assert.match(
    config,
    /verify-cli-surface-qualification\.mjs[\s\S]*--signing-result[\s\S]*--signing-receipt[\s\S]*--signing-provider-evidence/u,
  );
  assert.match(
    finalizer,
    /options\.platform === 'darwin-arm64'[\s\S]*verifySignedMacosCliRuntime/u,
  );
  assert.match(finalizer, /bindSignedMacosRuntimeQualification/u);
});
