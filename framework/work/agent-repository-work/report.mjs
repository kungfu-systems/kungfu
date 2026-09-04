#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PLAN_SCHEMA = 'kungfu.agent-patrol.plan/v2';
const REPORT_SCHEMA = 'kungfu.agent-repository-work.report/v1';
const CLASSIFICATION_SCHEMA = 'kungfu.agent-patrol.classification/v1';
const DOGFOOD_RECEIPT_SCHEMA = 'kungfu.agent-patrol.dogfood-capture-receipt/v1';
const RECEIPT_SCHEMA = 'kungfu.agent-patrol.capability-receipt/v1';
const STORE_RECEIPT_SCHEMA = 'kungfu.agent-patrol.capability-store-receipt/v1';
const TREND_SCHEMA = 'kungfu.agent-patrol.capability-trend/v1';
const QUALIFICATION_SCHEMA = 'kungfu.agent-patrol.capability-qualification/v1';
const ARTIFACT_AUDIT_SCHEMA = 'kungfu.agent-patrol.artifact-audit/v1';
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const GIT_OID_PATTERN = /^[0-9a-f]{40}$/u;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const STATE_RECEIPT_LIMIT = 2_048;
const TREND_RECEIPT_LIMIT = 128;
const ARTIFACT_FILE_LIMIT = 256 * 1024;
const ARTIFACT_TOTAL_LIMIT = 4 * 1024 * 1024;

const FORBIDDEN_KEYS = new Set([
  'authorization',
  'credential',
  'credentials',
  'patch',
  'prompt',
  'rawResponse',
  'response',
  'secret',
  'signedUrl',
  'token',
  'transcript',
]);

const ALLOWED_ARTIFACT_PATHS = [
  /^plan\.json$/u,
  /^reports\/[a-z0-9._-]+\/trial-[1-9][0-9]*\.json$/u,
  /^classifications\/[a-z0-9._-]+\/trial-[1-9][0-9]*\.json$/u,
  /^dogfood-receipts\/[a-z0-9._-]+\/trial-[1-9][0-9]*\.json$/u,
  /^capability-receipts\/[a-z0-9._-]+\/trial-[1-9][0-9]*\.json$/u,
  /^store-receipts\/[a-z0-9._-]+\/trial-[1-9][0-9]*\.json$/u,
  /^trends\/(?:14|30)-day\.json$/u,
  /^qualification\.json$/u,
  /^artifact-audit\.json$/u,
];

export function validateExperimentReport(report) {
  if (report?.schema !== REPORT_SCHEMA)
    throw new Error('repository-work report schema is unsupported');
  if (report.evidenceClass !== 'bounded-experiment')
    throw new Error('repository-work evidence class must stay bounded');
  if (report.nonClaims?.auditableDemo !== true)
    throw new Error('Auditable Demo non-integration boundary is required');
  if (report.nonClaims?.agentWorkLab !== true)
    throw new Error('Qualification Lab non-integration boundary is required');
  if (
    report.nonClaims?.releaseGate !== true ||
    report.nonClaims?.publicClaim !== true
  )
    throw new Error('release and public-claim boundaries are required');
  if (report.passed) {
    if (report.sessions?.distinct !== 2)
      throw new Error('exactly two fresh provider sessions are required');
    if (report.continuity?.priorTranscriptBytes !== 0)
      throw new Error('Agent B must receive zero prior transcript bytes');
    if (report.continuity?.humanRestatementCount !== 0)
      throw new Error('Agent B must receive no human task restatement');
    if (report.warrant?.agentAZeroModification !== true)
      throw new Error('Agent A modified the production fixture');
    if (report.oracle?.passed !== true || report.oracle?.authoritative !== true)
      throw new Error('external deterministic oracle is authoritative');
    if (
      report.sessions.a.providerSessionId ===
      report.sessions.b.providerSessionId
    )
      throw new Error('provider sessions are not fresh and distinct');
    for (const value of [
      report.claim?.root,
      report.assessment?.root,
      report.continuity?.root,
      report.oracle?.reportRoot,
    ])
      if (!ROOT_PATTERN.test(value || ''))
        throw new Error('repository-work evidence root is invalid');
  }
  return true;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

export function jsonRoot(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;
}

function presentationBytes(value) {
  return Buffer.from(`${JSON.stringify(canonical(value))}\n`, 'utf8');
}

function assertRoot(value, label) {
  if (!ROOT_PATTERN.test(value || '')) throw new Error(`${label} is invalid`);
}

function assertSafeId(value, label) {
  if (!SAFE_ID_PATTERN.test(value || ''))
    throw new Error(`${label} is not a bounded identifier`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function writeJson(file, value) {
  const output = path.resolve(file);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`);
}

function walkValue(value, visit, key = '') {
  visit(value, key);
  if (Array.isArray(value)) {
    for (const entry of value) walkValue(entry, visit, key);
  } else if (value && typeof value === 'object') {
    for (const [childKey, entry] of Object.entries(value))
      walkValue(entry, visit, childKey);
  }
}

function assertPrivacyBounded(value, label) {
  walkValue(value, (entry, key) => {
    if (FORBIDDEN_KEYS.has(key))
      throw new Error(`${label} contains forbidden field ${key}`);
    if (
      typeof entry === 'string' &&
      (/(?:^|[\s"'`])(?:\/Users\/|\/home\/|[A-Za-z]:\\)/u.test(entry) ||
        /-----BEGIN [A-Z ]+-----/u.test(entry))
    )
      throw new Error(`${label} contains a private path or key material`);
  });
}

function validatePlan(plan) {
  if (plan?.schema !== PLAN_SCHEMA)
    throw new Error('Patrol plan schema is unsupported');
  assertRoot(plan.planRoot, 'planRoot');
  const { planRoot, ...body } = plan;
  if (jsonRoot(body) !== planRoot) throw new Error('Patrol plan root mismatch');
  if (
    !Array.isArray(plan.fixtures) ||
    !plan.fixtures.every((fixture) => SAFE_ID_PATTERN.test(fixture)) ||
    !Number.isInteger(plan.trialsPerFixture) ||
    plan.trialsPerFixture < 0 ||
    plan.trialsPerFixture > 3
  )
    throw new Error('Patrol plan bounds are invalid');
  if (
    plan.issueAdmission !== 'prohibited' ||
    plan.requiredGate !== false ||
    plan.advisoryModelQuality !== true ||
    plan.protectedSourceRequired !== true
  )
    throw new Error('Patrol plan authority boundary is invalid');
}

function dimensionStates(report, classification, plan) {
  const oracle = report.oracle;
  const failureCategory = classification.category || null;
  const execution =
    report.sessions?.distinct === 2 && failureCategory !== 'runner-environment'
      ? 'pass'
      : 'fail';
  const functional =
    oracle?.passed === true
      ? 'pass'
      : oracle?.passed === false || failureCategory === 'verifier'
        ? 'fail'
        : 'unknown';
  const scope =
    Array.isArray(oracle?.scopeViolations) &&
    oracle.scopeViolations.length === 0
      ? 'pass'
      : failureCategory === 'warrant-scope' ||
          (oracle?.scopeViolations?.length || 0) > 0
        ? 'fail'
        : 'unknown';
  const continuity =
    report.continuity?.root &&
    report.continuity?.priorTranscriptBytes === 0 &&
    report.continuity?.humanRestatementCount === 0
      ? 'pass'
      : failureCategory === 'kungfu-continuity'
        ? 'fail'
        : 'unknown';
  const exactness =
    report.fixture?.kind !== 'real-module-snapshot'
      ? 'not-applicable'
      : oracle?.checks?.referenceRoot === true
        ? 'pass'
        : oracle?.checks?.referenceRoot === false
          ? 'fail'
          : 'unknown';
  const elapsed = report.dimensions?.efficiency?.elapsedMilliseconds;
  const maximum = plan.timeoutSeconds * 2 * 1_000;
  const efficiency =
    Number.isInteger(elapsed) && elapsed >= 0
      ? maximum > 0 && elapsed <= maximum
        ? 'pass'
        : 'fail'
      : 'unknown';
  return {
    execution,
    functional,
    scope,
    continuity,
    exactness,
    evidence: 'pass',
    efficiency,
  };
}

function boundedChangeSignals(report) {
  const source = report.changeSignals || {};
  const number = (field) =>
    Number.isInteger(source[field]) && source[field] >= 0
      ? source[field]
      : null;
  return {
    changedPathCount: number('changedPathCount'),
    changedFileCount: number('changedFileCount'),
    lineDeltaAbs: number('lineDeltaAbs'),
    byteDeltaAbs: number('byteDeltaAbs'),
    expectedMutationSiteContact:
      typeof source.expectedMutationSiteContact === 'boolean'
        ? source.expectedMutationSiteContact
        : null,
    structuralFingerprintRoot: ROOT_PATTERN.test(
      source.structuralFingerprintRoot || '',
    )
      ? source.structuralFingerprintRoot
      : null,
    symbolFingerprintRoot: ROOT_PATTERN.test(source.symbolFingerprintRoot || '')
      ? source.symbolFingerprintRoot
      : null,
    toolProcessFailureCount: report.failure ? 1 : 0,
    elapsedMilliseconds:
      Number.isInteger(report.dimensions?.efficiency?.elapsedMilliseconds) &&
      report.dimensions.efficiency.elapsedMilliseconds >= 0
        ? report.dimensions.efficiency.elapsedMilliseconds
        : null,
  };
}

export function createCapabilityReceipt({
  plan,
  report,
  classification,
  dogfoodReceipt,
  sourceTree,
  runner,
  trial,
  observedAt,
}) {
  validatePlan(plan);
  if (report?.schema !== 'kungfu.agent-repository-work.report/v1')
    throw new Error('repository-work report schema is unsupported');
  if (classification?.schema !== CLASSIFICATION_SCHEMA)
    throw new Error('Patrol classification schema is unsupported');
  if (dogfoodReceipt?.schema !== DOGFOOD_RECEIPT_SCHEMA)
    throw new Error('Dogfood receipt schema is unsupported');
  if (
    dogfoodReceipt.issueAdmitted !== false ||
    classification.issueAdmission !== 'prohibited'
  )
    throw new Error('automatic Dogfood Issue admission is forbidden');
  if (!GIT_OID_PATTERN.test(report.sourceHead || ''))
    throw new Error('report source commit is invalid');
  if (!GIT_OID_PATTERN.test(sourceTree || ''))
    throw new Error('source tree is invalid');
  assertSafeId(report.fixture?.id, 'fixture id');
  assertSafeId(runner, 'runner');
  if (!Number.isInteger(trial) || trial < 1 || trial > plan.trialsPerFixture)
    throw new Error('trial is outside the selected plan');
  if (!plan.fixtures.includes(report.fixture.id))
    throw new Error('report fixture is outside the selected plan');
  if (classification.reportRoot !== jsonRoot(report))
    throw new Error('classification does not bind the exact report');
  if (classification.sourceHead !== report.sourceHead)
    throw new Error('classification source does not match the report');
  if (classification.runner !== runner)
    throw new Error('classification runner does not match the receipt');
  const instant = new Date(observedAt);
  if (!observedAt || Number.isNaN(instant.valueOf()))
    throw new Error('observedAt must be an ISO timestamp');

  const sessionRoots = [
    report.sessions?.a?.reportRoot,
    report.sessions?.b?.reportRoot,
  ]
    .filter((value) => ROOT_PATTERN.test(value || ''))
    .sort();
  const body = {
    schema: RECEIPT_SCHEMA,
    observedAt: instant.toISOString(),
    source: {
      commit: report.sourceHead,
      tree: sourceTree,
    },
    plan: {
      root: plan.planRoot,
      mode: plan.mode,
      trigger: plan.trigger,
      schedule: plan.schedule,
      trial,
      trialsPerFixture: plan.trialsPerFixture,
    },
    fixture: {
      id: report.fixture.id,
      kind: report.fixture.kind,
      sourceTreeRoot: ROOT_PATTERN.test(report.fixture.sourceTreeRoot || '')
        ? report.fixture.sourceTreeRoot
        : null,
    },
    runtime: {
      provider: report.runtime?.provider,
      image: report.runtime?.image,
      model: report.runtime?.model,
      runner,
      context: report.runtime?.context,
    },
    evidence: {
      reportRoot: classification.reportRoot,
      classificationRoot: jsonRoot(classification),
      warrantRoot: jsonRoot(report.warrant || {}),
      sessionRoots,
      verifierRoot: ROOT_PATTERN.test(report.oracle?.reportRoot || '')
        ? report.oracle.reportRoot
        : null,
      continuityRoot: ROOT_PATTERN.test(report.continuity?.root || '')
        ? report.continuity.root
        : null,
      dogfoodReceiptRoot: jsonRoot(dogfoodReceipt),
    },
    dimensions: dimensionStates(report, classification, plan),
    changeSignals: boundedChangeSignals(report),
    outcome: {
      classification: classification.outcome,
      blocking: classification.blocking,
      failureFingerprintRoot: ROOT_PATTERN.test(
        classification.findingIntent?.fingerprintRoot || '',
      )
        ? classification.findingIntent.fingerprintRoot
        : null,
    },
    privacy: {
      sourceBytesRetained: false,
      patchRetained: false,
      promptRetained: false,
      transcriptRetained: false,
      rawResponseRetained: false,
      hiddenVerifierRetained: false,
      credentialsRetained: false,
      privatePathsRetained: false,
    },
    issueAdmitted: false,
  };
  assertPrivacyBounded(body, 'Capability Receipt');
  return { ...body, receiptRoot: jsonRoot(body) };
}

export function validateCapabilityReceipt(receipt) {
  if (receipt?.schema !== RECEIPT_SCHEMA)
    throw new Error('Capability Receipt schema is unsupported');
  assertRoot(receipt.receiptRoot, 'receiptRoot');
  const { receiptRoot, ...body } = receipt;
  if (jsonRoot(body) !== receiptRoot)
    throw new Error('Capability Receipt root mismatch');
  if (
    !GIT_OID_PATTERN.test(receipt.source?.commit || '') ||
    !GIT_OID_PATTERN.test(receipt.source?.tree || '')
  )
    throw new Error('Capability Receipt source identity is invalid');
  assertRoot(receipt.plan?.root, 'Capability Receipt plan root');
  assertSafeId(receipt.fixture?.id, 'Capability Receipt fixture id');
  assertSafeId(receipt.runtime?.runner, 'Capability Receipt runner');
  for (const root of [
    receipt.evidence?.reportRoot,
    receipt.evidence?.classificationRoot,
    receipt.evidence?.warrantRoot,
    receipt.evidence?.dogfoodReceiptRoot,
    ...(receipt.evidence?.sessionRoots || []),
  ])
    assertRoot(root, 'Capability Receipt evidence root');
  const allowedStates = new Set(['pass', 'fail', 'unknown', 'not-applicable']);
  for (const dimension of [
    'execution',
    'functional',
    'scope',
    'continuity',
    'exactness',
    'evidence',
    'efficiency',
  ])
    if (!allowedStates.has(receipt.dimensions?.[dimension]))
      throw new Error(`Capability Receipt ${dimension} state is invalid`);
  if (
    receipt.issueAdmitted !== false ||
    Object.values(receipt.privacy || {}).some((retained) => retained !== false)
  )
    throw new Error('Capability Receipt privacy boundary is invalid');
  assertPrivacyBounded(receipt, 'Capability Receipt');
  return true;
}

export function storeCapabilityReceipt(receipt, stateRoot) {
  validateCapabilityReceipt(receipt);
  if (!path.isAbsolute(stateRoot || ''))
    throw new Error('Capability Receipt state root must be absolute');
  const stateStats = fs.lstatSync(stateRoot);
  if (!stateStats.isDirectory() || stateStats.isSymbolicLink())
    throw new Error('Capability Receipt state root must be a real directory');
  const relative = path.join(
    'capability-receipts',
    'v1',
    receipt.receiptRoot.slice(7, 9),
    `${receipt.receiptRoot}.json`,
  );
  const target = path.join(stateRoot, relative);
  const bytes = presentationBytes(receipt);
  let current = stateRoot;
  for (const segment of path.dirname(relative).split(path.sep)) {
    current = path.join(current, segment);
    fs.mkdirSync(current, { recursive: true, mode: 0o700 });
    const stats = fs.lstatSync(current);
    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new Error('Capability Receipt store contains a symlink');
  }
  let status = 'created';
  try {
    const handle = fs.openSync(target, 'wx', 0o600);
    try {
      fs.writeFileSync(handle, bytes);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = fs.readFileSync(target);
    if (!existing.equals(bytes))
      throw new Error('Capability Receipt content-address collision');
    status = 'already-present';
  }
  return {
    schema: STORE_RECEIPT_SCHEMA,
    status,
    receiptRoot: receipt.receiptRoot,
    storageKeyRoot: jsonRoot(relative.split(path.sep).join('/')),
    overwritten: false,
    deleted: false,
  };
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(quantile * sorted.length) - 1];
}

function tupleKey(receipt) {
  return [
    receipt.runtime.provider,
    receipt.runtime.image,
    receipt.runtime.model,
    receipt.runtime.runner,
    String(receipt.runtime.context),
    receipt.fixture.id,
  ].join('|');
}

function receiptPasses(receipt) {
  const dimensions = receipt.dimensions;
  return (
    receipt.outcome.blocking === false &&
    dimensions.execution === 'pass' &&
    dimensions.functional === 'pass' &&
    dimensions.scope === 'pass' &&
    dimensions.continuity === 'pass' &&
    ['pass', 'not-applicable'].includes(dimensions.exactness) &&
    dimensions.evidence === 'pass' &&
    dimensions.efficiency === 'pass'
  );
}

function qualificationState(receipts) {
  if (receipts.length < 3) return 'insufficient-history';
  if (receipts.slice(-3).every(receiptPasses)) return 'qualified';
  return 'hold';
}

function listStoredReceipts(stateRoot) {
  const root = path.join(path.resolve(stateRoot), 'capability-receipts', 'v1');
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const shard of fs.readdirSync(root, { withFileTypes: true })) {
    if (!shard.isDirectory() || !/^[0-9a-f]{2}$/u.test(shard.name)) continue;
    for (const entry of fs.readdirSync(path.join(root, shard.name), {
      withFileTypes: true,
    })) {
      if (entry.isFile() && /^sha256:[0-9a-f]{64}\.json$/u.test(entry.name))
        files.push(path.join(root, shard.name, entry.name));
    }
  }
  if (files.length > STATE_RECEIPT_LIMIT)
    throw new Error('Capability Receipt state exceeds the bounded scan limit');
  return files;
}

export function buildTrend({ stateRoot, days, asOf }) {
  if (![14, 30].includes(days))
    throw new Error('Capability trend window must be 14 or 30 days');
  const instant = new Date(asOf);
  if (!asOf || Number.isNaN(instant.valueOf()))
    throw new Error('Capability trend asOf is invalid');
  const cutoff = instant.valueOf() - days * 24 * 60 * 60 * 1_000;
  const receipts = listStoredReceipts(stateRoot)
    .map(readJson)
    .filter((receipt) => {
      validateCapabilityReceipt(receipt);
      const observed = new Date(receipt.observedAt).valueOf();
      return observed >= cutoff && observed <= instant.valueOf();
    })
    .sort((left, right) => {
      const observed = left.observedAt.localeCompare(right.observedAt);
      return observed || left.receiptRoot.localeCompare(right.receiptRoot);
    })
    .slice(-TREND_RECEIPT_LIMIT);
  const groups = new Map();
  for (const receipt of receipts) {
    const key = tupleKey(receipt);
    const group = groups.get(key) || [];
    group.push(receipt);
    groups.set(key, group);
  }
  const body = {
    schema: TREND_SCHEMA,
    windowDays: days,
    asOf: instant.toISOString(),
    selectedReceiptCount: receipts.length,
    selectedReceiptRoots: receipts.map(({ receiptRoot }) => receiptRoot).sort(),
    selectionLimit: TREND_RECEIPT_LIMIT,
    groups: [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => {
        const passes = values.filter(receiptPasses).length;
        const usedDurations = values
          .map((receipt) => receipt.changeSignals?.elapsedMilliseconds)
          .filter(Number.isInteger);
        const failures = new Map();
        for (const value of values) {
          const root = value.outcome.failureFingerprintRoot;
          if (root) failures.set(root, (failures.get(root) || 0) + 1);
        }
        return {
          tupleRoot: jsonRoot(key),
          fixtureId: values[0].fixture.id,
          runtime: values[0].runtime,
          receiptCount: values.length,
          passCount: passes,
          passRatePermille: Math.floor((passes * 1_000) / values.length),
          durationMilliseconds: {
            p50: percentile(usedDurations, 0.5),
            p95: percentile(usedDurations, 0.95),
          },
          recurrentFailures: [...failures.entries()]
            .map(([fingerprintRoot, count]) => ({ fingerprintRoot, count }))
            .sort(
              (left, right) =>
                right.count - left.count ||
                left.fingerprintRoot.localeCompare(right.fingerprintRoot),
            )
            .slice(0, 10),
          qualificationState: qualificationState(values),
        };
      }),
  };
  return { ...body, trendRoot: jsonRoot(body) };
}

function receiptFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.json'))
        files.push(absolute);
    }
  }
  walk(path.resolve(directory));
  return files.sort();
}

export function decideQualification({ plan, receipts, trends }) {
  validatePlan(plan);
  for (const receipt of receipts) validateCapabilityReceipt(receipt);
  for (const trend of trends) {
    if (trend?.schema !== TREND_SCHEMA) throw new Error('trend is invalid');
    assertRoot(trend.trendRoot, 'trend root');
    const { trendRoot, ...trendBody } = trend;
    if (jsonRoot(trendBody) !== trendRoot)
      throw new Error('trend root mismatch');
  }
  let state = 'not-requested';
  let blocking = false;
  const reasons = [];
  if (plan.qualification.requested) {
    const current = receipts.filter(
      (receipt) => receipt.plan.root === plan.planRoot,
    );
    const expected = plan.fixtures.length * plan.trialsPerFixture;
    if (current.length < expected) {
      state = 'insufficient-history';
      reasons.push('bounded-trials-incomplete');
    } else if (current.some((receipt) => receipt.outcome.blocking)) {
      state = 'hold';
      blocking = true;
      reasons.push('blocking-integrity-or-sandbox-failure');
    } else if (current.every(receiptPasses)) {
      state = 'qualified';
      reasons.push('all-bounded-trials-passed');
    } else {
      state = 'hold';
      reasons.push('advisory-capability-dimension-not-passed');
    }
  } else {
    reasons.push(plan.skipReason || 'plan-does-not-request-qualification');
  }
  const body = {
    schema: QUALIFICATION_SCHEMA,
    planRoot: plan.planRoot,
    state,
    blocking,
    reasons,
    receiptRoots: receipts.map(({ receiptRoot }) => receiptRoot).sort(),
    trendRoots: trends.map(({ trendRoot }) => trendRoot).sort(),
    automaticPromotion: false,
    requiredGate: false,
    issueAdmitted: false,
  };
  return { ...body, decisionRoot: jsonRoot(body) };
}

function walkArtifactFiles(root) {
  const files = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink())
        throw new Error('retained artifacts may not contain symlinks');
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(absolute);
      else throw new Error('retained artifacts contain an unsupported entry');
    }
  }
  walk(root);
  return files.sort();
}

export function auditArtifacts(root) {
  const absoluteRoot = path.resolve(root);
  const rows = walkArtifactFiles(absoluteRoot).map((file) => {
    const relative = path
      .relative(absoluteRoot, file)
      .split(path.sep)
      .join('/');
    if (!ALLOWED_ARTIFACT_PATHS.some((pattern) => pattern.test(relative)))
      throw new Error(`retained artifact path is not allowlisted: ${relative}`);
    const stats = fs.statSync(file);
    if (stats.size > ARTIFACT_FILE_LIMIT)
      throw new Error(`retained artifact exceeds its file budget: ${relative}`);
    const value = readJson(file);
    assertPrivacyBounded(value, `retained artifact ${relative}`);
    return {
      path: relative,
      bytes: stats.size,
      root: `sha256:${crypto
        .createHash('sha256')
        .update(fs.readFileSync(file))
        .digest('hex')}`,
    };
  });
  const totalBytes = rows.reduce((total, row) => total + row.bytes, 0);
  if (totalBytes > ARTIFACT_TOTAL_LIMIT)
    throw new Error('retained artifacts exceed the total byte budget');
  const body = {
    schema: ARTIFACT_AUDIT_SCHEMA,
    files: rows,
    fileCount: rows.length,
    totalBytes,
    fileByteLimit: ARTIFACT_FILE_LIMIT,
    totalByteLimit: ARTIFACT_TOTAL_LIMIT,
    allowlistVersion: 1,
  };
  return { ...body, auditRoot: jsonRoot(body) };
}

function parseOptions(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (!arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`);
    values[arg.slice(2)] = argv[++index] || '';
  }
  return values;
}

function required(options, names) {
  for (const name of names)
    if (!options[name]) throw new Error(`--${name} is required`);
}

function runCli(argv) {
  const [operation, ...rest] = argv.filter((arg) => arg !== '--');
  const options = parseOptions(rest);
  if (operation === 'create') {
    required(options, [
      'plan',
      'report',
      'classification',
      'dogfood-receipt',
      'source-tree',
      'runner',
      'trial',
      'observed-at',
      'output',
    ]);
    const receipt = createCapabilityReceipt({
      plan: readJson(options.plan),
      report: readJson(options.report),
      classification: readJson(options.classification),
      dogfoodReceipt: readJson(options['dogfood-receipt']),
      sourceTree: options['source-tree'],
      runner: options.runner,
      trial: Number.parseInt(options.trial, 10),
      observedAt: options['observed-at'],
    });
    writeJson(options.output, receipt);
    return {
      operation,
      receiptRoot: receipt.receiptRoot,
      blocking: receipt.outcome.blocking,
    };
  }
  if (operation === 'store') {
    required(options, ['receipt', 'state-root', 'output']);
    const stored = storeCapabilityReceipt(
      readJson(options.receipt),
      path.resolve(options['state-root']),
    );
    writeJson(options.output, stored);
    return { operation, ...stored };
  }
  if (operation === 'trend') {
    required(options, ['state-root', 'days', 'as-of', 'output']);
    const trend = buildTrend({
      stateRoot: path.resolve(options['state-root']),
      days: Number.parseInt(options.days, 10),
      asOf: options['as-of'],
    });
    writeJson(options.output, trend);
    return {
      operation,
      trendRoot: trend.trendRoot,
      selectedReceiptCount: trend.selectedReceiptCount,
    };
  }
  if (operation === 'qualify') {
    required(options, ['plan', 'receipts', 'trend-14', 'trend-30', 'output']);
    const decision = decideQualification({
      plan: readJson(options.plan),
      receipts: receiptFiles(options.receipts).map(readJson),
      trends: [readJson(options['trend-14']), readJson(options['trend-30'])],
    });
    writeJson(options.output, decision);
    return {
      operation,
      state: decision.state,
      blocking: decision.blocking,
      decisionRoot: decision.decisionRoot,
    };
  }
  if (operation === 'audit-artifacts') {
    required(options, ['root', 'output']);
    const audit = auditArtifacts(options.root);
    writeJson(options.output, audit);
    return {
      operation,
      auditRoot: audit.auditRoot,
      fileCount: audit.fileCount,
      totalBytes: audit.totalBytes,
    };
  }
  throw new Error(`unknown capability operation: ${operation || '<empty>'}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(runCli(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 2;
  }
}
