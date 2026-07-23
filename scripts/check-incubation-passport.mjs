#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONTRACT_PATH = 'framework/incubation/incubation-passport.contract.json';
const CONTRACT_SCHEMA_PATH =
  'framework/incubation/schema/incubation-passport-contract-v1.schema.json';

function loadJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

function issue(key, detail) {
  return { key, detail };
}

function pathExists(root, relativePath) {
  return (
    typeof relativePath === 'string' &&
    fs.existsSync(path.join(root, relativePath))
  );
}

function registeredSchemaPaths(authority) {
  const paths = new Set();
  for (const entry of authority.authorities || []) {
    if (entry.owner !== 'flatbuffers') continue;
    if (entry.declaration) paths.add(entry.declaration);
    if (entry.derived_schema) paths.add(entry.derived_schema);
  }
  return paths;
}

function authorityIdentities(authority) {
  return new Map(
    (authority.authorities || []).map((entry) => [entry.identity, entry.owner]),
  );
}

export function trackedSchemas(root = ROOT) {
  const result = spawnSync('git', ['ls-files', '-z', '*.fbs', '*.bfbs'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `git ls-files failed: ${(result.stderr || result.stdout || '').trim()}`,
    );
  }
  return result.stdout.split('\0').filter(Boolean).sort();
}

export function collectIssues({
  root = ROOT,
  registry,
  authority,
  schemas,
  today = utcDate(),
}) {
  const issues = [];
  const registered = registeredSchemaPaths(authority);
  const identities = authorityIdentities(authority);

  for (const schemaPath of [...schemas].sort()) {
    if (!registered.has(schemaPath)) {
      issues.push(
        issue(
          `unregistered-schema:${schemaPath}`,
          `${schemaPath} has no FlatBuffers schema-authority entry`,
        ),
      );
    }
  }

  const passportIds = new Set();
  for (const passport of registry.passports || []) {
    if (passportIds.has(passport.id)) {
      issues.push(
        issue(
          `duplicate-passport:${passport.id}`,
          `${passport.id} appears more than once`,
        ),
      );
    }
    passportIds.add(passport.id);

    const referencedPaths = [
      passport.anchor?.authorityRef,
      ...(passport.incubation?.implementationPaths || []),
      ...(passport.identityProtocol?.implementations || []).map(
        (entry) => entry.path,
      ),
      ...(passport.identityProtocol?.vectors || []),
    ];
    for (const referencedPath of new Set(referencedPaths)) {
      if (referencedPath && !pathExists(root, referencedPath)) {
        issues.push(
          issue(
            `missing-passport-path:${passport.id}:${referencedPath}`,
            `${passport.id} references missing path ${referencedPath}`,
          ),
        );
      }
    }

    const ownership = passport.schemaOwnership || {};
    if (ownership.class === 'flatbuffers' || ownership.class === 'hana') {
      if (identities.get(ownership.identity) !== ownership.class) {
        issues.push(
          issue(
            `schema-owner-mismatch:${passport.id}`,
            `${passport.id} does not resolve ${ownership.identity} to ${ownership.class} in schema-authority.json`,
          ),
        );
      }
    } else if (ownership.class === 'profile-contract-world') {
      if (!pathExists(root, ownership.registryRef)) {
        issues.push(
          issue(
            `schema-owner-mismatch:${passport.id}`,
            `${passport.id} contract world does not exist`,
          ),
        );
      } else {
        const world = fs.readFileSync(
          path.join(root, ownership.registryRef),
          'utf8',
        );
        if (!world.includes(`\"${ownership.identity}\"`)) {
          issues.push(
            issue(
              `schema-owner-mismatch:${passport.id}`,
              `${passport.id} identity ${ownership.identity} is absent from its contract world`,
            ),
          );
        }
      }
    }

    if (passport.anchor?.type === 'runtime') {
      if (passport.persistence?.policy !== 'native-journal-only') {
        issues.push(
          issue(
            `runtime-persistence-policy:${passport.id}`,
            `${passport.id} runtime persistence must be native-journal-only`,
          ),
        );
      }
      if (
        passport.incubation?.state === 'incubating' &&
        passport.incubation?.deadline &&
        passport.incubation.deadline < today
      ) {
        issues.push(
          issue(
            `overdue-runtime-incubation:${passport.id}`,
            `${passport.id} deadline ${passport.incubation.deadline} is before ${today}`,
          ),
        );
      }
    }

    if (passport.identityProtocol?.mintsRoots) {
      const languages = new Set(
        (passport.identityProtocol.implementations || []).map(
          (entry) => entry.language,
        ),
      );
      const vectors = passport.identityProtocol.vectors || [];
      const complete =
        languages.size >= 2 &&
        vectors.length > 0 &&
        vectors.every((vectorPath) => pathExists(root, vectorPath));
      if (!complete) {
        issues.push(
          issue(
            `identity-protocol-conformance-missing:${passport.id}`,
            `${passport.id} requires two implementation languages and existing golden vectors`,
          ),
        );
      }
    }
  }

  return issues.sort((left, right) => left.key.localeCompare(right.key));
}

export function compareBaseline(issues, baseline, today = utcDate()) {
  const currentByKey = new Map(issues.map((entry) => [entry.key, entry]));
  const baselineByKey = new Map();
  const malformedBaseline = [];
  for (const entry of baseline.issues || []) {
    if (
      !entry.key ||
      !entry.owner ||
      !entry.rationale ||
      !entry.expiresOn ||
      !entry.removalCondition
    ) {
      malformedBaseline.push(entry.key || '<missing-key>');
      continue;
    }
    if (baselineByKey.has(entry.key)) malformedBaseline.push(entry.key);
    baselineByKey.set(entry.key, entry);
  }

  return {
    newIssues: issues.filter((entry) => !baselineByKey.has(entry.key)),
    staleBaseline: [...baselineByKey.values()].filter(
      (entry) => !currentByKey.has(entry.key),
    ),
    expiredBaseline: [...baselineByKey.values()].filter(
      (entry) => entry.expiresOn < today,
    ),
    malformedBaseline,
  };
}

function validationErrors(validate) {
  return (validate.errors || []).map(
    (entry) => `${entry.instancePath || '/'} ${entry.message || 'is invalid'}`,
  );
}

export function validateRepository(root = ROOT, today = utcDate()) {
  const contract = loadJson(root, CONTRACT_PATH);
  const contractSchema = loadJson(root, CONTRACT_SCHEMA_PATH);
  const registry = loadJson(root, contract.registry);
  const registrySchema = loadJson(root, contract.registrySchema);
  const baseline = loadJson(root, contract.baseline);
  const authority = loadJson(root, contract.schemaAuthority);

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addFormat('date', /^\d{4}-\d{2}-\d{2}$/);
  const validateContract = ajv.compile(contractSchema);
  const validateRegistry = ajv.compile(registrySchema);
  const structuralErrors = [];
  if (!validateContract(contract)) {
    structuralErrors.push(
      ...validationErrors(validateContract).map((entry) => `contract ${entry}`),
    );
  }
  if (!validateRegistry(registry)) {
    structuralErrors.push(
      ...validationErrors(validateRegistry).map((entry) => `registry ${entry}`),
    );
  }
  if (registry.contract !== CONTRACT_PATH) {
    structuralErrors.push(`registry contract must point to ${CONTRACT_PATH}`);
  }

  const issues = collectIssues({
    root,
    registry,
    authority,
    schemas: trackedSchemas(root),
    today,
  });
  const comparison = compareBaseline(issues, baseline, today);
  const ok =
    structuralErrors.length === 0 &&
    comparison.newIssues.length === 0 &&
    comparison.staleBaseline.length === 0 &&
    comparison.expiredBaseline.length === 0 &&
    comparison.malformedBaseline.length === 0;
  return {
    schema: 'kungfu.incubation-passport.check/v1',
    ok,
    today,
    currentIssueCount: issues.length,
    acceptedIssueCount: issues.length - comparison.newIssues.length,
    structuralErrors,
    ...comparison,
  };
}

function renderFailure(result) {
  const lines = ['[incubation-passport] governance violations:'];
  for (const entry of result.structuralErrors)
    lines.push(`  structural: ${entry}`);
  for (const entry of result.newIssues)
    lines.push(`  new: ${entry.key} (${entry.detail})`);
  for (const entry of result.staleBaseline)
    lines.push(`  stale-baseline: ${entry.key}`);
  for (const entry of result.expiredBaseline)
    lines.push(`  expired-baseline: ${entry.key} (${entry.expiresOn})`);
  for (const entry of result.malformedBaseline)
    lines.push(`  malformed-baseline: ${entry}`);
  return lines.join('\n');
}

const invoked = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invoked) {
  const json = process.argv.includes('--json');
  const todayIndex = process.argv.indexOf('--today');
  const today = todayIndex >= 0 ? process.argv[todayIndex + 1] : utcDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today || '')) {
    console.error('[incubation-passport] --today requires YYYY-MM-DD');
    process.exit(2);
  }
  const result = validateRepository(ROOT, today);
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (result.ok)
    console.log(
      `[incubation-passport] PASS (${result.acceptedIssueCount} exact baseline issues remain visible)`,
    );
  else console.error(renderFailure(result));
  process.exit(result.ok ? 0 : 1);
}
