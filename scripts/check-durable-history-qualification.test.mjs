// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildReceipt,
  digestBytes,
  digestDocument,
} from './durable-history-qualification.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const contract = readJson(
  'framework/data-protection/durable-history-qualification.contract.json',
);
const corpus = readJson(contract.campaigns.corpus);

test('covers every declared entrypoint with one owner-authority route', () => {
  assert.equal(
    contract.schema,
    'kungfu.durable-history-qualification.contract/v1',
  );
  assert.deepEqual(
    contract.entrypointMatrix.map(({ id }) => id),
    [
      'gui',
      'tui',
      'cli',
      'native-agent',
      'managed-agent',
      'skill-kfd',
      'project-cut-dogfood',
      'shifu',
      'project-cut',
      'product-release-cut',
      'update-release',
      'exit-bundle',
    ],
  );
  for (const row of contract.entrypointMatrix) {
    assert.ok(row.authorityRoute, row.id);
    assert.equal(fs.existsSync(path.join(ROOT, row.proof)), true, row.id);
  }
  assert.equal(contract.authority.kind, 'qualification-composition');
  assert.match(contract.authority.rule, /remain authoritative/u);
  assert.match(contract.authority.observerRule, /never becomes semantic/u);
});

test('binds every required failure campaign to a real exact test', () => {
  assert.deepEqual(
    corpus.campaigns.map(({ id }) => id),
    contract.campaigns.required,
  );
  for (const campaign of corpus.campaigns) {
    const [relative, selector] = campaign.proof.split('::');
    assert.equal(fs.existsSync(path.join(ROOT, relative)), true, campaign.id);
    assert.match(read(relative), new RegExp(`def ${selector}\\b`, 'u'));
    assert.ok(campaign.expected || campaign.expectedDiagnostic, campaign.id);
  }
  assert.equal(contract.campaigns.homePolicy, 'disposable-only');
  assert.match(contract.campaigns.warmStateRule, /must not require a warm/u);
  assert.match(contract.campaigns.failureRule, /refuses before mutation/u);
});

test('full and thin claims cannot collapse into one status', () => {
  const exitContract = readJson(
    'framework/exit/kungfu-exit-bundle.contract.json',
  );
  assert.equal(exitContract.modeSemantics.full.required.completeForScope, true);
  assert.equal(exitContract.modeSemantics.thin.required.materialMissing, true);
  assert.match(exitContract.modeSemantics.thin.claimRule, /never claim/u);
  assert.equal(contract.boundedClaim.status, 'source-qualified');
});

test('qualification receipt binds source, artifact, campaigns, claim, and review', () => {
  const sourceFiles = contract.receipt.sourceClosure.map((relative) => ({
    path: relative,
    root: digestBytes(Buffer.from(read(relative))),
  }));
  const nativeArtifact = {
    path: 'fixture/pykungfu.so',
    root: digestBytes(Buffer.from('fixture-native-artifact')),
  };
  const executions = [
    {
      id: 'fixture-campaign',
      command: 'fixture-runner --test',
      exitCode: 0,
      outputRoot: digestBytes(Buffer.from('fixture-output')),
    },
  ];
  const receipt = buildReceipt({
    contract,
    corpus,
    sourceRevision: '1111111111111111111111111111111111111111',
    sourceFiles,
    nativeArtifact,
    executions,
    platform: 'fixture-os',
    architecture: 'fixture-arch',
    qualifiedAt: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(receipt.source.sourceSetRoot, digestDocument(sourceFiles));
  assert.equal(receipt.artifact.root, nativeArtifact.root);
  assert.equal(
    receipt.bindings.entrypointMatrixRoot,
    digestDocument(contract.entrypointMatrix),
  );
  assert.equal(
    receipt.bindings.campaignResultRoot,
    digestDocument(receipt.campaigns),
  );
  assert.equal(receipt.bindings.reviewRoot, digestDocument(receipt.review));
  assert.equal(receipt.bindings.executionRoot, digestDocument(executions));
  assert.equal(
    receipt.bindings.assessmentRoot,
    digestDocument(receipt.assessment),
  );
  assert.equal(
    receipt.bindings.interpreterRoot,
    digestDocument({
      node: process.version,
      nativeArtifactRoot: nativeArtifact.root,
    }),
  );
  assert.match(receipt.bindings.bundleContractRoot, /^sha256:/u);
  assert.match(receipt.bindings.migrationContractRoot, /^sha256:/u);
  const material = structuredClone(receipt);
  material.receiptRoot = undefined;
  assert.equal(receipt.receiptRoot, digestDocument(material));
  const values = {
    sourceRevision: receipt.source.revision,
    sourceSetRoot: receipt.source.sourceSetRoot,
    nativeArtifactRoot: receipt.artifact.root,
    ...receipt.bindings,
  };
  for (const binding of contract.receipt.requiredBindings)
    assert.ok(values[binding], binding);
});

test('bounded claim preserves privacy and deferred evidence boundaries', () => {
  assert.deepEqual(
    contract.deferred.map(({ id }) => id),
    ['long-duration-soak', 'off-host-backup-restore', 'platform-expansion'],
  );
  assert.equal(contract.status.installedQualification, 'not-qualified');
  assert.equal(contract.status.stableReleaseQualification, 'not-qualified');
  assert.equal(contract.status.offHostQualification, 'not-qualified');
  assert.match(contract.boundedClaim.supportedScope, /exact-source/u);
  for (const forbidden of [
    'installed product',
    'stable or public release',
    'physical-media durability',
    'off-host backup',
    'all-platform behavior',
  ])
    assert.equal(
      contract.boundedClaim.doesNotPromote.includes(forbidden),
      true,
    );
  assert.equal(contract.receipt.privacyExclusions.length, 4);
  assert.equal(contract.independentReview.required, true);
  assert.deepEqual(contract.independentReview.mustVerify, [
    'authority-separation',
    'privacy-exclusions',
    'migration-correctness',
    'original-exit-signals-remain-activity-only',
    'no-warm-cache-dependency',
    'no-original-ui-session-dependency',
  ]);
});

test('human guide exposes the same gate and bounded non-claims', () => {
  const guide = read('framework/data-protection/README.md');
  assert.match(guide, /.\/shifu check:durable-history-qualification/u);
  assert.match(guide, /source-qualified/u);
  assert.match(guide, /does\s+not qualify the installed product/u);
  assert.match(guide, /off-host/u);
});
