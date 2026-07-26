#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPERATION_SCHEMA = 'buildchain.cache-operation-receipt/v1';
const SET_SCHEMA = 'buildchain.cache-evidence-set/v1';
const ALPHA_SCHEMA = 'kungfu.alpha-cache-evidence/v1';
const OUTCOMES = new Set([
  'hit',
  'miss',
  'partial',
  'bypassed',
  'poisoned',
  'unavailable',
]);
const METRICS = {
  lookupDuration: 'ms',
  restoreDuration: 'ms',
  saveDuration: 'ms',
  restoredBytes: 'bytes',
  writtenBytes: 'bytes',
  savedTime: 'ms',
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function digest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;
}

function exactRoot(value, label) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(String(value || '')))
    throw new Error(`${label} must be a sha256 root`);
  return value;
}

function exactSha(value, label) {
  if (!/^[0-9a-f]{40}$/u.test(String(value || '')))
    throw new Error(`${label} must be a 40-character Git SHA`);
  return value;
}

function verifyMetric(metric, name) {
  if (metric?.unit !== METRICS[name])
    throw new Error(`cache metric ${name} unit drifted`);
  if (!['observed', 'unavailable', 'not-applicable'].includes(metric.status))
    throw new Error(`cache metric ${name} status drifted`);
  if (metric.status === 'observed') {
    if (!Number.isFinite(metric.value) || metric.value < 0)
      throw new Error(`cache metric ${name} has an invalid observed value`);
    exactRoot(metric.evidenceRoot, `cache metric ${name} evidence root`);
    if (!metric.source) throw new Error(`cache metric ${name} omitted source`);
    if (
      name === 'savedTime' &&
      !['producer-measured', 'provider-reported'].includes(metric.method)
    )
      throw new Error('cache saved time is not backed by producer evidence');
  } else if (metric.value !== null) {
    throw new Error(`cache metric ${name} fabricated an unavailable value`);
  }
}

function verifyOperation(operation) {
  if (operation?.schema !== OPERATION_SCHEMA)
    throw new Error('cache operation schema mismatch');
  const { receiptRoot, ...body } = operation;
  if (receiptRoot !== digest(body))
    throw new Error('cache operation receipt root mismatch');
  if (!OUTCOMES.has(operation.outcome))
    throw new Error('cache operation outcome drifted');
  exactRoot(operation.evidence?.root, 'cache operation producer evidence');
  for (const name of Object.keys(METRICS))
    verifyMetric(operation.metrics?.[name], name);
}

function verifySet(set) {
  if (set?.schema !== SET_SCHEMA)
    throw new Error('cache evidence set schema mismatch');
  const { evidenceRoot, ...body } = set;
  if (evidenceRoot !== digest(body))
    throw new Error('cache evidence set root mismatch');
  exactSha(set.sourceCommit, 'cache set source commit');
  exactSha(set.sourceTree, 'cache set source tree');
  exactSha(set.runtimeCommit, 'cache set runtime commit');
  if (!Array.isArray(set.operations) || set.operations.length === 0)
    throw new Error('cache evidence set has no operations');
  set.operations.forEach(verifyOperation);
  const operationIds = set.operations.map(({ operationId }) => operationId);
  if (operationIds.length !== new Set(operationIds).size)
    throw new Error('cache evidence set has duplicate operations');
}

function metricSummary(sets) {
  return Object.fromEntries(
    Object.entries(METRICS).map(([name, unit]) => {
      const values = sets.flatMap(({ operations }) =>
        operations.map(({ metrics }) => metrics[name]),
      );
      const observed = values.filter(({ status }) => status === 'observed');
      return [
        name,
        {
          unit,
          observedCount: observed.length,
          unavailableCount: values.filter(
            ({ status }) => status === 'unavailable',
          ).length,
          notApplicableCount: values.filter(
            ({ status }) => status === 'not-applicable',
          ).length,
          observedTotal:
            observed.length > 0
              ? observed.reduce((sum, { value }) => sum + value, 0)
              : null,
        },
      ];
    }),
  );
}

export function createAlphaCacheEvidence({ preflightReceipt, sets }) {
  if (
    preflightReceipt?.schema !==
      'kungfu.alpha-promotion-preflight-receipt/v1' ||
    preflightReceipt.kind !== 'aggregate'
  )
    throw new Error(
      'Alpha cache evidence requires aggregate preflight receipt',
    );
  if (!Array.isArray(sets) || sets.length !== 3)
    throw new Error(
      'Alpha cache evidence requires exactly three platform sets',
    );
  sets.forEach(verifySet);
  const byPlatform = new Map();
  const binding = preflightReceipt.binding || {};
  for (const set of sets) {
    if (byPlatform.has(set.platform))
      throw new Error(`duplicate cache platform: ${set.platform}`);
    if (set.sourceTree !== binding.sourceTree)
      throw new Error(`${set.platform} cache source tree drifted`);
    const platformReceipt = preflightReceipt.platforms?.find(
      ({ platform }) => platform === set.platform,
    );
    if (!platformReceipt)
      throw new Error(`cache platform is outside preflight: ${set.platform}`);
    for (const operation of set.operations) {
      if (operation.platform !== set.platform)
        throw new Error(`${set.platform} cache operation platform drifted`);
      for (const root of [
        'dependencyLockRoot',
        'toolchainRoot',
        'policyRoot',
      ]) {
        if (operation.bindings?.[root] !== binding[root])
          throw new Error(
            `${set.platform} cache ${root} is missing or incompatible`,
          );
      }
      if (operation.bindings?.sourceTree !== binding.sourceTree)
        throw new Error(`${set.platform} cache operation source tree drifted`);
      if (operation.outcome === 'poisoned')
        throw new Error(`${set.platform} cache evidence is poisoned`);
    }
    const requiredIds = [
      `compiler-cache:${set.platform}`,
      `source-checkout:${set.platform}`,
    ];
    for (const operationId of requiredIds) {
      if (
        !set.operations.some(
          (operation) => operation.operationId === operationId,
        )
      )
        throw new Error(`${set.platform} omitted ${operationId}`);
    }
    byPlatform.set(set.platform, {
      set,
      preflightPlatformReceiptRoot: platformReceipt.receiptRoot,
    });
  }
  const expectedPlatforms = preflightReceipt.platforms.map(
    ({ platform }) => platform,
  );
  if (
    JSON.stringify([...byPlatform.keys()].sort()) !==
    JSON.stringify([...expectedPlatforms].sort())
  )
    throw new Error('cache platform coverage drifted from preflight');
  const orderedSets = expectedPlatforms.map((platform) =>
    byPlatform.get(platform),
  );
  const outcomes = Object.fromEntries(
    [...OUTCOMES].map((outcome) => [
      outcome,
      sets
        .flatMap(({ operations }) => operations)
        .filter((operation) => operation.outcome === outcome).length,
    ]),
  );
  const body = {
    schema: ALPHA_SCHEMA,
    preflightReceiptRoot: preflightReceipt.receiptRoot,
    binding: {
      sourceCommit: binding.sourceCommit,
      sourceTree: binding.sourceTree,
      workflowRoot: binding.workflowRoot,
      gateRoot: binding.gateRoot,
      dependencyLockRoot: binding.dependencyLockRoot,
      toolchainRoot: binding.toolchainRoot,
      policyRoot: binding.policyRoot,
    },
    platforms: orderedSets,
    summary: {
      outcomes,
      metrics: metricSummary(sets),
    },
  };
  return { ...body, evidenceRoot: digest(body) };
}

export function verifyAlphaCacheEvidence({ evidence, preflightReceipt }) {
  const authority = preflightReceipt || {
    schema: 'kungfu.alpha-promotion-preflight-receipt/v1',
    kind: 'aggregate',
    receiptRoot: evidence?.preflightReceiptRoot,
    binding: evidence?.binding,
    platforms: (evidence?.platforms || []).map(
      ({ set, preflightPlatformReceiptRoot }) => ({
        platform: set?.platform,
        receiptRoot: preflightPlatformReceiptRoot,
      }),
    ),
  };
  const rebuilt = createAlphaCacheEvidence({
    preflightReceipt: authority,
    sets: evidence?.platforms?.map(({ set }) => set),
  });
  if (
    evidence?.schema !== ALPHA_SCHEMA ||
    JSON.stringify(canonical(rebuilt)) !== JSON.stringify(canonical(evidence))
  )
    throw new Error('Alpha cache evidence root or normalization drifted');
  return evidence;
}

function readSets(directory) {
  const files = [];
  const pending = [path.resolve(directory)];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name === 'diagnostics.json')
        files.push(target);
    }
  }
  return files
    .sort()
    .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')).cacheEvidence)
    .filter(Boolean);
}

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!flag?.startsWith('--') || index + 1 >= rest.length)
      throw new Error(`invalid cache evidence option: ${flag || '<missing>'}`);
    options[flag.slice(2)] = rest[index + 1];
  }
  return { command, options };
}

function main(argv = process.argv.slice(2)) {
  const { command, options } = parse(argv);
  const preflightReceipt = JSON.parse(
    fs.readFileSync(path.resolve(options.preflight), 'utf8'),
  );
  if (command === 'write') {
    const evidence = createAlphaCacheEvidence({
      preflightReceipt,
      sets: readSets(options.diagnostics),
    });
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    fs.writeFileSync(
      path.resolve(options.out),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    return;
  }
  if (command === 'verify') {
    verifyAlphaCacheEvidence({
      evidence: JSON.parse(
        fs.readFileSync(path.resolve(options.evidence), 'utf8'),
      ),
      preflightReceipt,
    });
    return;
  }
  throw new Error(`unknown Alpha cache evidence command: ${command}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
