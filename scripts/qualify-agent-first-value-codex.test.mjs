// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  candidateShellRouter,
  experienceResultFromResponse,
  installIsolatedCodexHome,
  normalizedExperienceFromResult,
  protocolEvidenceFromCodexEventStream,
  receiptsFromCodexEventStream,
  sameCanonicalPath,
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

test('candidate Skill destination accepts canonical and symlinked workspace paths', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-skill-path-'));
  const physical = path.join(rootDir, 'physical');
  const alias = path.join(rootDir, 'alias');
  fs.mkdirSync(physical);
  fs.symlinkSync(physical, alias, 'dir');
  try {
    assert.equal(sameCanonicalPath(physical, alias), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('natural Codex response yields one bounded experience record', () => {
  const receiptRoot = `sha256:${'9'.repeat(64)}`;
  const answerTemplate = [
    'Kungfu 给 Agent 一个可核验的工作入口。',
    '个性化依据：当前工具',
    'kungfu agent status --target codex --scope project --json',
    'kungfu project list',
    '回执：{receiptRoot}',
  ].join('\n');
  const response = [
    'Kungfu 给 Agent 一个可核验的工作入口。',
    '个性化依据：当前工具',
    'kungfu agent status --target codex --scope project --json',
    'kungfu project list',
    `回执：${receiptRoot}`,
  ].join('\n');
  const selected = {
    receiptRoot,
    agentResponseGuide: {
      personalizationBasis: 'current-tools',
      personalizationLabel: '个性化依据：当前工具',
      answerTemplate,
    },
  };
  assert.deepEqual(experienceResultFromResponse(response, selected), {
    response,
    personalizationBasis: 'current-tools',
    verificationCommand:
      'kungfu agent status --target codex --scope project --json',
    nextStepCommand: 'kungfu project list',
  });
  assert.throws(
    () =>
      experienceResultFromResponse(
        response.replace('个性化依据：当前工具', '个性化依据：用户目标'),
        selected,
      ),
    /omitted the receipt-selected personalization label/u,
  );
  assert.throws(
    () =>
      experienceResultFromResponse(
        response.replace('kungfu project list', '稍后再说'),
        selected,
      ),
    /named 0 safe next steps/u,
  );
});

const root = (character) => `sha256:${character.repeat(64)}`;
const bytesRoot = (value) =>
  `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;

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
    agentResponseGuide: {
      language: 'zh-CN',
      protocolComplete: true,
      mustNotRunMoreCommands: true,
      instruction:
        '协议已完成，禁止再执行命令、解释、扩展或提问。最终回答必须只输出 answerTemplate，并将其中唯一的 {receiptRoot} 替换为顶层 receiptRoot。',
      explanationSeed:
        'Kungfu 是为 Agent 工作提供本地项目边界、权限路径和可核验证据的协作层；这次第一步已完成只读环境发现。',
      answerTemplate: [
        'Kungfu 是为 Agent 工作提供本地项目边界、权限路径和可核验证据的协作层；这次第一步已完成只读环境发现。',
        '个性化依据：用户目标',
        '验证命令：kungfu agent status --target codex --scope project --json',
        '下一步：kungfu project list',
        '回执：{receiptRoot}',
        '本次只验证了这个本地 Codex 与候选 CLI；未验证 Claude、CI 托管 Codex、其他平台或公开发布。',
      ].join('\n'),
      personalizationBasis: 'user-goal',
      personalizationLabel: '个性化依据：用户目标',
      verificationCommand:
        'kungfu agent status --target codex --scope project --json',
      nextStepCommand: 'kungfu project list',
      scopeStatement:
        '本次只验证了这个本地 Codex 与候选 CLI；未验证 Claude、CI 托管 Codex、其他平台或公开发布。',
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
  'provider-skill': { commandRoot: root('a'), outputRoot: root('b') },
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
    command(
      "sed -n '1,240p' .agents/skills/kungfu-agent-onboarding/SKILL.md",
      'candidate provider skill',
    ),
    command("/bin/zsh -lc 'kungfu agent brief'", '# Kungfu Agent Brief'),
    command('kungfu agent first-value start --json', JSON.stringify(value)),
  ].join('\n');

  assert.deepEqual(
    Object.keys(
      protocolEvidenceFromCodexEventStream(
        stream,
        root('1'),
        bytesRoot('candidate provider skill'),
      ),
    ).sort(),
    ['brief', 'first-value-start', 'provider-skill'],
  );
});

test('protocol evidence rejects a brief command hidden inside another executable name', () => {
  const skill = 'candidate provider skill';
  const stream = [
    JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command:
          "sed -n '1,240p' .agents/skills/kungfu-agent-onboarding/SKILL.md",
        aggregated_output: skill,
      },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: 'notkungfu agent brief',
        aggregated_output: '# Kungfu Agent Brief',
      },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: 'kungfu agent first-value start --json',
        aggregated_output: JSON.stringify(receipt(1)),
      },
    }),
  ].join('\n');
  assert.throws(
    () =>
      protocolEvidenceFromCodexEventStream(stream, root('1'), bytesRoot(skill)),
    /protocol evidence brief expected one verified command, got 0/u,
  );
});

test('protocol evidence rejects any command beyond Skill load, brief, and first-value start', () => {
  const value = receipt(1);
  const skill = 'candidate provider skill';
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
    command(
      "sed -n '1,240p' .agents/skills/kungfu-agent-onboarding/SKILL.md",
      skill,
    ),
    command('kungfu agent brief', '# Kungfu Agent Brief'),
    command('kungfu agent first-value start --json', JSON.stringify(value)),
    command('kungfu project list', '{}'),
  ].join('\n');
  assert.throws(
    () =>
      protocolEvidenceFromCodexEventStream(stream, root('1'), bytesRoot(skill)),
    /exactly three command executions, got 4/u,
  );
});

test('normalizes experience only when the evidence is user-visible and safe', () => {
  const value = receipt(1);
  const verification =
    'kungfu agent status --target codex --scope project --json';
  const next = 'kungfu project list';
  const scopeStatement =
    '本次只验证了这个本地 Codex 与候选 CLI；未验证 Claude、CI 托管 Codex、其他平台或公开发布。';
  const result = {
    response: `Kungfu 为当前 Codex 工具提供可核验的工作入口。个性化依据：当前工具。本次 receipt 是 ${value.receiptRoot}。验证命令：${verification}；下一步：${next}。${scopeStatement}`,
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
      contextIsolation: 'ephemeral-auth-link-candidate-project-skill',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
    },
    platform: { system: 'darwin', arch: 'arm64' },
    candidate: {
      executableRoot: root('9'),
      sourceRevision: 'a'.repeat(40),
      productCandidateRoot: root('2'),
      providerSkillRoot: root('f'),
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
      providerSkill: {
        target: 'codex',
        scope: 'project',
        root: root('f'),
      },
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
        nextStepCommand: 'kungfu project list',
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
