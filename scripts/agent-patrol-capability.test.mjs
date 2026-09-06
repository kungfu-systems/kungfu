// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  auditArtifacts,
  buildTrend,
  createCapabilityReceipt,
  decideQualification,
  jsonRoot,
  storeCapabilityReceipt,
  validateCapabilityReceipt,
} from '@kungfu-tech/work/agent-repository-work/report';
import { classifyReport } from '../developer/agent-patrol/classify.mjs';
import { selectPatrolPlan } from '../developer/agent-patrol/select.mjs';

const IMAGE =
  'ghcr.io/kungfu-systems/build-images/opencode-ci@sha256:4083ee089fa9a419f4915505094a6c1bcce433ff77455605ce8993af3b684ed3';
const MODEL = 'qwen3-coder:30b-opencode-64k';
const SOURCE_HEAD = '0123456789abcdef0123456789abcdef01234567';
const SOURCE_TREE = '89abcdef0123456789abcdef0123456789abcdef';
const ROOT_A = `sha256:${'a'.repeat(64)}`;
const ROOT_B = `sha256:${'b'.repeat(64)}`;
const ROOT_C = `sha256:${'c'.repeat(64)}`;
const ROOT_D = `sha256:${'d'.repeat(64)}`;
const RUNNER = 'agent-121-kungfu-systems';

function qualificationPlan() {
  return selectPatrolPlan({
    eventName: 'workflow_dispatch',
    manualMode: 'qualification',
    rotationKey: 1,
    triggerAt: '2026-07-30T04:00:00Z',
  });
}

function passingReport(elapsedMilliseconds = 1_000) {
  return {
    schema: 'kungfu.agent-repository-work.report/v1',
    evidenceClass: 'bounded-experiment',
    passed: true,
    sourceHead: SOURCE_HEAD,
    fixture: {
      id: 'kungfu-agent-patrol-real-module-snapshot-v1',
      kind: 'real-module-snapshot',
      sourceTreeRoot: ROOT_A,
    },
    runtime: {
      provider: 'opencode',
      image: IMAGE,
      directExecutable: null,
      model: MODEL,
      baseUrlRoot: ROOT_B,
      context: 65_536,
    },
    sessions: {
      distinct: 2,
      a: { providerSessionId: 'session-a', reportRoot: ROOT_A },
      b: { providerSessionId: 'session-b', reportRoot: ROOT_B },
    },
    continuity: {
      priorTranscriptBytes: 0,
      humanRestatementCount: 0,
      root: ROOT_C,
    },
    warrant: {
      agentAZeroModification: true,
      writablePaths: ['developer/agent-patrol/classify.mjs'],
    },
    oracle: {
      passed: true,
      authoritative: true,
      reportRoot: ROOT_D,
      scopeViolations: [],
      checks: { referenceRoot: true },
    },
    claim: { root: ROOT_A },
    assessment: { root: ROOT_B },
    dimensions: {
      efficiency: { elapsedMilliseconds },
    },
    changeSignals: {
      changedPathCount: 1,
      changedFileCount: 1,
      lineDeltaAbs: 1,
      byteDeltaAbs: 4,
      expectedMutationSiteContact: true,
      structuralFingerprintRoot: ROOT_C,
      symbolFingerprintRoot: ROOT_D,
    },
    nonClaims: {
      auditableDemo: true,
      agentWorkLab: true,
      releaseGate: true,
      publicClaim: true,
      modelRanking: true,
    },
    failure: null,
  };
}

function dogfoodReceipt() {
  return {
    schema: 'kungfu.agent-patrol.dogfood-capture-receipt/v1',
    status: 'not-required',
    findingId: null,
    findingRoot: null,
    lookupRoot: null,
    nativeStatus: null,
    capturePerformed: false,
    issueAdmitted: false,
  };
}

function receiptAt(plan, trial, observedAt, elapsedMilliseconds = 1_000) {
  const report = passingReport(elapsedMilliseconds);
  const classification = classifyReport(report, {
    runnerExit: 0,
    sourceHead: SOURCE_HEAD,
    model: MODEL,
    image: IMAGE,
    runner: RUNNER,
  });
  return createCapabilityReceipt({
    plan,
    report,
    classification,
    dogfoodReceipt: dogfoodReceipt(),
    sourceTree: SOURCE_TREE,
    runner: RUNNER,
    trial,
    observedAt,
  });
}

test('Capability Receipt binds exact runtime evidence without retained content', () => {
  const receipt = receiptAt(qualificationPlan(), 1, '2026-07-30T04:00:00Z');
  assert.equal(validateCapabilityReceipt(receipt), true);
  assert.equal(receipt.dimensions.functional, 'pass');
  assert.equal(receipt.dimensions.exactness, 'pass');
  assert.equal(receipt.changeSignals.changedPathCount, 1);
  assert.equal(receipt.changeSignals.elapsedMilliseconds, 1_000);
  assert.equal(receipt.issueAdmitted, false);
  assert.equal(Object.hasOwn(receipt, 'prompt'), false);
  assert.equal(Object.hasOwn(receipt, 'sourceBytes'), false);
  assert.equal(
    Object.values(receipt.privacy).every((retained) => retained === false),
    true,
  );
});

test('Capability Receipt store creates once, replays, and rejects collision', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-patrol-capability-store.'),
  );
  try {
    const receipt = receiptAt(qualificationPlan(), 1, '2026-07-30T04:00:00Z');
    assert.equal(storeCapabilityReceipt(receipt, temporary).status, 'created');
    assert.equal(
      storeCapabilityReceipt(receipt, temporary).status,
      'already-present',
    );
    const target = path.join(
      temporary,
      'capability-receipts',
      'v1',
      receipt.receiptRoot.slice(7, 9),
      `${receipt.receiptRoot}.json`,
    );
    fs.writeFileSync(target, '{"collision":true}\n');
    assert.throws(
      () => storeCapabilityReceipt(receipt, temporary),
      /content-address collision/u,
    );
    const linkedState = path.join(temporary, 'linked-state');
    const actualState = path.join(temporary, 'actual-state');
    fs.mkdirSync(actualState);
    fs.symlinkSync(actualState, linkedState, 'dir');
    assert.throws(
      () => storeCapabilityReceipt(receipt, linkedState),
      /real directory/u,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('14-day and 30-day trends are bounded by exact tuple and fixture', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-patrol-capability-trend.'),
  );
  try {
    const plan = qualificationPlan();
    const receipts = [
      receiptAt(plan, 1, '2026-07-28T04:00:00Z', 1_000),
      receiptAt(plan, 2, '2026-07-29T04:00:00Z', 2_000),
      receiptAt(plan, 3, '2026-07-30T04:00:00Z', 3_000),
    ];
    for (const receipt of receipts) storeCapabilityReceipt(receipt, temporary);
    const trend = buildTrend({
      stateRoot: temporary,
      days: 14,
      asOf: '2026-07-30T05:00:00Z',
    });
    assert.equal(trend.selectedReceiptCount, 3);
    assert.equal(trend.groups.length, 1);
    assert.equal(trend.groups[0].passCount, 3);
    assert.equal(trend.groups[0].passRatePermille, 1_000);
    assert.equal(trend.groups[0].durationMilliseconds.p50, 2_000);
    assert.equal(trend.groups[0].durationMilliseconds.p95, 3_000);
    assert.equal(trend.groups[0].qualificationState, 'qualified');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('qualification decision separates advisory hold from blocking integrity', () => {
  const plan = qualificationPlan();
  const receipts = [
    receiptAt(plan, 1, '2026-07-28T04:00:00Z'),
    receiptAt(plan, 2, '2026-07-29T04:00:00Z'),
    receiptAt(plan, 3, '2026-07-30T04:00:00Z'),
  ];
  const trendBody = {
    schema: 'kungfu.agent-patrol.capability-trend/v1',
  };
  const trend = { ...trendBody, trendRoot: jsonRoot(trendBody) };
  const secondTrendBody = {
    ...trendBody,
    windowDays: 30,
  };
  const secondTrend = {
    ...secondTrendBody,
    trendRoot: jsonRoot(secondTrendBody),
  };
  const qualified = decideQualification({
    plan,
    receipts,
    trends: [trend, secondTrend],
  });
  assert.equal(qualified.state, 'qualified');
  assert.equal(qualified.blocking, false);

  const { receiptRoot: ignoredHoldRoot, ...holdBody } = receipts[2];
  holdBody.dimensions.functional = 'fail';
  const holdReceipt = { ...holdBody, receiptRoot: jsonRoot(holdBody) };
  const hold = decideQualification({
    plan,
    receipts: [receipts[0], receipts[1], holdReceipt],
    trends: [trend],
  });
  assert.equal(hold.state, 'hold');
  assert.equal(hold.blocking, false);

  const { receiptRoot: ignoredBlockRoot, ...blockBody } = receipts[2];
  blockBody.outcome.blocking = true;
  const blockReceipt = { ...blockBody, receiptRoot: jsonRoot(blockBody) };
  const blocked = decideQualification({
    plan,
    receipts: [receipts[0], receipts[1], blockReceipt],
    trends: [trend],
  });
  assert.equal(blocked.state, 'hold');
  assert.equal(blocked.blocking, true);
});

test('artifact audit enforces allowlisted JSON, privacy, and byte budgets', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-patrol-artifacts.'),
  );
  try {
    fs.writeFileSync(
      path.join(temporary, 'plan.json'),
      `${JSON.stringify({ schema: 'bounded' })}\n`,
    );
    const audit = auditArtifacts(temporary);
    assert.equal(audit.fileCount, 1);
    assert.match(audit.auditRoot, /^sha256:[0-9a-f]{64}$/u);

    fs.writeFileSync(
      path.join(temporary, 'unexpected.json'),
      '{"schema":"unexpected"}\n',
    );
    assert.throws(() => auditArtifacts(temporary), /not allowlisted/u);
    fs.rmSync(path.join(temporary, 'unexpected.json'));
    fs.writeFileSync(
      path.join(temporary, 'plan.json'),
      '{"prompt":"private model input"}\n',
    );
    assert.throws(() => auditArtifacts(temporary), /forbidden field prompt/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
