// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyReport,
  jsonRoot,
} from '../framework/agent-patrol/classify.mjs';
import { captureFinding } from '../framework/agent-patrol/dogfood-capture.mjs';

const IMAGE =
  'ghcr.io/kungfu-systems/build-images/opencode-ci@sha256:4083ee089fa9a419f4915505094a6c1bcce433ff77455605ce8993af3b684ed3';
const MODEL = 'qwen3-coder:30b-opencode-64k';
const SOURCE_HEAD = '0123456789abcdef0123456789abcdef01234567';
const ROOT_A = `sha256:${'a'.repeat(64)}`;
const ROOT_B = `sha256:${'b'.repeat(64)}`;
const ROOT_C = `sha256:${'c'.repeat(64)}`;
const ROOT_D = `sha256:${'d'.repeat(64)}`;

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
      qualificationLab: true,
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

test('capture adapter creates one Finding and exposes no Issue path', () => {
  const classification = classifyReport(baseReport(), options());
  const calls = [];
  const run = (args) => {
    calls.push(args);
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
    intentPath: '/tmp/kungfu-agent-patrol-test-intent.json',
    workspaceRoot: '/tmp/kungfu-agent-patrol-test-workspace',
  });
  assert.equal(receipt.status, 'captured');
  assert.equal(receipt.issueAdmitted, false);
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
    intentPath: '/tmp/kungfu-agent-patrol-test-dedup-intent.json',
    workspaceRoot: '/tmp/kungfu-agent-patrol-test-workspace',
  });
  assert.equal(receipt.status, 'deduplicated');
  assert.equal(receipt.capturePerformed, false);
  assert.equal(calls.length, 3);
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
