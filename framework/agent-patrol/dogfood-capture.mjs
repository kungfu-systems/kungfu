#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const CLASSIFICATION_SCHEMA = 'kungfu.agent-patrol.classification/v1';
const FINDING_INTENT_SCHEMA = 'kungfu.agent-patrol.finding-intent/v1';
const RECEIPT_SCHEMA = 'kungfu.agent-patrol.dogfood-capture-receipt/v1';
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function outputRoot(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex')}`;
}

function sourceCli(args, options = {}) {
  const pythonPath = [
    path.join(ROOT, 'framework/core/src/python'),
    path.join(ROOT, 'framework/core/build/Release'),
    process.env.PYTHONPATH,
  ]
    .filter(Boolean)
    .join(path.delimiter);
  return spawnSync(
    'uv',
    [
      'run',
      '--project',
      path.join(ROOT, 'framework/core'),
      '--frozen',
      'python',
      '-m',
      'kungfu',
      ...args,
    ],
    {
      cwd: ROOT,
      env: { ...process.env, ...(options.env || {}), PYTHONPATH: pythonPath },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: options.timeout || 120_000,
    },
  );
}

function parseJsonOutput(result, operation) {
  if (result.error) throw result.error;
  try {
    return JSON.parse(result.stdout || '');
  } catch {
    throw new Error(
      `${operation} returned non-JSON output; output root ${outputRoot(
        `${result.stdout || ''}\n${result.stderr || ''}`,
      )}`,
    );
  }
}

function validateClassification(value) {
  if (value?.schema !== CLASSIFICATION_SCHEMA)
    throw new Error('Patrol classification schema is unsupported');
  if (value.issueAdmission !== 'prohibited')
    throw new Error('Patrol classification must prohibit Issue admission');
  if (typeof value.captureRequired !== 'boolean')
    throw new Error('Patrol captureRequired must be boolean');
  if (!value.captureRequired) return;
  const intent = value.findingIntent;
  if (
    intent?.schema !== FINDING_INTENT_SCHEMA ||
    intent.findingId !== intent.capture?.findingId
  )
    throw new Error('Patrol Finding intent is invalid');
  if (!ROOT_PATTERN.test(intent.fingerprintRoot || ''))
    throw new Error('Patrol Finding fingerprint root is invalid');
  for (const forbidden of [
    'issueId',
    'owner',
    'findingRoots',
    'verificationCriteria',
  ])
    if (Object.hasOwn(intent.capture, forbidden))
      throw new Error(
        `Patrol Finding intent contains forbidden field ${forbidden}`,
      );
}

function boundedReceipt({
  status,
  findingId = null,
  findingRoot = null,
  lookupRoot = null,
  nativeStatus = null,
  capturePerformed = false,
}) {
  return {
    schema: RECEIPT_SCHEMA,
    status,
    findingId,
    findingRoot,
    lookupRoot,
    nativeStatus,
    capturePerformed,
    issueAdmitted: false,
  };
}

function ensureDogfoodProfile(run, workspaceRoot) {
  const doctorArgs = ['dogfood', 'doctor', '--workspace', workspaceRoot];
  const diagnosisResult = run(doctorArgs);
  const diagnosis = parseJsonOutput(diagnosisResult, 'dogfood doctor');
  if (diagnosisResult.status !== 0)
    throw new Error('dogfood doctor failed closed');
  if (diagnosis.ok === true) return;

  const planResult = run(['dogfood', 'recover', '--workspace', workspaceRoot]);
  const plan = parseJsonOutput(planResult, 'dogfood recover plan');
  if (
    planResult.status !== 0 ||
    !['ready', 'no-op'].includes(plan.status) ||
    !ROOT_PATTERN.test(plan.plan_root || '')
  )
    throw new Error('dogfood recovery plan failed closed');
  if (plan.status === 'ready') {
    const applyResult = run([
      'dogfood',
      'recover',
      '--workspace',
      workspaceRoot,
      '--expected-plan-root',
      plan.plan_root,
      '--execute',
      '--authorized-by',
      'agent-patrol-agent-121',
    ]);
    const applied = parseJsonOutput(applyResult, 'dogfood recover apply');
    if (
      applyResult.status !== 0 ||
      !['recovered', 'already-current'].includes(applied.status)
    )
      throw new Error('dogfood recovery apply failed closed');
  }
  const verifiedResult = run(doctorArgs);
  const verified = parseJsonOutput(verifiedResult, 'dogfood doctor verify');
  if (verifiedResult.status !== 0 || verified.ok !== true)
    throw new Error('Dogfood Profile did not reach its exact active root');
}

export function captureFinding(
  classification,
  { run = sourceCli, intentPath, workspaceRoot },
) {
  validateClassification(classification);
  if (!classification.captureRequired)
    return boundedReceipt({ status: 'not-required' });
  if (!path.isAbsolute(workspaceRoot || ''))
    throw new Error('Patrol Dogfood workspace must be an absolute path');

  const findingId = classification.findingIntent.findingId;
  const ensured = run([
    'workspace',
    'ensure',
    workspaceRoot,
    '--reason',
    'agent-patrol-dogfood-finding',
    '--json',
  ]);
  if (ensured.error || ensured.status !== 0)
    throw new Error(
      `Kungfu Home ensure failed; output root ${outputRoot(
        `${ensured.stdout || ''}\n${ensured.stderr || ''}`,
      )}`,
    );

  ensureDogfoodProfile(run, workspaceRoot);
  const lookupResult = run([
    'dogfood',
    'show',
    findingId,
    '--workspace',
    workspaceRoot,
  ]);
  const lookup = parseJsonOutput(lookupResult, 'dogfood show');
  if (lookupResult.status === 0) {
    const finding = lookup.matches?.[0]?.record;
    if (
      lookup.ok !== true ||
      lookup.match_count !== 1 ||
      lookup.matches?.[0]?.kind !== 'finding' ||
      finding?.finding_id !== findingId ||
      !ROOT_PATTERN.test(finding?.finding_root || '')
    )
      throw new Error('dogfood show did not resolve one exact Finding');
    return boundedReceipt({
      status: 'deduplicated',
      findingId,
      findingRoot: finding.finding_root,
      lookupRoot: lookup.lookup_root,
      nativeStatus: 'already-present',
      capturePerformed: false,
    });
  }
  if (
    lookupResult.status !== 3 ||
    lookup.ok !== false ||
    lookup.match_count !== 0
  )
    throw new Error(
      `dogfood show failed closed; output root ${outputRoot(
        `${lookupResult.stdout || ''}\n${lookupResult.stderr || ''}`,
      )}`,
    );

  fs.mkdirSync(path.dirname(path.resolve(intentPath)), { recursive: true });
  fs.writeFileSync(
    intentPath,
    `${JSON.stringify(classification.findingIntent.capture, null, 2)}\n`,
  );
  const captureResult = run([
    'dogfood',
    'capture',
    intentPath,
    '--workspace',
    workspaceRoot,
    '--authorized-by',
    'agent-patrol-agent-121',
  ]);
  const captured = parseJsonOutput(captureResult, 'dogfood capture');
  if (
    captureResult.status !== 0 ||
    !['captured', 'already-present'].includes(captured.status) ||
    captured.finding?.finding_id !== findingId ||
    !ROOT_PATTERN.test(captured.finding?.finding_root || '')
  )
    throw new Error(
      `dogfood capture failed closed; output root ${outputRoot(
        `${captureResult.stdout || ''}\n${captureResult.stderr || ''}`,
      )}`,
    );
  return boundedReceipt({
    status: captured.status === 'captured' ? 'captured' : 'deduplicated',
    findingId,
    findingRoot: captured.finding.finding_root,
    nativeStatus: captured.status,
    capturePerformed: captured.status === 'captured',
  });
}

function parseArgs(argv) {
  const result = {
    classification: '',
    output: '',
    intent: '',
    workspace: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--classification') result.classification = argv[++index] || '';
    else if (arg === '--output') result.output = argv[++index] || '';
    else if (arg === '--intent') result.intent = argv[++index] || '';
    else if (arg === '--workspace') result.workspace = argv[++index] || '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const field of Object.keys(result))
    if (!result[field]) throw new Error(`--${field} is required`);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const classification = JSON.parse(
      fs.readFileSync(options.classification, 'utf8'),
    );
    const receipt = captureFinding(classification, {
      intentPath: options.intent,
      workspaceRoot: path.resolve(options.workspace),
    });
    fs.mkdirSync(path.dirname(path.resolve(options.output)), {
      recursive: true,
    });
    fs.writeFileSync(options.output, `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({
        status: receipt.status,
        findingId: receipt.findingId,
        findingRoot: receipt.findingRoot,
        issueAdmitted: false,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 2;
  }
}
