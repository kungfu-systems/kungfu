// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  candidateShellRouter,
  codexResultSchema,
  installIsolatedCodexHome,
  normalizedExperienceFromResult,
  protocolEvidenceFromCodexEventStream,
  receiptsFromCodexEventStream,
  semanticRoot,
  verifyAgentFirstValueQualification,
  verifyFirstValueReceipt,
} from './qualify-agent-first-value-codex.mjs';

test('isolated Codex home projects authentication without copying it', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-codex-home-'));
  const source = path.join(rootDir, 'source');
  const destination = path.join(rootDir, 'isolated');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'auth.json'), '{"fixture":true}\n');
  try {
    installIsolatedCodexHome(source, destination);
    const projected = path.join(destination, 'auth.json');
    assert.equal(fs.lstatSync(projected).isSymbolicLink(), true);
    assert.equal(
      fs.realpathSync(projected),
      fs.realpathSync(path.join(source, 'auth.json')),
    );
    assert.deepEqual(fs.readdirSync(destination), ['auth.json']);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('candidate shell router pins every plain kungfu command to the candidate', () => {
  const router = candidateShellRouter();
  assert.match(router, /^kungfu\(\) \{/u);
  assert.match(router, /KUNGFU_CLI_BIN/u);
  assert.match(router, /"\$@"/u);
  assert.doesNotMatch(router, /usr\/local/u);
});

test('Codex result schema constrains the user response without copying receipts', () => {
  const schema = codexResultSchema();
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    'response',
    'personalizationBasis',
    'verificationCommand',
    'nextStepCommand',
  ]);
  assert.equal(schema.properties.response.maxLength, 2048);
  assert.match(
    schema.properties.response.description,
    /complete user-visible Chinese answer/u,
  );
  assert.deepEqual(schema.properties.verificationCommand.enum, [
    'kungfu agent status --target codex --scope project --json',
  ]);
  assert.deepEqual(schema.properties.nextStepCommand.enum, [
    'kungfu project list --json',
    'kungfu project open-plan --path . --json',
  ]);
});

const root = (character) => `sha256:${character.repeat(64)}`;

function receipt(number, promptRoot = root('1')) {
  const value = {
    schema: 'kungfu.agent-first-value-receipt/v1',
    verdict: 'verified',
    attemptId: `trial-${number}`,
    provider: {
      surface: 'kungfu-cli',
      qualificationScope: 'candidate-local-rerun',
    },
    platform: { system: 'darwin', machine: 'arm64' },
    promptRoot,
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

const protocolEvidence = () => ({
  brief: { commandRoot: root('a'), outputRoot: root('b') },
  'first-value-start': { commandRoot: root('a'), outputRoot: root('b') },
});

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

test('binds autonomous protocol completion to command execution outputs', () => {
  const value = receipt(1);
  const command = (text, output) =>
    JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: text,
        aggregated_output: output,
      },
    });
  const stream = [
    command("/bin/zsh -lc 'kungfu agent brief'", '# Kungfu Agent Brief'),
    command('kungfu agent first-value start --json', JSON.stringify(value)),
  ].join('\n');

  assert.deepEqual(
    Object.keys(protocolEvidenceFromCodexEventStream(stream, root('1'))).sort(),
    ['brief', 'first-value-start'],
  );
});

test('protocol evidence rejects a brief command hidden inside another executable name', () => {
  const stream = JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      command: 'notkungfu agent brief',
      aggregated_output: '# Kungfu Agent Brief',
    },
  });
  assert.throws(
    () => protocolEvidenceFromCodexEventStream(stream, root('1')),
    /protocol evidence brief expected one verified command, got 0/u,
  );
});

test('normalizes experience only when the evidence is user-visible and safe', () => {
  const value = receipt(1);
  const verification =
    'kungfu agent status --target codex --scope project --json';
  const next = 'kungfu project list --json';
  const scopeStatement =
    '本次只验证了这个本地 Codex 与候选 CLI；未验证 Claude、CI 托管 Codex、其他平台或公开发布。';
  const result = {
    response: `Kungfu 为当前 Codex 工具提供可核验的工作入口。本次 receipt 是 ${value.receiptRoot}。验证命令：${verification}；下一步：${next}。${scopeStatement}`,
    personalizationBasis: 'current-tools',
    verificationCommand: verification,
    nextStepCommand: next,
  };

  assert.equal(
    normalizedExperienceFromResult(result, value).intentId,
    'onboarding',
  );
  const validResponse = result.response;
  result.response = result.response.replace(value.receiptRoot, root('f'));
  assert.throws(
    () => normalizedExperienceFromResult(result, value),
    /receipt citation omitted or changed/u,
  );
  result.response = validResponse;
  result.nextStepCommand = 'kungfu project open-plan --execute';
  assert.throws(
    () => normalizedExperienceFromResult(result, value),
    /cannot execute writes/u,
  );
});

function qualification() {
  const promptRoots = [
    ...Array(5).fill(root('1')),
    root('a'),
    root('b'),
    root('c'),
    root('d'),
    root('e'),
  ];
  const receipts = promptRoots.map((promptRoot, index) =>
    receipt(index + 1, promptRoot),
  );
  const report = {
    schema: 'kungfu.agent-first-value-local-codex-qualification/v2',
    qualified: true,
    provider: {
      surface: 'codex-cli',
      version: 'codex-cli fixture',
      executionMode: 'codex-exec-ephemeral',
      contextIsolation: 'ephemeral-auth-link',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'low',
    },
    platform: { system: 'darwin', arch: 'arm64' },
    candidate: {
      executableRoot: root('9'),
      sourceRevision: 'a'.repeat(40),
      productCandidateRoot: root('2'),
    },
    promptRoot: root('1'),
    promptCoverage: [
      { id: 'canonical', root: root('1'), requiredCount: 5, count: 5 },
      ...['a', 'b', 'c', 'd', 'e'].map((value, index) => ({
        id: `variant-${index + 1}`,
        root: root(value),
        requiredCount: 1,
        count: 1,
      })),
    ],
    canonicalTrialCount: 5,
    experienceDimensions: [
      'autonomous-pack-verification',
      'exactly-one-declared-intent',
      'safe-discovery',
      'question-count-at-most-one',
      'candidate-bound-receipt-verification',
      'personalized-plain-language-explanation',
      'user-visible-verification',
      'actionable-safe-next-step',
      'qualification-non-claims',
    ],
    trialCount: 10,
    trials: receipts.map((value, index) => ({
      attemptId: value.attemptId,
      verified: true,
      promptId: index < 5 ? 'canonical' : `variant-${index - 4}`,
      promptRoot: value.promptRoot,
      workspaceRoot: semanticRoot({ workspace: index }),
      eventStreamRoot: semanticRoot({ events: index }),
      responseRoot: semanticRoot({ response: index }),
      questionMarkCount: 0,
      protocolEvidence: protocolEvidence(),
      receipt: value,
      verificationRoot: root('8'),
      experience: {
        intentId: 'onboarding',
        personalizationBasis: ['current-tools'],
        personalizationExplanationRoot: root('9'),
        receiptCitationRoot: root('d'),
        verificationCommand:
          'kungfu agent status --target codex --scope project --json',
        verificationExpectedRoot: root('a'),
        nextStepCommand: 'kungfu project list --json',
        nextStepSafetyClass: 'read-only',
        nextStepReasonRoot: root('b'),
        scopeStatementRoot: root('e'),
        nonClaims: value.nonClaims.slice(0, 4).sort(),
        independentVerificationRoot: root('c'),
      },
    })),
    rawTranscriptRetained: false,
    ciDependency: false,
    nonClaims: receipts[0].nonClaims,
    observedAt: '2026-08-02T00:00:00.000Z',
  };
  report.qualificationRoot = semanticRoot(report);
  return report;
}

test('deterministic CI verifier accepts ten independent rooted experiences', () => {
  const report = qualification();
  assert.equal(
    verifyFirstValueReceipt(report.trials[0].receipt).verdict,
    'verified',
  );
  assert.equal(verifyAgentFirstValueQualification(report).verified, true);
});

test('deterministic CI verifier rejects an unbounded Codex reasoning profile', () => {
  const report = qualification();
  report.provider.reasoningEffort = 'high';
  report.qualificationRoot = semanticRoot({
    ...report,
    qualificationRoot: undefined,
  });
  assert.throws(
    () => verifyAgentFirstValueQualification(report),
    /reasoning effort mismatch/u,
  );
});

test('deterministic CI verifier rejects an unpinned Codex model', () => {
  const report = qualification();
  report.provider.model = 'default';
  report.qualificationRoot = semanticRoot({
    ...report,
    qualificationRoot: undefined,
  });
  assert.throws(
    () => verifyAgentFirstValueQualification(report),
    /model mismatch/u,
  );
});

test('deterministic CI verifier rejects inherited Codex context', () => {
  const report = qualification();
  report.provider.contextIsolation = 'inherited';
  report.qualificationRoot = semanticRoot({
    ...report,
    qualificationRoot: undefined,
  });
  assert.throws(
    () => verifyAgentFirstValueQualification(report),
    /context isolation mismatch/u,
  );
});

test('deterministic CI verifier rejects one failed or reused trial', () => {
  const failed = qualification();
  failed.trials[9].verified = false;
  failed.qualificationRoot = semanticRoot({
    ...failed,
    qualificationRoot: undefined,
  });
  assert.throws(
    () => verifyAgentFirstValueQualification(failed),
    /trial is not verified/u,
  );

  const reused = qualification();
  reused.trials[9].workspaceRoot = reused.trials[8].workspaceRoot;
  assert.throws(
    () => verifyAgentFirstValueQualification(reused),
    /workspaces are not independent/u,
  );
});

test('deterministic CI verifier rejects prose-only success without protocol evidence', () => {
  const report = qualification();
  report.trials[0].protocolEvidence = undefined;
  assert.throws(
    () => verifyAgentFirstValueQualification(report),
    /omitted autonomous protocol evidence/u,
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
