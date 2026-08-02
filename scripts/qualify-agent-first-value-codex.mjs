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
  'kungfu.agent-first-value-local-codex-qualification/v1';

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

export function codexResultSchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['response'],
    properties: {
      response: { type: 'string', minLength: 40 },
    },
  };
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

function codexEventInventory(jsonl) {
  const inventory = new Set();
  for (const line of String(jsonl).split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      inventory.add(
        [
          event?.type || 'unknown-event',
          event?.item?.type || 'no-item',
          Object.keys(event?.item || {})
            .sort()
            .join(','),
          event?.item?.type === 'command_execution'
            ? `receipt-command=${String(event.item.command || '').includes('first-value receipt')}`
            : '',
          event?.item?.type === 'command_execution'
            ? `receipt-output=${String(event.item.aggregated_output || '').includes(RECEIPT_SCHEMA)}`
            : '',
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
    report.platform?.system === 'darwin',
    'qualification is not macOS-local',
  );
  assert(
    report.trialCount === 3 && report.trials?.length === 3,
    'exactly three trials are required',
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
  const ids = new Set();
  const workspaces = new Set();
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
    verifyFirstValueReceipt(trial.receipt, {
      promptRoot: report.promptRoot,
      attemptId: trial.attemptId,
      candidateRoot: report.candidate.productCandidateRoot,
      sourceRevision: report.candidate.sourceRevision,
    });
  }
  for (const nonClaim of [
    'claude-qualified',
    'ci-hosted-codex-qualified',
    'other-platforms-qualified',
    'public-release-qualified',
  ])
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
  fs.mkdirSync(probeHome, { recursive: true });
  const baseEnv = {
    ...process.env,
    HOME: probeHome,
    XDG_CONFIG_HOME: path.join(probeHome, '.config'),
    KF_CONFIG_HOME: path.join(probeHome, '.config', 'kungfu'),
    KUNGFU_CLI_BIN: kungfu,
    KUNGFU_FIRST_VALUE_SOURCE_REVISION: options['source-revision'],
    PATH: `${path.dirname(kungfu)}:${process.env.PATH || '/usr/bin:/bin'}`,
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
      contract.contract?.qualification?.requiredLocalCodexTrials === 3,
      'candidate contract trial count drifted',
    );
    assert(
      contract.productIdentity?.sourceRevision === options['source-revision'],
      'candidate intrinsic source revision does not match --source-revision',
    );
    assert(
      ROOT_PATTERN.test(contract.productIdentity?.candidateRoot || ''),
      'candidate contract omitted candidate identity',
    );
    const resultSchema = codexResultSchema();

    const trials = [];
    for (let number = 1; number <= 3; number += 1) {
      const attemptId = `codex-local-${number}-${crypto.randomUUID()}`;
      const trialRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), `kungfu-first-value-${number}-`),
      );
      const trialHome = path.join(trialRoot, 'home');
      const workspace = path.join(trialRoot, 'workspace');
      const schemaPath = path.join(trialRoot, 'result.schema.json');
      fs.mkdirSync(trialHome, { recursive: true });
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(schemaPath, `${JSON.stringify(resultSchema)}\n`);
      const env = {
        ...baseEnv,
        HOME: trialHome,
        XDG_CONFIG_HOME: path.join(trialHome, '.config'),
        KF_CONFIG_HOME: path.join(trialHome, '.config', 'kungfu'),
        KUNGFU_FIRST_VALUE_ATTEMPT_ID: attemptId,
      };
      process.stderr.write(`[agent-first-value] Codex trial ${number}/3\n`);
      try {
        const execution = successful(
          spawnSync(
            codex,
            [
              'exec',
              '--ephemeral',
              '--ignore-user-config',
              '--sandbox',
              'read-only',
              '--skip-git-repo-check',
              '--color',
              'never',
              '--json',
              '--output-schema',
              schemaPath,
              '--cd',
              workspace,
              prompt,
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
        const result = parseJson(
          finalText,
          `Codex trial ${number} final response`,
        );
        assert(
          result.response.includes('Kungfu'),
          `Codex trial ${number} response omitted Kungfu`,
        );
        const questionMarkCount = [...result.response].filter(
          (character) => character === '?' || character === '？',
        ).length;
        assert(
          questionMarkCount <= 1,
          `Codex trial ${number} asked more than one question`,
        );
        const receipts = receiptsFromCodexEventStream(execution.stdout);
        assert(
          receipts.length === 1,
          `Codex trial ${number} emitted ${receipts.length} CLI receipts instead of exactly one; event inventory: ${codexEventInventory(execution.stdout)}`,
        );
        const [receipt] = receipts;
        verifyFirstValueReceipt(receipt, {
          promptRoot,
          attemptId,
          candidateRoot: contract.productIdentity.candidateRoot,
          sourceRevision: options['source-revision'],
        });
        assert(
          result.response.includes(receipt.receiptRoot),
          `Codex trial ${number} response omitted the CLI receipt root`,
        );
        assert(
          questionMarkCount === receipt.questionCount,
          `Codex trial ${number} declared a different question count`,
        );
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
          workspaceRoot: bytesRoot(Buffer.from(workspace)),
          eventStreamRoot: bytesRoot(Buffer.from(execution.stdout)),
          responseRoot: bytesRoot(Buffer.from(result.response)),
          questionMarkCount,
          receipt,
          verificationRoot: semanticRoot(verification),
        });
        process.stderr.write(
          `[agent-first-value] Codex trial ${number}/3 passed\n`,
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
      },
      platform: { system: process.platform, arch: process.arch },
      candidate: {
        executableRoot: bytesRoot(fs.readFileSync(kungfu)),
        sourceRevision: options['source-revision'],
        productCandidateRoot: contract.productIdentity.candidateRoot,
      },
      promptRoot,
      trialCount: 3,
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
