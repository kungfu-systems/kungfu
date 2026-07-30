#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const QUALIFIED_CORE_USAGE_SCHEMA =
  'shifu.qualified-assignment-core-usage/v1';
export const QUALIFIED_CORE_USAGE_SUMMARY_SCHEMA =
  'shifu.qualified-assignment-core-usage-summary/v1';

const SHA = /^[0-9a-f]{40}$/u;
const ROOT = /^sha256:[0-9a-f]{64}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const PHASES = new Set([
  'checkout',
  'discovery',
  'localLookup',
  'publication',
  'remoteLookup',
  'retention',
  'total',
  'transfer',
  'verification',
  'verificationAndRetention',
]);
const MAX_OBSERVATION_FILES = 10_000;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function root(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;
}

function exactKeys(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...keys].sort())
  ) {
    throw new Error(`Qualified Core usage ${label} fields are invalid`);
  }
}

function optionalRoot(value, label) {
  if (value !== null && !ROOT.test(value || '')) {
    throw new Error(`Qualified Core usage ${label} is invalid`);
  }
}

export function validateQualifiedCoreUsage(observation) {
  exactKeys(
    observation,
    [
      'schema',
      'authority',
      'recordedAt',
      'result',
      'reason',
      'phases',
      'repository',
      'sourceCommit',
      'compatibilityIdentity',
      'platform',
      'architecture',
      'pythonAbi',
      'artifact',
      'fallback',
      'observationRoot',
    ],
    'observation',
  );
  const { observationRoot, ...body } = observation;
  if (
    observation.schema !== QUALIFIED_CORE_USAGE_SCHEMA ||
    observation.authority !== 'optimization-evidence-only' ||
    observationRoot !== root(body) ||
    !ROOT.test(observationRoot)
  ) {
    throw new Error('Qualified Core usage root or authority is invalid');
  }
  if (
    Number.isNaN(Date.parse(observation.recordedAt)) ||
    !IDENTIFIER.test(observation.result || '') ||
    !IDENTIFIER.test(observation.reason || '') ||
    !REPOSITORY.test(observation.repository || '') ||
    !SHA.test(observation.sourceCommit || '') ||
    !IDENTIFIER.test(observation.platform || '') ||
    !IDENTIFIER.test(observation.architecture || '') ||
    !/^cp[0-9]{2,4}$/u.test(observation.pythonAbi || '')
  ) {
    throw new Error('Qualified Core usage bounded identity is invalid');
  }
  optionalRoot(observation.compatibilityIdentity, 'compatibility identity');
  exactKeys(observation.fallback, ['required', 'command'], 'fallback');
  if (
    typeof observation.fallback.required !== 'boolean' ||
    !['', './shifu build:core'].includes(observation.fallback.command)
  ) {
    throw new Error('Qualified Core usage fallback is invalid');
  }
  exactKeys(observation.phases, Object.keys(observation.phases), 'phases');
  for (const [name, elapsedMs] of Object.entries(observation.phases)) {
    if (
      !PHASES.has(name) ||
      !Number.isSafeInteger(elapsedMs) ||
      elapsedMs < 0
    ) {
      throw new Error('Qualified Core usage phase timing is invalid');
    }
  }
  if (observation.artifact !== null) {
    exactKeys(
      observation.artifact,
      [
        'transportProvider',
        'artifactId',
        'artifactRoot',
        'manifestRoot',
        'objectRoot',
      ],
      'artifact',
    );
    if (
      !IDENTIFIER.test(observation.artifact.transportProvider || '') ||
      (observation.artifact.artifactId !== null &&
        (!Number.isSafeInteger(observation.artifact.artifactId) ||
          observation.artifact.artifactId < 1))
    ) {
      throw new Error('Qualified Core usage artifact transport is invalid');
    }
    for (const field of ['artifactRoot', 'manifestRoot', 'objectRoot']) {
      optionalRoot(observation.artifact[field], `artifact ${field}`);
    }
  }
  return observation;
}

export function qualifiedCoreUsageObservation(input) {
  const body = {
    schema: QUALIFIED_CORE_USAGE_SCHEMA,
    authority: 'optimization-evidence-only',
    recordedAt: input.recordedAt,
    result: input.result,
    reason: input.reason,
    phases: input.phases,
    repository: input.repository,
    sourceCommit: input.sourceCommit,
    compatibilityIdentity: input.compatibilityIdentity || null,
    platform: input.platform,
    architecture: input.architecture,
    pythonAbi: input.pythonAbi,
    artifact: input.artifact || null,
    fallback: input.fallback,
  };
  return validateQualifiedCoreUsage({
    ...body,
    observationRoot: root(body),
  });
}

function observationPath(cacheRoot, observationRoot) {
  const digest = observationRoot.slice('sha256:'.length);
  return path.join(
    cacheRoot,
    'observations',
    'sha256',
    digest.slice(0, 2),
    `${digest}.json`,
  );
}

export function appendQualifiedCoreUsage(cacheRoot, observation) {
  validateQualifiedCoreUsage(observation);
  const destination = observationPath(cacheRoot, observation.observationRoot);
  const bytes = `${JSON.stringify(observation, null, 2)}\n`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const staging = path.join(cacheRoot, 'observations', 'staging');
  fs.mkdirSync(staging, { recursive: true });
  const temporary = path.join(
    staging,
    `${observation.observationRoot.slice('sha256:'.length)}-${process.pid}-${crypto.randomUUID()}.json`,
  );
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    try {
      fs.linkSync(temporary, destination);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (fs.readFileSync(destination, 'utf8') !== bytes) {
        throw new Error('Qualified Core usage immutable object drift');
      }
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { observationRoot: observation.observationRoot, path: destination };
}

function increment(target, key) {
  target[key] = (target[key] || 0) + 1;
}

export function summarizeQualifiedCoreUsage(cacheRoot, currentCheckout = null) {
  const rootDirectory = path.join(cacheRoot, 'observations', 'sha256');
  const observations = [];
  let invalidRecords = 0;
  let scannedRecords = 0;
  let scanTruncated = false;
  if (
    fs.existsSync(rootDirectory) &&
    (!fs.lstatSync(rootDirectory).isDirectory() ||
      fs.lstatSync(rootDirectory).isSymbolicLink())
  ) {
    invalidRecords += 1;
  } else if (fs.existsSync(rootDirectory)) {
    prefixes: for (const prefix of fs.readdirSync(rootDirectory).sort()) {
      if (!/^[0-9a-f]{2}$/u.test(prefix)) {
        invalidRecords += 1;
        continue;
      }
      const directory = path.join(rootDirectory, prefix);
      if (!fs.lstatSync(directory).isDirectory()) {
        invalidRecords += 1;
        continue;
      }
      for (const name of fs.readdirSync(directory).sort()) {
        scannedRecords += 1;
        if (scannedRecords > MAX_OBSERVATION_FILES) {
          invalidRecords += 1;
          scanTruncated = true;
          break prefixes;
        }
        if (!/^[0-9a-f]{64}\.json$/u.test(name)) {
          invalidRecords += 1;
          continue;
        }
        try {
          const recordPath = path.join(directory, name);
          const stat = fs.lstatSync(recordPath);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error('observation path is not a regular file');
          }
          const observation = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
          validateQualifiedCoreUsage(observation);
          if (
            `${observation.observationRoot.slice('sha256:'.length)}.json` !==
            name
          ) {
            throw new Error('observation filename drift');
          }
          observations.push(observation);
        } catch {
          invalidRecords += 1;
        }
      }
    }
  }
  const counts = { results: {}, reasons: {}, platforms: {} };
  for (const observation of observations) {
    increment(counts.results, observation.result);
    increment(counts.reasons, observation.reason);
    increment(
      counts.platforms,
      `${observation.platform}/${observation.architecture}/${observation.pythonAbi}`,
    );
  }
  const recent = observations
    .sort((left, right) =>
      `${left.recordedAt}/${left.observationRoot}`.localeCompare(
        `${right.recordedAt}/${right.observationRoot}`,
      ),
    )
    .slice(-20)
    .map((observation) => ({
      observationRoot: observation.observationRoot,
      recordedAt: observation.recordedAt,
      result: observation.result,
      reason: observation.reason,
      repository: observation.repository,
      sourceCommit: observation.sourceCommit,
      platform: observation.platform,
      architecture: observation.architecture,
      pythonAbi: observation.pythonAbi,
      artifactRoot: observation.artifact?.artifactRoot || null,
    }));
  return {
    schema: QUALIFIED_CORE_USAGE_SUMMARY_SCHEMA,
    ok: invalidRecords === 0,
    authority: 'optimization-evidence-only',
    currentCheckout,
    totals: {
      observations: observations.length,
      invalidRecords,
      scannedRecords,
      scanTruncated,
    },
    counts,
    recent,
  };
}
