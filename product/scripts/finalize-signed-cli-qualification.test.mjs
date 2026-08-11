// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  cliQualificationNonClaims,
  cliQualificationRoot,
} from './cli-surface-qualification.mjs';
import { finalizeSignedCliQualification } from './verify-cli-surface-qualification.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SOURCE = '1'.repeat(40);
const BEFORE = `sha256:${'a'.repeat(64)}`;
const AFTER = `sha256:${'b'.repeat(64)}`;
const JIT_EXECUTABLES = [
  'kungfu-episodes-cli-darwin-arm64/runtime/kungfu',
  'kungfu-episodes-cli-darwin-arm64/runtime/python/bin/python3',
  'kungfu-episodes-cli-darwin-arm64/runtime/python/bin/python3.13',
];

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
      verification: { status: 'passed' },
    },
    receipt: {
      contract: 'kungfu-buildchain-artifact-signing-receipt/v1',
      requestDigest,
      status: 'passed',
      result: { artifactDigest: AFTER },
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
    expectedSourceCommit: SOURCE,
    ...changes,
  });
}

test('signed CLI finalization rebinds the qualification to final archive bytes', () => {
  const report = finalize();
  assert.equal(report.identity.archiveSha256, AFTER);
  assert.notEqual(report.qualificationRoot, qualification().qualificationRoot);
  const { qualificationRoot, ...subject } = report;
  assert.equal(qualificationRoot, cliQualificationRoot(subject));
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

test('Buildchain signing-finalization runs the consumer-owned qualification rebind', () => {
  const config = fs.readFileSync(
    path.join(ROOT, '.buildchain', 'buildchain.toml'),
    'utf8',
  );
  assert.match(config, /\[lifecycle\.signing-finalization\]/u);
  assert.match(
    config,
    /verify-cli-surface-qualification\.mjs[\s\S]*--signing-result[\s\S]*--signing-receipt[\s\S]*--signing-provider-evidence/u,
  );
});
