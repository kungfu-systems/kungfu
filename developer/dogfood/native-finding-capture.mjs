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

function fileRoot(file) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex')}`;
}

function inspectSourceCheckout() {
  const buildInfoPath = path.join(
    ROOT,
    'framework/core/dist/kungfu/kungfubuildinfo.json',
  );
  const shifuPath = path.join(ROOT, 'shifu');
  if (!fs.existsSync(buildInfoPath) || !fs.existsSync(shifuPath))
    throw new Error(
      'source Dogfood capture requires the exact checkout build; run ./shifu build:core',
    );
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    if (result.status !== 0)
      throw new Error(`cannot resolve source provenance: ${result.stderr}`);
    return String(result.stdout || '').trim();
  };
  return {
    buildInfo: JSON.parse(fs.readFileSync(buildInfoPath, 'utf8')),
    buildInfoRoot: fileRoot(buildInfoPath),
    shifuPath,
    shifuRoot: fileRoot(shifuPath),
    head: git(['rev-parse', 'HEAD']),
    tree: git(['rev-parse', 'HEAD^{tree}']),
    dirty: git(['status', '--porcelain', '--untracked-files=no']) !== '',
    worktree: ROOT,
  };
}

function verifyRuntimeReceipt(receipt, run, intentPath) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt))
    throw new Error('Dogfood capture requires the full runtimeReceipt object');
  const receiptPath = `${path.resolve(intentPath)}.runtime-surface-receipt.json`;
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const result = run(['runtime', 'surface', 'verify', receiptPath, '--json']);
  const verification = parseJsonOutput(result, 'runtime surface verify');
  if (
    result.status !== 0 ||
    verification.schema !== 'kungfu.runtime-surface-verification/v1' ||
    verification.ok !== true ||
    verification.receiptRoot !== receipt.receiptRoot ||
    verification.operationId !== 'dogfood.capture' ||
    verification.runtimeSurface !== receipt.runtimeSurface ||
    verification.selectedProvider !== receipt.selectedProvider
  )
    throw new Error(
      'Dogfood runtime surface receipt verification failed closed',
    );
  return verification;
}

function bindRuntimeReceipt(
  intent,
  run,
  intentPath,
  inspectSource = inspectSourceCheckout,
) {
  if (
    intent.capture?.runtimeSurface &&
    ROOT_PATTERN.test(intent.capture?.runtimeReceiptRoot || '')
  ) {
    const receipt = intent.runtimeReceipt;
    const verification = verifyRuntimeReceipt(receipt, run, intentPath);
    if (
      receipt.operationId !== 'dogfood.capture' ||
      receipt.runtimeSurface !== intent.capture.runtimeSurface ||
      receipt.receiptRoot !== intent.capture.runtimeReceiptRoot
    )
      throw new Error(
        'Dogfood runtime receipt does not bind the declared capture surface',
      );
    const enriched = structuredClone(intent);
    enriched.runtimeReceipt = undefined;
    return { intent: enriched, receipt, verification };
  }
  if (process.env.KUNGFU_DOGFOOD_COMMAND)
    throw new Error(
      'an installed Dogfood command requires a full verified runtimeReceipt',
    );
  const source = inspectSource();
  const buildInfo = source.buildInfo;
  const revision = String(buildInfo.git?.revision || '');
  if (
    revision !== source.head ||
    buildInfo.git?.pristine !== true ||
    source.dirty
  )
    throw new Error(
      'source Dogfood capture build does not match the exact current checkout',
    );
  const request = {
    schema: 'kungfu.runtime-surface-request/v1',
    operationId: 'dogfood.capture',
    requestedSurface: 'source-checkout',
    candidates: [
      {
        providerId: 'source-shifu',
        surface: 'source-checkout',
        capabilities: [
          'dogfood.capture',
          'runtime.provenance',
          'source.build',
          'source.test',
        ],
        executable: {
          path: source.shifuPath,
          digest: source.shifuRoot,
          kind: 'source-shifu',
          version: `${buildInfo.version}+source`,
        },
        source: {
          commit: source.head,
          tree: `git:${source.tree}`,
          worktree: source.worktree,
        },
        bundleRoot: null,
        qualification: {
          state: 'source-qualified',
          evidenceRoots: [source.buildInfoRoot],
        },
      },
    ],
    authorityRoots: {
      assignmentRequestRoot: null,
      workDefinitionRoot: null,
      workRoot: null,
    },
    fallback: { allowed: false, reason: '' },
  };
  const requestPath = `${path.resolve(intentPath)}.runtime-surface-request.json`;
  fs.mkdirSync(path.dirname(requestPath), { recursive: true });
  fs.writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  const result = run(['runtime', 'surface', 'resolve', requestPath, '--json']);
  const receipt = parseJsonOutput(result, 'runtime surface resolve');
  if (result.status !== 0)
    throw new Error('source Dogfood runtime surface resolution failed closed');
  const verification = verifyRuntimeReceipt(receipt, run, intentPath);
  if (
    receipt.schema !== 'kungfu.runtime-surface-receipt/v1' ||
    receipt.operationId !== 'dogfood.capture' ||
    receipt.runtimeSurface !== 'source-checkout' ||
    !ROOT_PATTERN.test(receipt.receiptRoot || '')
  )
    throw new Error('source Dogfood runtime surface resolution failed closed');
  const enriched = structuredClone(intent);
  enriched.capture.runtimeSurface = receipt.runtimeSurface;
  enriched.capture.runtimeReceiptRoot = receipt.receiptRoot;
  return { intent: enriched, receipt, verification };
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
    !ROOT_PATTERN.test(intent.fingerprintRoot || '') ||
    !['installed-product', 'source-checkout', 'hybrid-boundary'].includes(
      intent.capture?.runtimeSurface,
    ) ||
    !ROOT_PATTERN.test(intent.capture?.runtimeReceiptRoot || '')
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
  {
    run = nativeDogfoodCli,
    intentPath,
    workspaceRoot,
    authorizedBy,
    reason,
    inspectSource,
  },
) {
  const runtimeBinding = bindRuntimeReceipt(
    intent,
    run,
    intentPath,
    inspectSource,
  );
  const boundIntent = runtimeBinding.intent;
  validateIntent(boundIntent);
  if (!path.isAbsolute(workspaceRoot || ''))
    throw new Error('native Dogfood workspace must be an absolute path');
  if (!authorizedBy || !reason)
    throw new Error('native Dogfood authorization and reason are required');

  const findingId = boundIntent.findingId;
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
      runtimeReceipt: runtimeBinding.receipt,
      runtimeVerification: runtimeBinding.verification,
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
  fs.writeFileSync(
    intentPath,
    `${JSON.stringify(boundIntent.capture, null, 2)}\n`,
  );
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
    runtimeReceipt: runtimeBinding.receipt,
    runtimeVerification: runtimeBinding.verification,
  };
}
