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
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function outputRoot(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex')}`;
}

export function nativeDogfoodCli(args, options = {}) {
  const installedCommand = process.env.KUNGFU_DOGFOOD_COMMAND;
  if (installedCommand) {
    return spawnSync(installedCommand, args, {
      cwd: ROOT,
      env: { ...process.env, ...(options.env || {}) },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: options.timeout || 120_000,
    });
  }
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

function validateIntent(intent) {
  if (
    !intent ||
    typeof intent !== 'object' ||
    typeof intent.findingId !== 'string' ||
    intent.findingId !== intent.capture?.findingId ||
    !ROOT_PATTERN.test(intent.fingerprintRoot || '')
  )
    throw new Error('native Finding intent is invalid');
  for (const forbidden of [
    'issueId',
    'owner',
    'findingRoots',
    'verificationCriteria',
  ])
    if (Object.hasOwn(intent.capture, forbidden))
      throw new Error(
        `native Finding intent contains forbidden field ${forbidden}`,
      );
}

function ensureDogfoodProfile(run, workspaceRoot, authorizedBy) {
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
      authorizedBy,
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

export function captureNativeFinding(
  intent,
  { run = nativeDogfoodCli, intentPath, workspaceRoot, authorizedBy, reason },
) {
  validateIntent(intent);
  if (!path.isAbsolute(workspaceRoot || ''))
    throw new Error('native Dogfood workspace must be an absolute path');
  if (!authorizedBy || !reason)
    throw new Error('native Dogfood authorization and reason are required');

  const findingId = intent.findingId;
  const ensured = run([
    'workspace',
    'ensure',
    workspaceRoot,
    '--reason',
    reason,
    '--json',
  ]);
  if (ensured.error || ensured.status !== 0)
    throw new Error(
      `Kungfu Home ensure failed; output root ${outputRoot(
        `${ensured.stdout || ''}\n${ensured.stderr || ''}`,
      )}`,
    );

  ensureDogfoodProfile(run, workspaceRoot, authorizedBy);
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
    return {
      status: 'deduplicated',
      findingId,
      findingRoot: finding.finding_root,
      lookupRoot: lookup.lookup_root,
      nativeStatus: 'already-present',
      capturePerformed: false,
      issueAdmitted: false,
    };
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
  fs.writeFileSync(intentPath, `${JSON.stringify(intent.capture, null, 2)}\n`);
  const captureResult = run([
    'dogfood',
    'capture',
    intentPath,
    '--workspace',
    workspaceRoot,
    '--authorized-by',
    authorizedBy,
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
  return {
    status: captured.status === 'captured' ? 'captured' : 'deduplicated',
    findingId,
    findingRoot: captured.finding.finding_root,
    lookupRoot: null,
    nativeStatus: captured.status,
    capturePerformed: captured.status === 'captured',
    issueAdmitted: false,
  };
}
