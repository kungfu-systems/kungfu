// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyReport,
  jsonRoot,
  parseArgs as parseClassificationArgs,
} from '../developer/agent-patrol/classify.mjs';
import {
  captureFinding,
  parseArgs as parseDogfoodCaptureArgs,
} from '../developer/agent-patrol/dogfood-capture.mjs';
import {
  DAILY_LIGHT_SCHEDULE,
  MONTHLY_QUALIFICATION_SCHEDULE,
  WEEKLY_DEEP_SCHEDULE,
  WEEKLY_REAL_SNAPSHOT_SCHEDULE,
  parseArgs as parseSelectionArgs,
  selectPatrolPlan,
} from '../developer/agent-patrol/select.mjs';

const IMAGE =
  'ghcr.io/kungfu-systems/build-images/opencode-ci@sha256:4083ee089fa9a419f4915505094a6c1bcce433ff77455605ce8993af3b684ed3';
const MODEL = 'qwen3-coder:30b-opencode-64k';
const SOURCE_HEAD = '0123456789abcdef0123456789abcdef01234567';
const ROOT_A = `sha256:${'a'.repeat(64)}`;
const ROOT_B = `sha256:${'b'.repeat(64)}`;
const ROOT_C = `sha256:${'c'.repeat(64)}`;
const ROOT_D = `sha256:${'d'.repeat(64)}`;

test('Patrol selector maps the two protected schedules to bounded modes', () => {
  const light = selectPatrolPlan({
    eventName: 'schedule',
    schedule: DAILY_LIGHT_SCHEDULE,
    rotationKey: 1,
  });
  assert.equal(light.mode, 'light');
  assert.deepEqual(light.fixtures, ['incident-board-lease-v1']);
  assert.equal(light.timeoutSeconds, 600);
  assert.equal(light.trialsPerFixture, 1);
  assert.match(light.planRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(light.schema, 'kungfu.agent-patrol.plan/v2');

  const deep = selectPatrolPlan({
    eventName: 'schedule',
    schedule: WEEKLY_DEEP_SCHEDULE,
    rotationKey: 1,
  });
  assert.equal(deep.mode, 'deep');
  assert.deepEqual(deep.fixtures, [
    'incident-board-lease-v1',
    'incident-board-recovery-v1',
  ]);
  assert.equal(deep.timeoutSeconds, 900);
});

test('Patrol selector maps protected observation, monthly, and push lanes', () => {
  const observation = selectPatrolPlan({
    eventName: 'schedule',
    schedule: WEEKLY_REAL_SNAPSHOT_SCHEDULE,
    rotationKey: 1,
    triggerAt: '2026-07-29T20:00:00Z',
  });
  assert.equal(observation.mode, 'real-snapshot');
  assert.equal(observation.trialsPerFixture, 1);
  assert.equal(observation.qualification.requested, false);

  const monthly = selectPatrolPlan({
    eventName: 'schedule',
    schedule: MONTHLY_QUALIFICATION_SCHEDULE,
    rotationKey: 1,
    triggerAt: '2026-08-02T20:00:00Z',
  });
  assert.equal(monthly.mode, 'qualification');
  assert.equal(monthly.trialsPerFixture, 3);
  assert.equal(monthly.qualification.requested, true);

  const guarded = selectPatrolPlan({
    eventName: 'schedule',
    schedule: MONTHLY_QUALIFICATION_SCHEDULE,
    rotationKey: 1,
    triggerAt: '2026-08-09T20:00:00Z',
  });
  assert.equal(guarded.mode, 'monthly-skip');
  assert.deepEqual(guarded.fixtures, []);
  assert.equal(guarded.skipReason, 'outside-first-utc-sunday-window');

  const candidate = selectPatrolPlan({
    eventName: 'push',
    rotationKey: 9,
    triggerAt: '2026-07-30T04:00:00Z',
  });
  assert.equal(candidate.mode, 'candidate');
  assert.equal(candidate.trialsPerFixture, 3);
  assert.equal(candidate.requiredGate, false);
});

test('weekly deep Patrol rotates two-fixture suites across the catalog', () => {
  const suites = [1, 2, 3].map(
    (rotationKey) =>
      selectPatrolPlan({
        eventName: 'workflow_dispatch',
        manualMode: 'deep',
        rotationKey,
      }).fixtures,
  );
  assert.deepEqual(suites, [
    ['incident-board-lease-v1', 'incident-board-recovery-v1'],
    ['incident-board-recovery-v1', 'incident-board-replay-v1'],
    ['incident-board-replay-v1', 'incident-board-lease-v1'],
  ]);
  assert.equal(new Set(suites.flat()).size, 3);
});

test('manual real-snapshot Patrol selects only the real Kungfu module slice', () => {
  const plan = selectPatrolPlan({
    eventName: 'workflow_dispatch',
    manualMode: 'real-snapshot',
    rotationKey: 1,
  });
  assert.equal(plan.mode, 'real-snapshot');
  assert.deepEqual(plan.fixtures, [
    'kungfu-agent-patrol-real-module-snapshot-v1',
  ]);
  assert.equal(plan.timeoutSeconds, 900);
});

test('Patrol selector rejects undeclared schedules and untrusted events', () => {
  assert.throws(
    () =>
      selectPatrolPlan({
        eventName: 'schedule',
        schedule: '0 0 * * *',
        rotationKey: 1,
      }),
    /unrecognized protected schedule/u,
  );
  assert.throws(
    () =>
      selectPatrolPlan({
        eventName: 'pull_request',
        manualMode: 'light',
        rotationKey: 1,
      }),
    /untrusted Patrol event/u,
  );
  assert.throws(
    () =>
      selectPatrolPlan({
        eventName: 'schedule',
        schedule: MONTHLY_QUALIFICATION_SCHEDULE,
        rotationKey: 1,
        triggerAt: 'not-a-time',
      }),
    /UTC trigger time/u,
  );
  const parsed = parseSelectionArgs([
    '--',
    '--event-name',
    'workflow_dispatch',
    '--manual-mode',
    'light',
    '--rotation-key',
    '7',
    '--output',
    '/tmp/plan.json',
  ]);
  assert.equal(parsed.rotationKey, 7);
});

function baseReport() {
  return {
    schema: 'kungfu.agent-repository-work.report/v1',
    evidenceClass: 'bounded-experiment',
    passed: false,
    sourceHead: SOURCE_HEAD,
    fixture: { id: 'incident-board-replay-v1' },
    runtime: {
      provider: 'opencode',
      image: IMAGE,
      directExecutable: null,
      model: MODEL,
      baseUrlRoot: ROOT_A,
      context: 65_536,
    },
    sessions: { distinct: 0 },
    continuity: {
      priorTranscriptBytes: 0,
      humanRestatementCount: 0,
    },
    warrant: {},
    dimensions: {},
    nonClaims: {
      auditableDemo: true,
      agentWorkLab: true,
      releaseGate: true,
      publicClaim: true,
      modelRanking: true,
    },
    failure: {
      category: 'verifier',
      message: `external oracle rejected repair: ${ROOT_B}`,
      outputRoot: ROOT_C,
    },
  };
}

function options(overrides = {}) {
  return {
    runnerExit: 1,
    sourceHead: SOURCE_HEAD,
    model: MODEL,
    image: IMAGE,
    ...overrides,
  };
}

test('Patrol CLIs accept the Shifu argument separator', () => {
  const classification = parseClassificationArgs([
    '--',
    '--report',
    '/tmp/report.json',
    '--output',
    '/tmp/classification.json',
    '--runner-exit',
    '1',
    '--source-head',
    SOURCE_HEAD,
    '--model',
    MODEL,
    '--image',
    IMAGE,
  ]);
  assert.equal(classification.report, '/tmp/report.json');
  assert.equal(classification.runnerExit, 1);
  const capture = parseDogfoodCaptureArgs([
    '--',
    '--classification',
    '/tmp/classification.json',
    '--output',
    '/tmp/receipt.json',
    '--intent',
    '/tmp/intent.json',
    '--workspace',
    '/tmp/workspace',
  ]);
  assert.equal(capture.classification, '/tmp/classification.json');
  assert.equal(capture.workspace, '/tmp/workspace');
});

test('passing Patrol report creates no Dogfood Finding intent', () => {
  const report = baseReport();
  Object.assign(report, {
    passed: true,
    sessions: {
      distinct: 2,
      a: { providerSessionId: 'session-a' },
      b: { providerSessionId: 'session-b' },
    },
    continuity: {
      priorTranscriptBytes: 0,
      humanRestatementCount: 0,
      root: ROOT_A,
    },
    warrant: { agentAZeroModification: true },
    claim: { root: ROOT_B },
    assessment: { root: ROOT_C },
    oracle: { passed: true, authoritative: true, reportRoot: ROOT_D },
    failure: null,
  });
  const classification = classifyReport(report, options({ runnerExit: 0 }));
  assert.equal(classification.outcome, 'passed');
  assert.equal(classification.captureRequired, false);
  assert.equal(classification.findingIntent, null);
  assert.equal(classification.issueAdmission, 'prohibited');
});

test('same normalized failure deduplicates across run roots and source commits', () => {
  const first = classifyReport(baseReport(), options());
  const secondReport = baseReport();
  secondReport.sourceHead = 'fedcba9876543210fedcba9876543210fedcba98';
  secondReport.failure.message = `external oracle rejected repair: ${ROOT_D}`;
  secondReport.failure.outputRoot = ROOT_D;
  const second = classifyReport(
    secondReport,
    options({ sourceHead: secondReport.sourceHead }),
  );
  assert.equal(first.findingIntent.findingId, second.findingIntent.findingId);
  assert.equal(
    first.findingIntent.fingerprintRoot,
    second.findingIntent.fingerprintRoot,
  );
  assert.notEqual(first.reportRoot, second.reportRoot);
  assert.equal(first.blocking, false);
  assert.equal(first.outcome, 'advisory-failure');
});

test('volatile numeric failure identifiers share one Finding identity', () => {
  const firstReport = baseReport();
  firstReport.failure.message =
    'OpenCode run 1234567 failed after 7654321 milliseconds';
  const secondReport = baseReport();
  secondReport.failure.message =
    'OpenCode run 9876543 failed after 8765432 milliseconds';
  const first = classifyReport(firstReport, options());
  const second = classifyReport(secondReport, options());
  assert.equal(first.messageRoot, second.messageRoot);
  assert.equal(first.findingIntent.findingId, second.findingIntent.findingId);
});

test('runner environment failure is captured and remains blocking', () => {
  const report = baseReport();
  report.failure.category = 'runner-environment';
  report.failure.message = 'docker daemon unavailable on trusted runner';
  const classification = classifyReport(report, options());
  assert.equal(classification.captureRequired, true);
  assert.equal(classification.blocking, true);
  assert.equal(classification.outcome, 'blocking-failure');
  assert.equal(classification.findingIntent.capture.privacy, 'internal');
  assert.equal(
    JSON.stringify(classification).includes(report.failure.message),
    false,
  );
});

test('Warrant scope failure blocks while model-quality failures stay advisory', () => {
  const report = baseReport();
  report.failure.category = 'warrant-scope';
  report.failure.message = 'candidate changed a protected path';
  const classification = classifyReport(report, options());
  assert.equal(classification.blocking, true);
  assert.equal(classification.outcome, 'blocking-failure');
});

test('report identity mismatch fails closed before capture', () => {
  const report = baseReport();
  report.runtime.model = 'other-model';
  assert.throws(
    () => classifyReport(report, options()),
    /model does not match/u,
  );
});

function result(status, value) {
  return {
    status,
    stdout: `${JSON.stringify(value)}\n`,
    stderr: '',
    error: null,
  };
}

function sourceInspection() {
  return {
    buildInfo: {
      version: '4.0.0-alpha.1',
      git: { revision: '1'.repeat(40), pristine: true },
    },
    buildInfoRoot: ROOT_A,
    shifuPath: '/repo/shifu',
    shifuRoot: ROOT_B,
    head: '1'.repeat(40),
    tree: '2'.repeat(40),
    dirty: false,
    worktree: '/repo',
  };
}

function runtimeSurfaceResult(args) {
  if (args[0] !== 'runtime') return null;
  if (args[2] === 'resolve')
    return result(0, {
      schema: 'kungfu.runtime-surface-receipt/v1',
      operationId: 'dogfood.capture',
      runtimeSurface: 'source-checkout',
      selectedProvider: 'source-shifu',
      receiptRoot: ROOT_A,
    });
  if (args[2] === 'verify')
    return result(0, {
      schema: 'kungfu.runtime-surface-verification/v1',
      ok: true,
      operationId: 'dogfood.capture',
      runtimeSurface: 'source-checkout',
      selectedProvider: 'source-shifu',
      receiptRoot: ROOT_A,
    });
  return null;
}

test('capture adapter creates one Finding and exposes no Issue path', () => {
  const classification = classifyReport(baseReport(), options());
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const runtimeResult = runtimeSurfaceResult(args);
    if (runtimeResult) return runtimeResult;
    if (args[0] === 'workspace') return result(0, { ok: true });
    if (args[1] === 'doctor') return result(0, { ok: true });
    if (args[1] === 'show')
      return result(3, {
        ok: false,
        match_count: 0,
        matches: [],
        lookup_root: ROOT_A,
      });
    return result(0, {
      status: 'captured',
      finding: {
        finding_id: classification.findingIntent.findingId,
        finding_root: ROOT_B,
      },
    });
  };
  const receipt = captureFinding(classification, {
    run,
    inspectSource: sourceInspection,
    intentPath: '/tmp/kungfu-agent-patrol-test-intent.json',
    workspaceRoot: '/tmp/kungfu-agent-patrol-test-workspace',
  });
  assert.equal(receipt.status, 'captured');
  assert.equal(receipt.issueAdmitted, false);
  assert.equal(receipt.runtimeReceipt.receiptRoot, ROOT_A);
  assert.equal(receipt.runtimeVerification.ok, true);
  assert.equal(
    calls.some((args) => args.includes('admit')),
    false,
  );
  assert.equal(
    calls.some((args) => args.includes('transition')),
    false,
  );
});

test('capture adapter reuses an existing Finding without capture', () => {
  const classification = classifyReport(baseReport(), options());
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const runtimeResult = runtimeSurfaceResult(args);
    if (runtimeResult) return runtimeResult;
    if (args[0] === 'workspace') return result(0, { ok: true });
    if (args[1] === 'doctor') return result(0, { ok: true });
    return result(0, {
      ok: true,
      match_count: 1,
      matches: [
        {
          kind: 'finding',
          record: {
            finding_id: classification.findingIntent.findingId,
            finding_root: ROOT_B,
          },
        },
      ],
      lookup_root: ROOT_C,
    });
  };
  const receipt = captureFinding(classification, {
    run,
    inspectSource: sourceInspection,
    intentPath: '/tmp/kungfu-agent-patrol-test-dedup-intent.json',
    workspaceRoot: '/tmp/kungfu-agent-patrol-test-workspace',
  });
  assert.equal(receipt.status, 'deduplicated');
  assert.equal(receipt.capturePerformed, false);
  assert.equal(calls.length, 5);
});

test('capture adapter skips Dogfood writes after a pass', () => {
  const classification = {
    schema: 'kungfu.agent-patrol.classification/v1',
    captureRequired: false,
    issueAdmission: 'prohibited',
  };
  const receipt = captureFinding(classification, {
    run: () => assert.fail('no command should run'),
    intentPath: '/tmp/unused.json',
    workspaceRoot: '/tmp/kungfu-agent-patrol-test-workspace',
  });
  assert.equal(receipt.status, 'not-required');
});

test('source CLI captures once and deduplicates in an isolated workspace', () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-agent-patrol-workspace.'),
  );
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  const previousKungfuConfigHome = process.env.KF_CONFIG_HOME;
  const workspaceRoot = path.join(temporaryRoot, 'authority');
  process.env.XDG_CONFIG_HOME = path.join(temporaryRoot, '.config');
  process.env.KF_CONFIG_HOME = path.join(temporaryRoot, 'kungfu-config');
  try {
    const classification = classifyReport(baseReport(), options());
    const first = captureFinding(classification, {
      intentPath: path.join(temporaryRoot, 'first-intent.json'),
      workspaceRoot,
    });
    const second = captureFinding(classification, {
      intentPath: path.join(temporaryRoot, 'second-intent.json'),
      workspaceRoot,
    });
    assert.equal(first.status, 'captured');
    assert.equal(second.status, 'deduplicated');
    assert.equal(first.findingRoot, second.findingRoot);
    assert.equal(second.capturePerformed, false);
    assert.equal(second.issueAdmitted, false);
  } finally {
    if (previousConfigHome === undefined)
      Reflect.deleteProperty(process.env, 'XDG_CONFIG_HOME');
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    if (previousKungfuConfigHome === undefined)
      Reflect.deleteProperty(process.env, 'KF_CONFIG_HOME');
    else process.env.KF_CONFIG_HOME = previousKungfuConfigHome;
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
