// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codexResultSchema,
  receiptsFromCodexEventStream,
  semanticRoot,
  verifyAgentFirstValueQualification,
  verifyFirstValueReceipt,
} from './qualify-agent-first-value-codex.mjs';

test('Codex result schema constrains the user response without copying receipts', () => {
  assert.deepEqual(codexResultSchema(), {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['response'],
    properties: { response: { type: 'string', minLength: 40 } },
  });
});

const root = (character) => `sha256:${character.repeat(64)}`;

function receipt(number) {
  const value = {
    schema: 'kungfu.agent-first-value-receipt/v1',
    verdict: 'verified',
    attemptId: `trial-${number}`,
    provider: {
      surface: 'kungfu-cli',
      qualificationScope: 'candidate-local-rerun',
    },
    platform: { system: 'darwin', machine: 'arm64' },
    promptRoot: root('1'),
    productIdentity: {
      version: '4.0.0-alpha.1',
      candidateRoot: root('2'),
      contractRoot: root('3'),
      briefRoot: root('4'),
      intentMapRoot: root('5'),
      sourceRevision: 'a'.repeat(40),
    },
    questionCount: 0,
    intentId: 'onboarding',
    discovery: {
      command: 'kungfu agent status --target codex --scope project --json',
      safetyClass: 'read-only',
      exitCode: 0,
      outputRoot: root('6'),
      outputBytes: 3,
    },
    outcome: {
      kind: 'verified-discovery',
      summaryRoot: root('7'),
      verificationRoot: root('8'),
    },
    nonClaims: [
      'claude-qualified',
      'ci-hosted-codex-qualified',
      'other-platforms-qualified',
      'public-release-qualified',
      'model-output-alone-is-proof',
      'brief-or-skill-grants-write-authority',
    ],
    diagnostics: [],
    observedAt: '2026-08-02T00:00:00.000Z',
  };
  value.receiptRoot = semanticRoot(value);
  return value;
}

test('extracts only CLI receipts from Codex command execution events', () => {
  const value = receipt(1);
  const stream = [
    JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        aggregated_output: JSON.stringify({
          final_output: `command output\n${JSON.stringify(value, null, 2)}\n${JSON.stringify(value)}\n`,
        }),
      },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: JSON.stringify(receipt(2)) },
    }),
  ].join('\n');

  assert.deepEqual(receiptsFromCodexEventStream(stream), [value]);
});

test('keeps independently emitted CLI receipts distinct', () => {
  const first = receipt(1);
  const second = receipt(2);
  const stream = JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      aggregated_output: `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
    },
  });

  assert.deepEqual(receiptsFromCodexEventStream(stream), [first, second]);
});

function qualification() {
  const receipts = [receipt(1), receipt(2), receipt(3)];
  const report = {
    schema: 'kungfu.agent-first-value-local-codex-qualification/v1',
    qualified: true,
    provider: {
      surface: 'codex-cli',
      version: 'codex-cli fixture',
      executionMode: 'codex-exec-ephemeral',
    },
    platform: { system: 'darwin', arch: 'arm64' },
    candidate: {
      executableRoot: root('9'),
      sourceRevision: 'a'.repeat(40),
      productCandidateRoot: root('2'),
    },
    promptRoot: root('1'),
    trialCount: 3,
    trials: receipts.map((value, index) => ({
      attemptId: value.attemptId,
      verified: true,
      workspaceRoot: root(String(index + 3)),
      eventStreamRoot: root(String(index + 6)),
      responseRoot: root(String(index + 1)),
      questionMarkCount: 0,
      receipt: value,
      verificationRoot: root(String(index + 4)),
    })),
    rawTranscriptRetained: false,
    ciDependency: false,
    nonClaims: receipts[0].nonClaims,
    observedAt: '2026-08-02T00:00:00.000Z',
  };
  report.qualificationRoot = semanticRoot(report);
  return report;
}

test('deterministic CI verifier accepts three independent rooted receipts', () => {
  const report = qualification();
  assert.equal(
    verifyFirstValueReceipt(report.trials[0].receipt).verdict,
    'verified',
  );
  assert.equal(verifyAgentFirstValueQualification(report).verified, true);
});

test('deterministic CI verifier rejects one failed or reused trial', () => {
  const failed = qualification();
  failed.trials[2].verified = false;
  failed.qualificationRoot = semanticRoot({
    ...failed,
    qualificationRoot: undefined,
  });
  assert.throws(
    () => verifyAgentFirstValueQualification(failed),
    /trial is not verified/u,
  );

  const reused = qualification();
  reused.trials[2].workspaceRoot = reused.trials[1].workspaceRoot;
  assert.throws(
    () => verifyAgentFirstValueQualification(reused),
    /workspaces are not independent/u,
  );
});

test('deterministic CI verifier rejects tampered receipt facts', () => {
  const value = receipt(1);
  value.questionCount = 1;
  assert.throws(
    () => verifyFirstValueReceipt(value),
    /semantic root mismatch/u,
  );
});
