// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildGitEpisodeSegment,
  sealGitEpisode,
} from '@kungfu-tech/work/episode-provider';
import {
  buildProjectCut,
  canonicalJson,
  createProjectCutReceipt,
  semanticRoot,
} from '@kungfu-tech/work/project-cut';
import {
  checkNativeLoopQualificationContract,
  sealNativeLoopQualification,
  verifyNativeLoopQualification,
} from '@kungfu-tech/work/project-cut/native-loop-qualification';
import {
  materializeSettlementPublication,
  planSettlementPublication,
} from '@kungfu-tech/work/project-cut/publication';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const CLI = path.join(
  REPO_ROOT,
  'framework/work/project-cut/bin/project-cut.mjs',
);
const PROJECT_CUT_FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(
      REPO_ROOT,
      'framework/work/project-cut/fixtures/golden/project-cut-v1.json',
    ),
    'utf8',
  ),
);
const FAULTS = [
  'duplicate-delivery',
  'generated-ledger-recursion-suppression',
  'local-cache-loss-recovery',
  'mismatched-head',
  'mismatched-merge',
  'missing-evidence',
  'publication-failure',
  'publication-retry',
];

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${canonicalJson(value)}\n`);
}

function addProjectCut(root, cut) {
  const hex = cut.cutRoot.slice(7);
  const directory = path.join(
    root,
    '.kungfu/project-cuts/sha256',
    hex.slice(0, 2),
    hex,
  );
  const manifestBytes = Buffer.from(`${canonicalJson(cut)}\n`);
  const receipt = createProjectCutReceipt(cut, manifestBytes);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'manifest.json'), manifestBytes);
  writeJson(path.join(directory, 'receipt.json'), receipt);
  return receipt;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-loop-source-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  git(root, 'init', '-q', '-b', 'dev/v4/v4.0');
  git(root, 'config', 'user.name', 'Native Loop Test');
  git(root, 'config', 'user.email', 'native-loop@example.invalid');
  fs.writeFileSync(path.join(root, 'README.md'), 'native loop fixture\n');

  const episodeRoot = semanticRoot({ episode: 'native-loop' });
  const episode = buildGitEpisodeSegment(
    {
      schema: 'kungfu.storage.episode-bundle/v1',
      bundle_id: 'episode:41',
      scope: 'episode',
      episode_id: 41,
      authority: 'yijinjing-journal',
      manifest: {
        schema: 'kungfu.episode.manifest/v1',
        episode_id: 41,
        opened: true,
        closed: true,
        status: 'ended',
        content_root_algorithm: 'sha256',
        content_root: episodeRoot.slice(7),
      },
      records: [
        {
          manifest_frame_uid: 411,
          carrier_type: 10801,
          record: { episode_id: 41 },
        },
        {
          manifest_frame_uid: 412,
          carrier_type: 10805,
          record: { episode_id: 41 },
        },
      ],
      refs: [],
      dependencies: [],
    },
    {
      schema: 'kungfu.episode.qualification/v1',
      policy_source: 'cpp-typed-fold-fsck',
      episode_id: 41,
      lifecycle: 'ended',
      status: 'ok',
      evidence: {
        manifest_integrity: { state: 'verified', issue_codes: [] },
      },
      issues: [],
      capabilities: [
        {
          name: 'export_evidence',
          safe: true,
          requires: [],
          blocked_by: [],
        },
      ],
      safe_capabilities: ['export_evidence'],
      contractions: [],
      repair_prerequisites: [],
    },
  );
  sealGitEpisode(root, episode, { writerId: 'native-loop-test' });
  const cutInput = structuredClone(PROJECT_CUT_FIXTURE.projectCutInput);
  cutInput.parentCutRoots = [];
  cutInput.sourceProjection.root = semanticRoot({ source: 'native-loop' });
  cutInput.atlas.root = semanticRoot({ atlas: 'native-loop' });
  cutInput.episodeDelta.nativeRoots = [
    { provider: 'yijinjing/v1', root: episode.providerRoot },
  ];
  const cut = buildProjectCut(cutInput);
  const cutReceipt = addProjectCut(root, cut);
  git(root, 'add', '--all');
  git(root, 'commit', '-qm', 'test: seed protected source settlement');
  const sourceCommit = git(root, 'rev-parse', 'HEAD');
  const request = {
    schema: 'kungfu.settlement-publication.request/v1',
    batch: { kind: 'wave', id: 'native-loop-test' },
    repository: {
      id: 'kungfu-systems/kungfu',
      targetBranch: 'dev/v4/v4.0',
    },
    episodes: [episode.semanticRoot],
    projectCuts: [cut.cutRoot],
    trigger: {
      schema: 'kungfu.settlement-publication.trigger/v1',
      source: 'native-settlement',
      eventKind: 'project-cut-settled',
      headBranch: null,
      labels: [],
      generatedBy: null,
      publicationRoot: null,
    },
  };
  const plan = planSettlementPublication(root, request);
  materializeSettlementPublication(root, plan, { execute: true, stage: true });
  git(root, 'commit', '-qm', 'test: publish protected ledger');
  const ledgerCommit = git(root, 'rev-parse', 'HEAD');
  const input = {
    assignment: {
      initiativeId: '2026-07-28-kungfu-go-family-continuous-delivery',
      assignmentId: '2026-07-28-kungfu-go-family-native-loop-qualification',
      requestRoot: semanticRoot({ request: 'native-loop' }),
      captureReceiptRoots: [semanticRoot({ receipt: 'native-loop' })],
      workDefinitionRoot: semanticRoot({ work: 'native-loop' }),
      executionClaimId: `execution-${'a'.repeat(24)}`,
      executionLeaseId: 'native-loop-test-lease',
    },
    delivery: {
      evidenceClass: 'real-protected-run',
      repository: {
        id: 'R_kgDONativeLoop',
        fullName: 'kungfu-systems/kungfu',
        targetBranch: 'dev/v4/v4.0',
      },
      sourceCommit,
      pullRequest: {
        number: 1901,
        headSha: sourceCommit,
        mergeCommitSha: sourceCommit,
      },
      workflow: {
        name: 'Core affected native',
        runId: '401001',
        attempt: 1,
      },
      buildchain: {
        receiptRoot: semanticRoot({ buildchain: 'receipt' }),
        artifactRoots: [semanticRoot({ artifact: 'source' })],
        schemaRoots: [semanticRoot({ schema: 'buildchain' })],
      },
      mergeQueue: {
        attemptRoot: semanticRoot({ queue: 'attempt' }),
        headSha: sourceCommit,
        runId: '401002',
        attempt: 1,
      },
      timestamps: {
        mergedAt: '2026-07-29T01:00:05Z',
        runCompletedAt: '2026-07-29T01:00:00Z',
        observedAt: '2026-07-29T01:00:10Z',
      },
      ingestionLagSeconds: 5,
    },
    native: {
      authority: 'yijinjing-journal',
      coordinateRoot: semanticRoot({ coordinate: 'native-loop' }),
      evidenceRoot: semanticRoot({ evidence: 'native-loop' }),
      factPayloadRoot: semanticRoot({ fact: 'native-loop' }),
      episodeId: '41',
      episodeRoot: episode.semanticRoot,
    },
    settlement: {
      projectCutRoot: cut.cutRoot,
      receiptRoot: cutReceipt.receiptRoot,
    },
    ledger: {
      batchRoot: plan.batchRoot,
      manifestRoot: plan.manifest.manifestRoot,
      publicationLagSeconds: 7,
      pullRequest: {
        number: 1902,
        headSha: sourceCommit,
        mergeCommitSha: ledgerCommit,
      },
      protectedCommit: ledgerCommit,
    },
    faults: FAULTS.map((id) => ({
      id,
      mode: 'deterministic-fault',
      status: 'qualified',
      evidenceRoot: semanticRoot({ fault: id }),
    })),
    policy: { sampleCount: 1 },
  };
  return { root, input, plan, cut, ledgerCommit };
}

test('contract roots the exact success predicate and advisory history rule', () => {
  const result = checkNativeLoopQualificationContract();
  assert.equal(result.ok, true);
  assert.equal(result.faultCount, 8);
  assert.equal(result.minimumDefaultPromotionSamples, 30);
  assert.equal(result.advisoryModeEligible, true);
  assert.match(result.contractRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.match(result.schemaRoot, /^sha256:[0-9a-f]{64}$/u);
});

test('fresh clone verifies the protected source-to-ledger continuation', (t) => {
  const seeded = fixture(t);
  const sealed = sealNativeLoopQualification(seeded.root, seeded.input);
  assert.equal(
    sealed.verification.ok,
    true,
    JSON.stringify(sealed.verification),
  );
  assert.equal(sealed.manifest.policy.defaultPromotionEligible, false);
  assert.equal(sealed.manifest.policy.advisoryModeEligible, true);

  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'native-loop-clone-'));
  t.after(() => fs.rmSync(clone, { force: true, recursive: true }));
  execFileSync('git', ['clone', '-q', seeded.root, clone]);
  assert.equal(fs.existsSync(path.join(clone, '.kungfu', 'runtime')), false);
  const verified = verifyNativeLoopQualification(clone, sealed.manifest);
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.evidence.runtimeRequired, false);
  assert.equal(verified.evidence.authority, 'qualified-git-shadow');
  assert.equal(verified.evidence.protectedCommit, seeded.ledgerCommit);
});

test('missing and inexact evidence fail visibly', (t) => {
  const seeded = fixture(t);
  const { manifest } = sealNativeLoopQualification(seeded.root, seeded.input);

  const mismatched = structuredClone(manifest);
  mismatched.delivery.sourceCommit = 'f'.repeat(40);
  let result = verifyNativeLoopQualification(seeded.root, mismatched);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some((entry) => entry.code === 'source-head-mismatch'),
  );

  const missingFault = structuredClone(manifest);
  missingFault.faults.pop();
  result = verifyNativeLoopQualification(seeded.root, missingFault);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some((entry) => entry.code === 'fault-set-mismatch'),
  );

  const cacheDependent = structuredClone(manifest);
  cacheDependent.cleanClone.runtimeCachePresent = true;
  result = verifyNativeLoopQualification(seeded.root, cacheDependent);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some((entry) => entry.code === 'runtime-cache-present'),
  );

  const reversedDelivery = structuredClone(manifest);
  reversedDelivery.delivery.timestamps.runCompletedAt = '2026-07-29T01:00:06Z';
  result = verifyNativeLoopQualification(seeded.root, reversedDelivery);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(
      (entry) => entry.code === 'delivery-timestamp-order-mismatch',
    ),
  );
});

test('thirty samples only gates default promotion, never advisory mode', (t) => {
  const seeded = fixture(t);
  const one = sealNativeLoopQualification(seeded.root, seeded.input);
  assert.equal(one.manifest.policy.defaultPromotionEligible, false);
  assert.equal(one.manifest.policy.advisoryModeEligible, true);

  const promoted = sealNativeLoopQualification(seeded.root, {
    ...seeded.input,
    policy: { sampleCount: 30 },
  });
  assert.equal(promoted.manifest.policy.defaultPromotionEligible, true);
  assert.equal(promoted.manifest.policy.advisoryModeEligible, true);

  const drifted = structuredClone(one.manifest);
  drifted.policy.defaultPromotionEligible = true;
  const result = verifyNativeLoopQualification(seeded.root, drifted);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(
      (entry) => entry.code === 'default-promotion-policy-mismatch',
    ),
  );
});

test('CLI exposes the rooted contract check', () => {
  const result = spawnSync(
    process.execPath,
    [CLI, 'native-loop-contract-check', '--root', REPO_ROOT, '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(
    payload.schema,
    'kungfu.native-loop-qualification.contract-check/v1',
  );
});
