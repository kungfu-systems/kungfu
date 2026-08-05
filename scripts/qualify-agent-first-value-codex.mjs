// SPDX-License-Identifier: Apache-2.0
// Local-only Codex qualification. CI imports the pure verifier but never runs Codex.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40,64}$/u;
const RECEIPT_SCHEMA = 'kungfu.agent-first-value-receipt/v1';
const QUALIFICATION_SCHEMA =
  'kungfu.agent-first-value-local-codex-qualification/v2';
const REQUIRED_TRIALS = 10;
const MINIMUM_CANONICAL_TRIALS = 5;
const QUALIFICATION_MODEL = 'gpt-5.6-sol';
const QUALIFICATION_REASONING_EFFORT = 'medium';
const QUALIFICATION_CONTEXT_ISOLATION =
  'ephemeral-auth-link-candidate-project-skill';
const PROVIDER_SKILL_SCOPE = 'candidate-project';
const REQUIRED_NON_CLAIMS = [
  'claude-qualified',
  'ci-hosted-codex-qualified',
  'other-platforms-qualified',
  'public-release-qualified',
];
const LOCAL_QUALIFICATION_SCOPE_STATEMENT =
  '本次只验证了这个本地 Codex 与候选 CLI；未验证 Claude、CI 托管 Codex、其他平台或公开发布。';
const VERIFICATION_COMMAND =
  'kungfu agent status --target codex --scope project --json';
const NEXT_STEP_COMMANDS = ['kungfu project list'];
const PERSONALIZATION_BASIS = [
  'user-goal',
  'current-tools',
  'risk-tolerance',
  'detail-preference',
  'workspace',
  'work-style',
];
const PERSONALIZATION_LABELS = {
  'user-goal': '个性化依据：用户目标',
  'current-tools': '个性化依据：当前工具',
  'risk-tolerance': '个性化依据：风险偏好',
  'detail-preference': '个性化依据：细节偏好',
  workspace: '个性化依据：当前目录',
  'work-style': '个性化依据：工作方式',
};
const EXPERIENCE_DIMENSIONS = [
  'autonomous-pack-verification',
  'exactly-one-declared-intent',
  'safe-discovery',
  'question-count-at-most-one',
  'candidate-bound-receipt-verification',
  'personalized-plain-language-explanation',
  'user-visible-verification',
  'actionable-safe-next-step',
  'qualification-non-claims',
];

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

export function semanticRoot(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex')}`;
}

export function candidateShellRouter() {
  return [
    'kungfu() {',
    '  "${KUNGFU_CLI_BIN:?KUNGFU_CLI_BIN is required}" "$@"',
    '}',
    '',
  ].join('\n');
}

function installCandidateShellRouter(home) {
  fs.writeFileSync(path.join(home, '.zshenv'), candidateShellRouter(), 'utf8');
}

export function sameCanonicalPath(left, right) {
  return fs.realpathSync(left) === fs.realpathSync(right);
}

function installCandidateCodexSkill(kungfu, workspace, env) {
  const destination = path.join(
    fs.realpathSync(workspace),
    '.agents',
    'skills',
    'kungfu-agent-onboarding',
    'SKILL.md',
  );
  const payload = parseJson(
    successful(
      spawnSync(
        kungfu,
        [
          'agent',
          'install-skill',
          '--target',
          'codex',
          '--scope',
          'project',
          '--execute',
          '--json',
        ],
        { cwd: workspace, encoding: 'utf8', env },
      ),
      'candidate Codex Skill installation',
    ).stdout,
    'candidate Codex Skill installation',
  );
  assert(
    payload.schema === 'kungfu.agent-skill-install/v1' &&
      payload.target === 'codex' &&
      payload.scope === 'project' &&
      payload.execute === true &&
      payload.changed === true,
    'candidate Codex Skill installation receipt drifted',
  );
  assert(
    sameCanonicalPath(payload.destination || '', destination),
    'candidate Codex Skill installed outside the isolated workspace',
  );
  const bytes = fs.readFileSync(destination);
  assert(
    bytes.includes(Buffer.from('name: kungfu-agent-onboarding')) &&
      bytes.includes(Buffer.from('agentResponseGuide.answerTemplate')),
    'candidate Codex Skill omitted the bounded first-value protocol',
  );
  return {
    target: 'codex',
    scope: 'project',
    root: bytesRoot(bytes),
  };
}

export function installIsolatedCodexHome(sourceCodexHome, destination) {
  const sourceAuth = fs.realpathSync(path.join(sourceCodexHome, 'auth.json'));
  fs.mkdirSync(destination, { recursive: true });
  fs.symlinkSync(sourceAuth, path.join(destination, 'auth.json'));
  return destination;
}

function jsonObjects(value) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          objects.push(JSON.parse(value.slice(start, index + 1)));
        } catch {
          // Command wrappers may contain non-JSON braces; keep scanning.
        }
        start = -1;
      }
    }
  }
  return objects;
}

export function receiptsFromCodexEventStream(jsonl) {
  const receipts = [];
  const seen = new Set();
  const collect = (value, depth = 0) => {
    if (depth > 8) return;
    if (Array.isArray(value)) {
      for (const child of value) collect(child, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      if (value.schema === RECEIPT_SCHEMA) {
        const key = JSON.stringify(stable(value));
        if (!seen.has(key)) {
          seen.add(key);
          receipts.push(value);
        }
      } else
        for (const child of Object.values(value)) collect(child, depth + 1);
      return;
    }
    if (typeof value !== 'string' || !value.includes(RECEIPT_SCHEMA)) return;
    for (const child of jsonObjects(value)) collect(child, depth + 1);
  };
  for (const line of String(jsonl).split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      event?.type !== 'item.completed' ||
      event.item?.type !== 'command_execution'
    )
      continue;
    for (const field of ['aggregated_output', 'output', 'text']) {
      if (typeof event.item[field] !== 'string') continue;
      collect(event.item[field]);
    }
  }
  return receipts;
}

function commandExecutions(jsonl) {
  const executions = [];
  for (const line of String(jsonl).split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (
        event?.type === 'item.completed' &&
        event.item?.type === 'command_execution' &&
        typeof event.item.command === 'string'
      ) {
        executions.push({
          command: event.item.command,
          output: String(
            event.item.aggregated_output ||
              event.item.output ||
              event.item.text ||
              '',
          ),
        });
      }
    } catch {
      // Provider event streams are untrusted input; malformed lines are ignored.
    }
  }
  return executions;
}

function outputHasJson(output, predicate) {
  return jsonObjects(output).some((value) => {
    if (predicate(value)) return true;
    return Object.values(value || {}).some(
      (child) => child && typeof child === 'object' && predicate(child),
    );
  });
}

function commandInvokesKungfu(command, expectedArgs) {
  const words = String(command)
    .replace(/["'`]/gu, ' ')
    .split(/\s+/u)
    .map((word) => word.replace(/^[;&|()]+|[;&|()]+$/gu, ''))
    .filter(Boolean);
  return words.some((word, index) => {
    const executable = path.basename(word);
    if (
      executable !== 'kungfu' &&
      word !== '$KUNGFU_CLI_BIN' &&
      word !== '${KUNGFU_CLI_BIN}'
    )
      return false;
    return expectedArgs.every(
      (expected, offset) => words[index + offset + 1] === expected,
    );
  });
}

export function protocolEvidenceFromCodexEventStream(
  jsonl,
  expectedPromptRoot,
  expectedProviderSkillRoot,
) {
  const requirements = [
    {
      id: 'provider-skill',
      command: (value) =>
        value.includes('.agents/skills/kungfu-agent-onboarding/SKILL.md'),
      output: (value) =>
        bytesRoot(Buffer.from(value)) === expectedProviderSkillRoot,
    },
    {
      id: 'brief',
      command: (value) => commandInvokesKungfu(value, ['agent', 'brief']),
      output: (value) => value.includes('# Kungfu Agent Brief'),
    },
    {
      id: 'first-value-start',
      command: (value) => value.includes('agent first-value start --json'),
      output: (value) =>
        outputHasJson(
          value,
          (row) =>
            row?.schema === RECEIPT_SCHEMA &&
            row.promptRoot === expectedPromptRoot,
        ),
    },
  ];
  const executions = commandExecutions(jsonl);
  assert(
    executions.length === 3,
    `protocol expected exactly three command executions, got ${executions.length}`,
  );
  const evidence = {};
  for (const requirement of requirements) {
    const matches = executions.filter(
      (execution) =>
        requirement.command(execution.command) &&
        requirement.output(execution.output),
    );
    assert(
      matches.length === 1,
      `protocol evidence ${requirement.id} expected one verified command, got ${matches.length}`,
    );
    evidence[requirement.id] = {
      commandRoot: bytesRoot(Buffer.from(matches[0].command)),
      outputRoot: bytesRoot(Buffer.from(matches[0].output)),
    };
  }
  return evidence;
}

function codexEventInventory(jsonl) {
  const inventory = new Set();
  for (const line of String(jsonl).split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const command = String(event?.item?.command || '');
      const output = String(
        event?.item?.aggregated_output ||
          event?.item?.output ||
          event?.item?.text ||
          '',
      );
      const isReceiptCommand = command.includes('first-value receipt');
      const outputSchemas = isReceiptCommand
        ? jsonObjects(output)
            .map((value) => value?.schema)
            .filter((value) => typeof value === 'string')
            .slice(0, 4)
            .join(',')
        : '';
      inventory.add(
        [
          event?.type || 'unknown-event',
          event?.item?.type || 'no-item',
          Object.keys(event?.item || {})
            .sort()
            .join(','),
          event?.item?.type === 'command_execution'
            ? `receipt-command=${isReceiptCommand}`
            : '',
          event?.item?.type === 'command_execution'
            ? `receipt-output=${output.includes(RECEIPT_SCHEMA)}`
            : '',
          isReceiptCommand ? `exit=${event.item.exit_code}` : '',
          isReceiptCommand ? `output-bytes=${Buffer.byteLength(output)}` : '',
          isReceiptCommand
            ? `output-root=${bytesRoot(Buffer.from(output))}`
            : '',
          isReceiptCommand ? `schemas=${outputSchemas || 'none'}` : '',
        ].join(':'),
      );
    } catch {
      inventory.add('non-json-event');
    }
  }
  return [...inventory].sort().join(' | ').slice(0, 2048);
}

function bytesRoot(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error.message}`);
  }
}

function successful(result, label) {
  if (result.error) throw new Error(`${label} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const evidenceRoot = bytesRoot(
      Buffer.from(`${result.stdout || ''}\n${result.stderr || ''}`),
    );
    const diagnostics = [];
    for (const line of String(result.stdout || '').split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const message =
          event?.type === 'error'
            ? event.message
            : event?.type === 'turn.failed'
              ? event.error?.message
              : null;
        if (typeof message === 'string' && message.trim())
          diagnostics.push(message.trim().slice(0, 512));
      } catch {
        // Raw provider output is intentionally not retained or echoed.
      }
    }
    const diagnostic = diagnostics.length
      ? `; provider diagnostic: ${diagnostics.join(' | ')}`
      : '';
    throw new Error(
      `${label} failed with exit ${result.status ?? 'signal'}; output root ${evidenceRoot}${diagnostic}`,
    );
  }
  return result;
}

function finalAgentMessage(jsonl) {
  let final = null;
  for (const line of String(jsonl).split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      event?.type === 'item.completed' &&
      event.item?.type === 'agent_message' &&
      typeof event.item.text === 'string'
    ) {
      final = event.item.text;
    }
  }
  if (final === null)
    throw new Error('Codex event stream omitted a final agent message');
  return final;
}

export function verifyFirstValueReceipt(receipt, expected = {}) {
  assert(
    receipt?.schema === RECEIPT_SCHEMA,
    'unexpected first-value receipt schema',
  );
  assert(receipt.verdict === 'verified', 'first-value receipt is not verified');
  assert(
    ROOT_PATTERN.test(receipt.receiptRoot || ''),
    'receipt root is invalid',
  );
  const { receiptRoot, ...subject } = receipt;
  assert(
    receiptRoot === semanticRoot(subject),
    'receipt semantic root mismatch',
  );
  assert(
    receipt.provider?.surface === 'kungfu-cli',
    'receipt producer is not Kungfu CLI',
  );
  assert(
    receipt.provider?.qualificationScope === 'candidate-local-rerun',
    'receipt scope is not a candidate-local rerun',
  );
  assert(
    Number.isInteger(receipt.questionCount) &&
      receipt.questionCount >= 0 &&
      receipt.questionCount <= 1,
    'receipt question count is outside 0..1',
  );
  assert(
    typeof receipt.intentId === 'string' && receipt.intentId,
    'receipt omitted intent',
  );
  assert(
    receipt.discovery?.exitCode === 0 &&
      ['read-only', 'preview-safe'].includes(receipt.discovery?.safetyClass) &&
      ROOT_PATTERN.test(receipt.discovery?.outputRoot || '') &&
      receipt.discovery?.outputBytes > 0,
    'receipt omitted a verified safe discovery',
  );
  assert(
    receipt.outcome?.kind === 'verified-discovery' &&
      ROOT_PATTERN.test(receipt.outcome?.summaryRoot || '') &&
      ROOT_PATTERN.test(receipt.outcome?.verificationRoot || ''),
    'receipt omitted a minimal verified outcome',
  );
  assert(
    receipt.agentResponseGuide?.protocolComplete === true &&
      receipt.agentResponseGuide?.mustNotRunMoreCommands === true &&
      typeof receipt.agentResponseGuide?.instruction === 'string' &&
      receipt.agentResponseGuide.instruction.length > 0 &&
      typeof receipt.agentResponseGuide?.explanationSeed === 'string' &&
      receipt.agentResponseGuide.explanationSeed.includes('Kungfu') &&
      receipt.agentResponseGuide?.answerTemplate ===
        [
          receipt.agentResponseGuide.explanationSeed,
          receipt.agentResponseGuide.personalizationLabel,
          `验证命令：${receipt.agentResponseGuide.verificationCommand}`,
          `下一步：${receipt.agentResponseGuide.nextStepCommand}`,
          '回执：{receiptRoot}',
          receipt.agentResponseGuide.scopeStatement,
        ].join('\n') &&
      PERSONALIZATION_BASIS.includes(
        receipt.agentResponseGuide?.personalizationBasis,
      ) &&
      receipt.agentResponseGuide?.personalizationLabel ===
        PERSONALIZATION_LABELS[
          receipt.agentResponseGuide?.personalizationBasis
        ] &&
      receipt.agentResponseGuide?.verificationCommand ===
        receipt.discovery?.command &&
      NEXT_STEP_COMMANDS.includes(
        receipt.agentResponseGuide?.nextStepCommand,
      ) &&
      receipt.agentResponseGuide?.scopeStatement ===
        LOCAL_QUALIFICATION_SCOPE_STATEMENT,
    'receipt response guide is invalid',
  );
  assert(
    expected.promptRoot === undefined ||
      receipt.promptRoot === expected.promptRoot,
    'receipt prompt root mismatch',
  );
  assert(
    expected.attemptId === undefined ||
      receipt.attemptId === expected.attemptId,
    'receipt attempt id mismatch',
  );
  assert(
    expected.candidateRoot === undefined ||
      receipt.productIdentity?.candidateRoot === expected.candidateRoot,
    'receipt candidate root mismatch',
  );
  assert(
    expected.sourceRevision === undefined ||
      receipt.productIdentity?.sourceRevision === expected.sourceRevision,
    'receipt source revision mismatch',
  );
  return receipt;
}

function safeUserCommand(command, label) {
  assert(
    typeof command === 'string' && command.startsWith('kungfu '),
    `${label} must use the public Kungfu CLI`,
  );
  assert(!command.includes('--execute'), `${label} cannot execute writes`);
  assert(
    !/[;&|`]|\$\(/u.test(command),
    `${label} cannot contain shell composition`,
  );
}

export function normalizedExperienceFromResult(result, receipt) {
  assert(
    typeof result?.response === 'string' && result.response.includes('Kungfu'),
    'response omitted a plain-language Kungfu explanation',
  );
  assert(PERSONALIZATION_BASIS.includes(result.personalizationBasis));
  assert(
    result.response.includes(
      PERSONALIZATION_LABELS[result.personalizationBasis],
    ),
    'personalization basis was not named in the user-visible response',
  );
  assert(
    result.response.includes(receipt.receiptRoot),
    'receipt citation omitted or changed the CLI receipt root',
  );
  safeUserCommand(result.verificationCommand, 'verification command');
  safeUserCommand(result.nextStepCommand, 'next-step command');
  assert(
    result.response.includes(result.verificationCommand) &&
      result.response.includes(result.nextStepCommand),
    'response omitted a declared user-visible command',
  );
  assert(
    result.response.includes(LOCAL_QUALIFICATION_SCOPE_STATEMENT),
    'qualification boundary was not user-visible',
  );
  const nextStepSafetyClass = result.nextStepCommand.includes('open-plan')
    ? 'preview-safe'
    : 'read-only';
  return {
    intentId: receipt.intentId,
    personalizationBasis: [result.personalizationBasis],
    personalizationExplanationRoot: bytesRoot(Buffer.from(result.response)),
    receiptCitationRoot: bytesRoot(Buffer.from(receipt.receiptRoot)),
    verificationCommand: result.verificationCommand,
    verificationExpectedRoot: receipt.outcome.verificationRoot,
    nextStepCommand: result.nextStepCommand,
    nextStepSafetyClass,
    nextStepReasonRoot: bytesRoot(Buffer.from(result.response)),
    scopeStatementRoot: bytesRoot(
      Buffer.from(LOCAL_QUALIFICATION_SCOPE_STATEMENT),
    ),
    nonClaims: [...REQUIRED_NON_CLAIMS].sort(),
  };
}

export function experienceResultFromResponse(response, receipt) {
  assert(
    typeof response === 'string' && response.length >= 80,
    'Codex final response was not a substantive user-visible answer',
  );
  assert(
    response.includes(receipt.agentResponseGuide.personalizationLabel),
    'Codex response omitted the receipt-selected personalization label',
  );
  assert(
    response.includes(VERIFICATION_COMMAND),
    'Codex response omitted the exact verification command',
  );
  const nextStepMatches = NEXT_STEP_COMMANDS.filter((command) =>
    response.includes(command),
  );
  assert(
    nextStepMatches.length === 1,
    `Codex response named ${nextStepMatches.length} safe next steps instead of exactly one`,
  );
  const expectedResponse = receipt.agentResponseGuide.answerTemplate.replace(
    '{receiptRoot}',
    receipt.receiptRoot,
  );
  assert(
    response.trim() === expectedResponse,
    'Codex final response did not exactly render the product answer template',
  );
  return {
    response,
    personalizationBasis: receipt.agentResponseGuide.personalizationBasis,
    verificationCommand: VERIFICATION_COMMAND,
    nextStepCommand: nextStepMatches[0],
  };
}

function declaredPromptEntries(contract) {
  return [
    { id: 'canonical', ...contract.prompt },
    ...(contract.promptFamily?.variants || []),
  ];
}

function validatePromptFamily(contract) {
  const entries = declaredPromptEntries(contract);
  const policy = contract.promptFamily?.naturalLanguagePolicy || {};
  assert(entries.length >= 2, 'prompt family omitted natural variants');
  assert(
    contract.promptFamily?.canonicalRoot === contract.prompt?.root,
    'prompt family canonical root mismatch',
  );
  const roots = new Set();
  for (const entry of entries) {
    assert(
      bytesRoot(Buffer.from(entry.text || '')) === entry.root,
      `prompt ${entry.id} root mismatch`,
    );
    assert(!roots.has(entry.root), `prompt ${entry.id} reused a root`);
    roots.add(entry.root);
    assert(
      !policy.requiredPhrase || entry.text.includes(policy.requiredPhrase),
      `prompt ${entry.id} omitted the natural entry phrase`,
    );
    for (const hint of policy.forbiddenProtocolHints || [])
      assert(
        !entry.text.includes(hint),
        `prompt ${entry.id} contains protocol hint ${hint}`,
      );
  }
  return entries;
}

export function verifyAgentFirstValueQualification(report) {
  assert(
    report?.schema === QUALIFICATION_SCHEMA,
    'unexpected qualification schema',
  );
  assert(report.qualified === true, 'local Codex qualification did not pass');
  assert(
    report.provider?.surface === 'codex-cli',
    'qualification provider mismatch',
  );
  assert(
    report.provider?.executionMode === 'codex-exec-ephemeral',
    'Codex was not ephemeral',
  );
  assert(
    report.provider?.model === QUALIFICATION_MODEL,
    'Codex qualification model mismatch',
  );
  assert(
    report.provider?.contextIsolation === QUALIFICATION_CONTEXT_ISOLATION,
    'Codex qualification context isolation mismatch',
  );
  assert(
    report.provider?.reasoningEffort === QUALIFICATION_REASONING_EFFORT,
    'Codex qualification reasoning effort mismatch',
  );
  assert(
    report.platform?.system === 'darwin',
    'qualification is not macOS-local',
  );
  assert(
    report.trialCount === REQUIRED_TRIALS &&
      report.trials?.length === REQUIRED_TRIALS,
    `exactly ${REQUIRED_TRIALS} trials are required`,
  );
  assert(
    report.canonicalTrialCount >= MINIMUM_CANONICAL_TRIALS,
    `at least ${MINIMUM_CANONICAL_TRIALS} canonical trials are required`,
  );
  assert(
    report.promptCoverage?.every((entry) => entry.count >= entry.requiredCount),
    'prompt-family coverage is incomplete',
  );
  assert(
    JSON.stringify(report.experienceDimensions) ===
      JSON.stringify(EXPERIENCE_DIMENSIONS),
    'experience dimension contract drifted',
  );
  assert(
    report.rawTranscriptRetained === false,
    'raw transcript retention is forbidden',
  );
  assert(
    report.ciDependency === false,
    'qualification incorrectly requires Codex in CI',
  );
  assert(
    REVISION_PATTERN.test(report.candidate?.sourceRevision || ''),
    'source revision is invalid',
  );
  assert(
    ROOT_PATTERN.test(report.candidate?.executableRoot || ''),
    'candidate executable root is invalid',
  );
  assert(
    ROOT_PATTERN.test(report.candidate?.providerSkillRoot || ''),
    'candidate provider Skill root is invalid',
  );
  const ids = new Set();
  const workspaces = new Set();
  const promptCounts = new Map();
  for (const trial of report.trials) {
    assert(trial.verified === true, 'a local Codex trial is not verified');
    assert(
      !ids.has(trial.attemptId),
      'Codex trial attempt ids are not independent',
    );
    assert(
      !workspaces.has(trial.workspaceRoot),
      'Codex trial workspaces are not independent',
    );
    ids.add(trial.attemptId);
    workspaces.add(trial.workspaceRoot);
    promptCounts.set(
      trial.promptRoot,
      (promptCounts.get(trial.promptRoot) || 0) + 1,
    );
    assert(
      trial.questionMarkCount === trial.receipt.questionCount,
      'question count was not independently checked',
    );
    assert(
      ROOT_PATTERN.test(trial.eventStreamRoot || ''),
      'trial omitted event stream root',
    );
    assert(
      ROOT_PATTERN.test(trial.responseRoot || ''),
      'trial omitted response root',
    );
    assert(
      trial.providerSkill?.target === 'codex' &&
        trial.providerSkill?.scope === 'project' &&
        trial.providerSkill?.root === report.candidate.providerSkillRoot,
      'trial was not bound to the candidate Codex Skill',
    );
    assert(
      Object.keys(trial.protocolEvidence || {})
        .sort()
        .join(',') === 'brief,first-value-start,provider-skill',
      'trial omitted autonomous protocol evidence',
    );
    for (const evidence of Object.values(trial.protocolEvidence)) {
      assert(
        ROOT_PATTERN.test(evidence.commandRoot || '') &&
          ROOT_PATTERN.test(evidence.outputRoot || ''),
        'trial protocol evidence roots are invalid',
      );
    }
    assert(
      trial.experience?.intentId === trial.receipt.intentId &&
        trial.experience?.personalizationBasis?.length >= 1 &&
        ROOT_PATTERN.test(trial.experience?.receiptCitationRoot || '') &&
        ROOT_PATTERN.test(trial.experience?.scopeStatementRoot || ''),
      'trial omitted normalized personalized experience facts',
    );
    safeUserCommand(
      trial.experience?.verificationCommand,
      'verification command',
    );
    safeUserCommand(trial.experience?.nextStepCommand, 'next-step command');
    assert(
      ROOT_PATTERN.test(trial.experience?.independentVerificationRoot || ''),
      'trial omitted independent candidate verification',
    );
    verifyFirstValueReceipt(trial.receipt, {
      promptRoot: trial.promptRoot,
      attemptId: trial.attemptId,
      candidateRoot: report.candidate.productCandidateRoot,
      sourceRevision: report.candidate.sourceRevision,
    });
  }
  for (const coverage of report.promptCoverage) {
    assert(
      promptCounts.get(coverage.root) === coverage.count,
      `prompt coverage count drifted for ${coverage.id}`,
    );
  }
  for (const nonClaim of REQUIRED_NON_CLAIMS)
    assert(
      report.nonClaims?.includes(nonClaim),
      `qualification omitted non-claim ${nonClaim}`,
    );
  const { qualificationRoot, ...subject } = report;
  assert(
    qualificationRoot === semanticRoot(subject),
    'qualification semantic root mismatch',
  );
  return {
    schema: 'kungfu.agent-first-value-local-codex-verification/v1',
    verified: true,
    qualificationRoot,
    trialReceiptRoots: report.trials.map((trial) => trial.receipt.receiptRoot),
  };
}

function args(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!['--kungfu', '--source-revision', '--out', '--codex'].includes(arg))
      throw new Error(`unknown option: ${arg}`);
    index += 1;
    if (index >= argv.length) throw new Error(`${arg} requires a value`);
    options[arg.slice(2)] = argv[index];
  }
  for (const key of ['kungfu', 'source-revision', 'out'])
    if (!options[key]) throw new Error(`--${key} is required`);
  return options;
}

function run(argv) {
  if (argv[0] === '--verify-report') {
    assert(argv.length === 2, '--verify-report requires exactly one path');
    const reportPath = path.resolve(argv[1]);
    const report = parseJson(
      fs.readFileSync(reportPath, 'utf8'),
      'first-value qualification report',
    );
    process.stdout.write(
      `${JSON.stringify(verifyAgentFirstValueQualification(report), null, 2)}\n`,
    );
    return;
  }
  const options = args(argv);
  const kungfu = fs.realpathSync(options.kungfu);
  const liveCli = fs.existsSync('/usr/local/bin/kungfu')
    ? fs.realpathSync('/usr/local/bin/kungfu')
    : null;
  assert(
    kungfu !== liveCli,
    'refusing to qualify the live /usr/local Kungfu CLI',
  );
  assert(
    !kungfu.startsWith('/Applications/'),
    'refusing to qualify the live application',
  );
  assert(
    REVISION_PATTERN.test(options['source-revision']),
    'invalid source revision',
  );
  assert(
    process.env.CODEX_HOME,
    'CODEX_HOME must be set without reading or copying credentials',
  );

  const codex = options.codex || 'codex';
  const codexVersion = successful(
    spawnSync(codex, ['--version'], { encoding: 'utf8' }),
    'codex --version',
  ).stdout.trim();
  const probeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-first-value-probe-'),
  );
  const probeHome = path.join(probeRoot, 'home');
  const isolatedCodexHome = installIsolatedCodexHome(
    process.env.CODEX_HOME,
    path.join(probeRoot, 'codex-home'),
  );
  fs.mkdirSync(probeHome, { recursive: true });
  installCandidateShellRouter(probeHome);
  const baseEnv = {
    ...process.env,
    CODEX_HOME: isolatedCodexHome,
    HOME: probeHome,
    XDG_CONFIG_HOME: path.join(probeHome, '.config'),
    KF_CONFIG_HOME: path.join(probeHome, '.config', 'kungfu'),
    KUNGFU_CLI_BIN: kungfu,
    KUNGFU_FIRST_VALUE_SOURCE_REVISION: options['source-revision'],
    PATH: `${path.dirname(kungfu)}:${process.env.PATH || '/usr/bin:/bin'}`,
    ZDOTDIR: probeHome,
    NO_COLOR: '1',
  };

  try {
    const contract = parseJson(
      successful(
        spawnSync(kungfu, ['agent', 'first-value', 'contract', '--json'], {
          encoding: 'utf8',
          env: baseEnv,
        }),
        'candidate first-value contract',
      ).stdout,
      'candidate first-value contract',
    );
    const prompt = contract.contract?.prompt?.text;
    const promptRoot = contract.contract?.prompt?.root;
    assert(
      prompt && ROOT_PATTERN.test(promptRoot || ''),
      'candidate contract omitted prompt identity',
    );
    assert(
      contract.contract?.qualification?.requiredLocalCodexTrials ===
        REQUIRED_TRIALS,
      'candidate contract trial count drifted',
    );
    assert(
      contract.contract?.qualification?.minimumCanonicalPromptTrials ===
        MINIMUM_CANONICAL_TRIALS,
      'candidate canonical prompt threshold drifted',
    );
    assert(
      contract.contract?.qualification?.localCodexProfile?.reasoningEffort ===
        QUALIFICATION_REASONING_EFFORT &&
        contract.contract?.qualification?.localCodexProfile?.model ===
          QUALIFICATION_MODEL &&
        contract.contract?.qualification?.localCodexProfile
          ?.contextIsolation === QUALIFICATION_CONTEXT_ISOLATION &&
        contract.contract?.qualification?.localCodexProfile?.executionMode ===
          'codex-exec-ephemeral' &&
        contract.contract?.qualification?.localCodexProfile
          ?.providerSkillScope === PROVIDER_SKILL_SCOPE &&
        contract.contract?.qualification?.localCodexProfile?.userConfig ===
          'ignored',
      'candidate local Codex profile drifted',
    );
    assert(
      contract.productIdentity?.sourceRevision === options['source-revision'],
      'candidate intrinsic source revision does not match --source-revision',
    );
    assert(
      ROOT_PATTERN.test(contract.productIdentity?.candidateRoot || ''),
      'candidate contract omitted candidate identity',
    );
    const promptEntries = validatePromptFamily(contract.contract);
    const canonical = promptEntries[0];
    const variants = promptEntries.slice(1);
    assert(
      MINIMUM_CANONICAL_TRIALS + variants.length === REQUIRED_TRIALS,
      'prompt family cannot satisfy the exact trial matrix',
    );
    const trialPrompts = [
      ...Array.from({ length: MINIMUM_CANONICAL_TRIALS }, () => canonical),
      ...variants,
    ];

    const trials = [];
    for (let number = 1; number <= REQUIRED_TRIALS; number += 1) {
      const promptEntry = trialPrompts[number - 1];
      const attemptId = `codex-local-${number}-${crypto.randomUUID()}`;
      const trialRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), `kungfu-first-value-${number}-`),
      );
      const trialHome = path.join(trialRoot, 'home');
      const workspace = path.join(trialRoot, 'workspace');
      fs.mkdirSync(trialHome, { recursive: true });
      fs.mkdirSync(workspace, { recursive: true });
      installCandidateShellRouter(trialHome);
      const env = {
        ...baseEnv,
        HOME: trialHome,
        XDG_CONFIG_HOME: path.join(trialHome, '.config'),
        KF_CONFIG_HOME: path.join(trialHome, '.config', 'kungfu'),
        ZDOTDIR: trialHome,
        KUNGFU_FIRST_VALUE_ATTEMPT_ID: attemptId,
        KUNGFU_FIRST_VALUE_PROMPT_ROOT: promptEntry.root,
      };
      const providerSkill = installCandidateCodexSkill(kungfu, workspace, env);
      process.stderr.write(
        `[agent-first-value] Codex trial ${number}/${REQUIRED_TRIALS} (${promptEntry.id})\n`,
      );
      try {
        const execution = successful(
          spawnSync(
            codex,
            [
              'exec',
              '--ephemeral',
              '--ignore-user-config',
              '--model',
              QUALIFICATION_MODEL,
              '--config',
              `model_reasoning_effort="${QUALIFICATION_REASONING_EFFORT}"`,
              '--sandbox',
              'read-only',
              '--skip-git-repo-check',
              '--color',
              'never',
              '--json',
              '--cd',
              workspace,
              promptEntry.text,
            ],
            {
              encoding: 'utf8',
              env,
              maxBuffer: 32 * 1024 * 1024,
              timeout: 10 * 60 * 1000,
            },
          ),
          `Codex trial ${number}`,
        );
        const finalText = finalAgentMessage(execution.stdout);
        const receipts = receiptsFromCodexEventStream(execution.stdout);
        assert(
          receipts.length === 1,
          `Codex trial ${number} emitted ${receipts.length} CLI receipts instead of exactly one; event inventory: ${codexEventInventory(execution.stdout)}`,
        );
        const [receipt] = receipts;
        verifyFirstValueReceipt(receipt, {
          promptRoot: promptEntry.root,
          attemptId,
          candidateRoot: contract.productIdentity.candidateRoot,
          sourceRevision: options['source-revision'],
        });
        const result = experienceResultFromResponse(finalText, receipt);
        const questionMarkCount = [...result.response].filter(
          (character) => character === '?' || character === '？',
        ).length;
        assert(
          questionMarkCount <= 1,
          `Codex trial ${number} asked more than one question`,
        );
        assert(
          questionMarkCount === receipt.questionCount,
          `Codex trial ${number} declared a different question count`,
        );
        const protocolEvidence = protocolEvidenceFromCodexEventStream(
          execution.stdout,
          promptEntry.root,
          providerSkill.root,
        );
        const experience = normalizedExperienceFromResult(result, receipt);
        const receiptPath = path.join(trialRoot, 'receipt.json');
        fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
        const verification = parseJson(
          successful(
            spawnSync(
              kungfu,
              ['agent', 'first-value', 'verify', receiptPath, '--json'],
              { encoding: 'utf8', env },
            ),
            `candidate receipt verification ${number}`,
          ).stdout,
          `candidate receipt verification ${number}`,
        );
        assert(
          verification.verified === true,
          `candidate rejected trial ${number}`,
        );
        trials.push({
          attemptId,
          verified: true,
          promptId: promptEntry.id,
          promptRoot: promptEntry.root,
          workspaceRoot: bytesRoot(Buffer.from(workspace)),
          eventStreamRoot: bytesRoot(Buffer.from(execution.stdout)),
          responseRoot: bytesRoot(Buffer.from(result.response)),
          questionMarkCount,
          providerSkill,
          protocolEvidence,
          receipt,
          verificationRoot: semanticRoot(verification),
          experience: {
            ...experience,
            independentVerificationRoot: semanticRoot(verification),
          },
        });
        process.stderr.write(
          `[agent-first-value] Codex trial ${number}/${REQUIRED_TRIALS} passed\n`,
        );
      } finally {
        fs.rmSync(trialRoot, { recursive: true, force: true });
      }
    }

    const report = {
      schema: QUALIFICATION_SCHEMA,
      qualified: true,
      provider: {
        surface: 'codex-cli',
        version: codexVersion,
        executionMode: 'codex-exec-ephemeral',
        contextIsolation: QUALIFICATION_CONTEXT_ISOLATION,
        model: QUALIFICATION_MODEL,
        reasoningEffort: QUALIFICATION_REASONING_EFFORT,
      },
      platform: { system: process.platform, arch: process.arch },
      candidate: {
        executableRoot: bytesRoot(fs.readFileSync(kungfu)),
        sourceRevision: options['source-revision'],
        productCandidateRoot: contract.productIdentity.candidateRoot,
        providerSkillRoot: trials[0].providerSkill.root,
      },
      promptRoot,
      promptCoverage: promptEntries.map((entry, index) => ({
        id: entry.id,
        root: entry.root,
        requiredCount: index === 0 ? MINIMUM_CANONICAL_TRIALS : 1,
        count: trials.filter((trial) => trial.promptRoot === entry.root).length,
      })),
      canonicalTrialCount: trials.filter(
        (trial) => trial.promptRoot === promptRoot,
      ).length,
      experienceDimensions: EXPERIENCE_DIMENSIONS,
      trialCount: REQUIRED_TRIALS,
      trials,
      rawTranscriptRetained: false,
      ciDependency: false,
      nonClaims: contract.contract.qualification.nonClaims,
      observedAt: new Date().toISOString(),
    };
    report.qualificationRoot = semanticRoot(report);
    verifyAgentFirstValueQualification(report);
    const output = path.resolve(options.out);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({ qualified: true, qualificationRoot: report.qualificationRoot, output }, null, 2)}\n`,
    );
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[agent-first-value] ${error.message}\n`);
    process.exitCode = 1;
  }
}
