#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, semanticRoot } from '../project-cut/index.mjs';

export const ASSIGNMENT_REQUEST_SCHEMA = 'kungfu.assignment-request/v1';
export const CAPTURE_RECEIPT_SCHEMA = 'kungfu.assignment-capture.receipt/v1';
export const CAPTURE_RESPONSE_SCHEMA = 'kungfu.assignment-capture.response/v1';
export const CLEANUP_PLAN_SCHEMA = 'kungfu.assignment-capture.cleanup-plan/v1';
export const EXPIRY_RECEIPT_SCHEMA =
  'kungfu.assignment-capture.expiry-receipt/v1';
export const RETENTION_POLICY = 'explicit-expiry-retain-bytes-v1';

const ROOT = /^sha256:[0-9a-f]{64}$/u;
const REQUEST_KEYS = new Set([
  'retention',
  'schema',
  'source',
  'workDefinition',
]);

export class AssignmentCaptureError extends Error {
  constructor(code, message, exitCode = 65) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function homeDataHome(env) {
  return canonicalPath(path.join(env.HOME || os.homedir(), '.kungfu'));
}

function workspaceId(root) {
  return `project:${createHash('sha256').update(root, 'utf8').digest('hex').slice(0, 16)}`;
}

function nearestWorkspaceHome(start, env) {
  let current = canonicalPath(start);
  const legacyHome = homeDataHome(env);
  for (;;) {
    const candidate = path.join(current, '.kungfu');
    if (
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isDirectory() &&
      canonicalPath(candidate) !== legacyHome
    ) {
      return canonicalPath(candidate);
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function gitWorktreeRoot(start) {
  if (!fs.existsSync(start) || !fs.statSync(start).isDirectory()) return null;
  const result = spawnSync(
    'git',
    ['-C', start, 'rev-parse', '--show-toplevel'],
    {
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) return null;
  const root = result.stdout.trim();
  return root ? canonicalPath(root) : null;
}

function homeTarget(env, sourceWorkingDirectory, reason) {
  const dataHome = homeDataHome(env);
  return {
    operationClass: 'capture-only',
    workspaceId: 'home',
    workspaceKind: 'home',
    workspaceRoot: null,
    dataHome,
    resolutionReason: reason,
    association: reason === 'no-project-workspace' ? 'unassigned' : 'workspace',
    sourceWorkingDirectory,
  };
}

function projectTarget(root, sourceWorkingDirectory, reason) {
  const workspaceRoot = canonicalPath(root);
  return {
    operationClass: 'capture-only',
    workspaceId: workspaceId(workspaceRoot),
    workspaceKind: 'project',
    workspaceRoot,
    dataHome: path.join(workspaceRoot, '.kungfu'),
    resolutionReason: reason,
    association: 'workspace',
    sourceWorkingDirectory,
  };
}

/**
 * Mirror workspace.py's capture-only target order without importing or
 * initializing the compiled runtime.
 */
export function resolveCaptureTarget({
  workspaceRoot = '',
  home = false,
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  if (workspaceRoot && home) {
    throw new AssignmentCaptureError(
      'target-conflict',
      'pass either --workspace or --home, not both',
    );
  }
  const sourceWorkingDirectory = canonicalPath(cwd);
  if (home) return homeTarget(env, sourceWorkingDirectory, 'explicit-home');
  if (workspaceRoot) {
    return projectTarget(
      workspaceRoot,
      sourceWorkingDirectory,
      'explicit-workspace',
    );
  }
  if (env.KF_WORKSPACE_ROOT) {
    return projectTarget(
      env.KF_WORKSPACE_ROOT,
      sourceWorkingDirectory,
      'environment-workspace-root',
    );
  }
  if (env.KF_HOME) {
    const dataHome = canonicalPath(env.KF_HOME);
    if (dataHome === homeDataHome(env)) {
      return homeTarget(env, sourceWorkingDirectory, 'environment-home');
    }
    if (path.basename(dataHome) === '.kungfu') {
      return projectTarget(
        path.dirname(dataHome),
        sourceWorkingDirectory,
        'environment-data-home',
      );
    }
    return {
      operationClass: 'capture-only',
      workspaceId: `machine:${createHash('sha256').update(dataHome, 'utf8').digest('hex').slice(0, 16)}`,
      workspaceKind: 'machine',
      workspaceRoot: null,
      dataHome,
      resolutionReason: 'environment-data-home',
      association: 'workspace',
      sourceWorkingDirectory,
    };
  }
  const existing = nearestWorkspaceHome(sourceWorkingDirectory, env);
  if (existing) {
    return projectTarget(
      path.dirname(existing),
      sourceWorkingDirectory,
      'discovered-project-workspace',
    );
  }
  const gitRoot = gitWorktreeRoot(sourceWorkingDirectory);
  if (gitRoot) {
    return projectTarget(
      gitRoot,
      sourceWorkingDirectory,
      'discovered-project-workspace',
    );
  }
  return homeTarget(env, sourceWorkingDirectory, 'no-project-workspace');
}

export function validateAssignmentRequest(value) {
  if (!isObject(value)) {
    throw new AssignmentCaptureError(
      'request-not-object',
      'Assignment request must be a JSON object',
    );
  }
  for (const key of Object.keys(value)) {
    if (!REQUEST_KEYS.has(key)) {
      throw new AssignmentCaptureError(
        'request-field-unknown',
        `Assignment request has an unknown field: ${key}`,
      );
    }
  }
  if (value.schema !== ASSIGNMENT_REQUEST_SCHEMA) {
    throw new AssignmentCaptureError(
      'request-schema',
      `Assignment request schema must be ${ASSIGNMENT_REQUEST_SCHEMA}`,
    );
  }
  if (!isObject(value.workDefinition)) {
    throw new AssignmentCaptureError(
      'work-definition',
      'workDefinition must be a JSON object',
    );
  }
  if (!isObject(value.source) || typeof value.source.kind !== 'string') {
    throw new AssignmentCaptureError(
      'request-source',
      'source.kind must be a non-empty string',
    );
  }
  if (!value.source.kind.trim()) {
    throw new AssignmentCaptureError(
      'request-source',
      'source.kind must be a non-empty string',
    );
  }
  if (
    !isObject(value.retention) ||
    value.retention.policy !== RETENTION_POLICY ||
    !Object.hasOwn(value.retention, 'expiresAt')
  ) {
    throw new AssignmentCaptureError(
      'request-retention',
      `retention must declare ${RETENTION_POLICY} and expiresAt`,
    );
  }
  if (
    Object.keys(value.retention).some(
      (key) => key !== 'policy' && key !== 'expiresAt',
    )
  ) {
    throw new AssignmentCaptureError(
      'request-retention',
      'retention contains an unknown field',
    );
  }
  const expiresAt = value.retention.expiresAt;
  if (
    expiresAt !== null &&
    (typeof expiresAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
        expiresAt,
      ) ||
      !Number.isFinite(Date.parse(expiresAt)))
  ) {
    throw new AssignmentCaptureError(
      'request-expiry',
      'retention.expiresAt must be null or an ISO-8601 timestamp',
    );
  }
  // canonicalJson is the executable admission boundary for NFC strings,
  // Unicode scalars, supported values, and non-negative safe integers.
  canonicalJson(value);
  return value;
}

function writeExact(file, bytes) {
  if (fs.existsSync(file)) {
    if (!fs.readFileSync(file).equals(bytes)) {
      throw new AssignmentCaptureError(
        'immutable-collision',
        `content-addressed file differs: ${file}`,
        73,
      );
    }
    return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${semanticRoot(bytes.toString('base64')).slice(-12)}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    try {
      fs.linkSync(temporary, file);
      fs.rmSync(temporary);
    } catch (error) {
      if (fs.existsSync(file)) {
        if (!fs.readFileSync(file).equals(bytes)) {
          throw new AssignmentCaptureError(
            'immutable-collision',
            `content-addressed file differs: ${file}`,
            73,
          );
        }
        fs.rmSync(temporary);
        return false;
      }
      throw error;
    }
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
  return true;
}

function rootDirectory(dataHome, requestRoot) {
  const digest = requestRoot.slice('sha256:'.length);
  return path.join(
    dataHome,
    'inbox',
    'assignment-requests',
    'sha256',
    digest.slice(0, 2),
    digest,
  );
}

export function captureAssignmentRequest(request, options = {}) {
  validateAssignmentRequest(request);
  const target = resolveCaptureTarget(options);
  const requestRoot = semanticRoot(request);
  const directory = rootDirectory(target.dataHome, requestRoot);
  const requestPath = path.join(directory, 'request.json');
  const relativeRequestPath = path.relative(target.dataHome, requestPath);
  const receiptCore = {
    schema: CAPTURE_RECEIPT_SCHEMA,
    operationClass: target.operationClass,
    requestRoot,
    requestPath: relativeRequestPath,
    workspaceId: target.workspaceId,
    workspaceKind: target.workspaceKind,
    workspaceRoot: target.workspaceRoot,
    resolutionReason: target.resolutionReason,
    association: target.association,
    sourceWorkingDirectory: target.sourceWorkingDirectory,
    effects: ['assignment-request-captured', 'capture-receipt-recorded'],
    skippedEffects: [
      'initiative-association',
      'assignment-admission',
      'assignment-claim',
      'runtime-initialization',
      'journal-write',
      'git-init',
      'git-stage',
      'git-commit',
      'git-push',
    ],
  };
  if (target.association === 'unassigned') {
    receiptCore.skippedEffects.unshift('project-association');
  }
  const receiptRoot = semanticRoot(receiptCore);
  const receipt = { ...receiptCore, receiptRoot };
  const receiptPath = path.join(
    directory,
    'receipts',
    'sha256',
    `${receiptRoot.slice('sha256:'.length)}.json`,
  );
  const requestWritten = writeExact(
    requestPath,
    Buffer.from(`${canonicalJson(request)}\n`, 'utf8'),
  );
  const receiptWritten = writeExact(
    receiptPath,
    Buffer.from(`${canonicalJson(receipt)}\n`, 'utf8'),
  );
  return {
    schema: CAPTURE_RESPONSE_SCHEMA,
    status: requestWritten || receiptWritten ? 'captured' : 'already-present',
    requestRoot,
    receiptRoot,
    requestPath,
    receiptPath,
    target: {
      ...target,
      runtimeInitialized: fs.existsSync(path.join(target.dataHome, 'runtime')),
    },
    authority: 'capture-material-only',
    admitted: false,
    claimed: false,
  };
}

function loadRequest(file) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new AssignmentCaptureError(
      'request-read',
      `cannot read Assignment request ${file}: ${error.message}`,
      66,
    );
  }
  return validateAssignmentRequest(value);
}

function requestFiles(dataHome) {
  const root = path.join(dataHome, 'inbox', 'assignment-requests', 'sha256');
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const prefix of fs.readdirSync(root).sort()) {
    const prefixPath = path.join(root, prefix);
    if (!fs.statSync(prefixPath).isDirectory()) continue;
    for (const digest of fs.readdirSync(prefixPath).sort()) {
      const file = path.join(prefixPath, digest, 'request.json');
      if (fs.existsSync(file)) files.push(file);
    }
  }
  return files;
}

function captureReceiptFiles(directory) {
  const root = path.join(directory, 'receipts', 'sha256');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => /^[0-9a-f]{64}\.json$/u.test(name))
    .sort()
    .map((name) => path.join(root, name));
}

function verifiedCaptureReceiptPaths(directory, dataHome, requestRoot) {
  const files = captureReceiptFiles(directory);
  if (files.length === 0) {
    throw new AssignmentCaptureError(
      'capture-incomplete',
      `captured request has no capture receipt: ${requestRoot}`,
      73,
    );
  }
  return files.map((file) => {
    let receipt;
    try {
      receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new AssignmentCaptureError(
        'capture-receipt-read',
        `cannot read capture receipt ${file}: ${error.message}`,
        73,
      );
    }
    if (!isObject(receipt) || !ROOT.test(receipt.receiptRoot || '')) {
      throw new AssignmentCaptureError(
        'capture-receipt-invalid',
        `capture receipt has no valid root: ${file}`,
        73,
      );
    }
    const { receiptRoot, ...receiptCore } = receipt;
    if (
      receipt.requestRoot !== requestRoot ||
      semanticRoot(receiptCore) !== receiptRoot ||
      path.basename(file) !== `${receiptRoot.slice('sha256:'.length)}.json`
    ) {
      throw new AssignmentCaptureError(
        'capture-receipt-mismatch',
        `capture receipt does not match request or path: ${file}`,
        73,
      );
    }
    return path.relative(dataHome, file);
  });
}

function normalizedNow(value) {
  const date = new Date(value || Date.now());
  if (!Number.isFinite(date.valueOf())) {
    throw new AssignmentCaptureError('cleanup-now', '--now must be ISO-8601');
  }
  return date.toISOString();
}

export function planAssignmentCleanup(options = {}) {
  const target = resolveCaptureTarget(options);
  const now = normalizedNow(options.now);
  const candidates = [];
  for (const requestPath of requestFiles(target.dataHome)) {
    const request = loadRequest(requestPath);
    const requestRoot = semanticRoot(request);
    const directory = path.dirname(requestPath);
    const digest = path.basename(directory);
    if (!ROOT.test(requestRoot) || digest !== requestRoot.slice(7)) {
      throw new AssignmentCaptureError(
        'request-root-mismatch',
        `captured request path does not match its root: ${requestPath}`,
        73,
      );
    }
    const expiryReceiptPath = path.join(directory, 'expiry-receipt.json');
    const expiresAt = request.retention.expiresAt;
    if (
      expiresAt !== null &&
      Date.parse(expiresAt) <= Date.parse(now) &&
      !fs.existsSync(expiryReceiptPath)
    ) {
      candidates.push({
        requestRoot,
        expiresAt,
        requestPath: path.relative(target.dataHome, requestPath),
        captureReceiptPaths: verifiedCaptureReceiptPaths(
          directory,
          target.dataHome,
          requestRoot,
        ),
        expiryReceiptPath: path.relative(target.dataHome, expiryReceiptPath),
      });
    }
  }
  const plan = {
    schema: CLEANUP_PLAN_SCHEMA,
    workspaceId: target.workspaceId,
    dataHome: target.dataHome,
    now,
    candidates,
    effects: ['write-expiry-receipt', 'retire-from-active-inbox-projection'],
    excludedEffects: [
      'delete-request',
      'delete-capture-receipt',
      'runtime-write',
      'journal-write',
    ],
  };
  return { ...plan, planRoot: semanticRoot(plan), executed: false };
}

export function executeAssignmentCleanup(options = {}) {
  const plan = planAssignmentCleanup(options);
  if (!options.execute) return plan;
  if (!ROOT.test(options.expectedPlanRoot || '')) {
    throw new AssignmentCaptureError(
      'expected-plan-root-required',
      '--execute requires --expected-plan-root sha256:<digest>',
    );
  }
  if (options.expectedPlanRoot !== plan.planRoot) {
    throw new AssignmentCaptureError(
      'cleanup-plan-stale',
      `cleanup plan changed: expected ${options.expectedPlanRoot}, current ${plan.planRoot}`,
      73,
    );
  }
  const receipts = [];
  for (const candidate of plan.candidates) {
    const receiptCore = {
      schema: EXPIRY_RECEIPT_SCHEMA,
      planRoot: plan.planRoot,
      requestRoot: candidate.requestRoot,
      expiresAt: candidate.expiresAt,
      retiredAt: plan.now,
      status: 'retired',
      retainedPaths: [candidate.requestPath, ...candidate.captureReceiptPaths],
      effects: ['retired-from-active-inbox-projection'],
      excludedEffects: ['delete-request', 'delete-capture-receipt'],
    };
    const receipt = { ...receiptCore, receiptRoot: semanticRoot(receiptCore) };
    const receiptPath = path.join(plan.dataHome, candidate.expiryReceiptPath);
    writeExact(receiptPath, Buffer.from(`${canonicalJson(receipt)}\n`, 'utf8'));
    receipts.push({ ...receipt, receiptPath });
  }
  return { ...plan, executed: true, receipts };
}

function parseArgs(argv) {
  const command = argv.shift() || '';
  const options = { json: false, home: false, execute: false };
  while (argv.length > 0) {
    const token = argv.shift();
    if (token === '--json') options.json = true;
    else if (token === '--home') options.home = true;
    else if (token === '--execute') options.execute = true;
    else if (
      [
        '--request',
        '--workspace',
        '--cwd',
        '--now',
        '--expected-plan-root',
      ].includes(token)
    ) {
      if (argv.length === 0) {
        throw new AssignmentCaptureError(
          'option-value',
          `${token} requires a value`,
        );
      }
      const key = {
        '--request': 'request',
        '--workspace': 'workspaceRoot',
        '--cwd': 'cwd',
        '--now': 'now',
        '--expected-plan-root': 'expectedPlanRoot',
      }[token];
      options[key] = argv.shift();
    } else {
      throw new AssignmentCaptureError(
        'unknown-option',
        `unknown option: ${token}`,
      );
    }
  }
  if (!options.json) {
    throw new AssignmentCaptureError(
      'json-required',
      'Assignment capture commands require --json',
      64,
    );
  }
  return { command, options };
}

function readRequestArgument(value) {
  if (!value) {
    throw new AssignmentCaptureError(
      'request-required',
      'capture requires --request <file>',
      64,
    );
  }
  if (value === '-') {
    return validateAssignmentRequest(JSON.parse(fs.readFileSync(0, 'utf8')));
  }
  return loadRequest(value);
}

export function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs([...argv]);
  let response;
  if (command === 'capture') {
    response = captureAssignmentRequest(
      readRequestArgument(options.request),
      options,
    );
  } else if (command === 'cleanup') {
    response = executeAssignmentCleanup(options);
  } else {
    throw new AssignmentCaptureError(
      'unknown-command',
      `unsupported Assignment capture command: ${command || '<empty>'}`,
      64,
    );
  }
  process.stdout.write(`${canonicalJson(response)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    const code =
      error instanceof AssignmentCaptureError ? error.code : 'failure';
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${code}: ${message}\n`);
    process.exit(error instanceof AssignmentCaptureError ? error.exitCode : 1);
  }
}
