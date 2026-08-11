#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_PATH = path.join(ROOT, 'kungfu-skill.contract.json');
const SCHEMA_PATH = path.join(
  ROOT,
  'schema',
  'skill-definition-v2.schema.json',
);
const FIXTURES_PATH = path.join(ROOT, 'fixtures', 'contract-v2', 'cases.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

function root(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex')}`;
}

function mergePatch(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return structuredClone(patch);
  }
  const result =
    target && typeof target === 'object' && !Array.isArray(target)
      ? structuredClone(target)
      : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

function dependencyRefs(document) {
  const refs = new Set();
  for (const row of document.dependencies?.kfx || []) {
    refs.add(`kfx:${row.key}@${row.revision}#${row.root}`);
  }
  for (const row of document.dependencies?.profiles || []) {
    refs.add(`profile:${row.id}@${row.revision}#${row.root}`);
  }
  return refs;
}

function semanticFailure(document) {
  const work = document.scope?.work;
  if (
    !document.scope?.distribution ||
    !Array.isArray(document.scope?.appliesTo) ||
    document.scope.appliesTo.length === 0 ||
    !work?.binding ||
    work.selectionAuthority !== 'kungfu-work' ||
    work.completionAuthority !== 'kungfu-work'
  ) {
    return 'ambiguous-scope';
  }

  if (
    document.compatibility?.history !== 'preserve-original-meaning' ||
    document.recovery?.history !== 'preserve-roots-receipts-and-work-meaning'
  ) {
    return 'history-reinterpretation';
  }

  const authority = document.authority || {};
  if (
    authority.work !== 'reference-only' ||
    authority.profile !== 'reference-only' ||
    authority.factEpisode !== 'reference-only' ||
    authority.kfd !== 'reference-only' ||
    authority.kfx !== 'reference-only'
  ) {
    return 'duplicate-authority';
  }

  const kfx = document.dependencies?.kfx || [];
  const profiles = document.dependencies?.profiles || [];
  const effects = document.effects || {};
  if (
    document.class === 'instruction-only' &&
    (kfx.length > 0 ||
      profiles.length > 0 ||
      effects.mode !== 'none' ||
      authority.capability !== 'none')
  ) {
    return 'class-capability-mismatch';
  }
  if (
    document.class === 'operational' &&
    (kfx.length === 0 ||
      profiles.length > 0 ||
      authority.capability !== 'separate-kfx-admission-required')
  ) {
    return 'class-capability-mismatch';
  }
  if (document.class === 'domain' && profiles.length === 0) {
    return 'class-capability-mismatch';
  }
  if (
    document.class === 'domain' &&
    kfx.length > 0 &&
    authority.capability !== 'separate-kfx-admission-required'
  ) {
    return 'class-capability-mismatch';
  }

  const members = document.content?.members || [];
  const memberPaths = members.map((row) => row.path);
  if (
    !memberPaths.includes(document.content?.entrypoint) ||
    new Set(memberPaths).size !== memberPaths.length ||
    [...memberPaths].sort().some((value, index) => value !== memberPaths[index])
  ) {
    return 'incomplete-content-root';
  }
  const closureRoot = root({
    schema: 'kungfu.skill-content-closure/v2',
    entrypoint: document.content?.entrypoint,
    members,
  });
  if (
    document.content?.root !== closureRoot ||
    document.identity?.contentRoot !== document.content?.root
  ) {
    return 'content-root-mismatch';
  }

  const predecessor = document.compatibility?.predecessor;
  if (predecessor === null && document.identity?.revision !== 1) {
    return 'mutable-identity';
  }
  if (
    predecessor &&
    (predecessor.key !== document.identity?.key ||
      predecessor.revision + 1 !== document.identity?.revision ||
      predecessor.contentRoot === document.identity?.contentRoot)
  ) {
    return 'mutable-identity';
  }

  const refs = dependencyRefs(document);
  if ((effects.declarations || []).some((row) => !refs.has(row.authorityRef))) {
    return 'undeclared-dependency';
  }
  const capabilityRequests = kfx.flatMap((row) => row.capabilityRequests || []);
  if (
    capabilityRequests.length > 0 &&
    (effects.mode === 'none' || effects.declarations?.length === 0)
  ) {
    return 'hidden-external-effect';
  }

  return null;
}

function main() {
  const contract = readJson(CONTRACT_PATH);
  const schema = readJson(SCHEMA_PATH);
  const fixtures = readJson(FIXTURES_PATH);
  const wrapperAjv = new Ajv2020({ allErrors: true, strict: false });
  const validateContract = wrapperAjv.compile(contract.contractSchema);
  if (!validateContract(contract)) {
    throw new Error(
      `Skill contract wrapper is invalid: ${wrapperAjv.errorsText(validateContract.errors)}`,
    );
  }
  if (
    contract.version !== 2 ||
    contract.schemaFiles?.definitionV2?.schema !== schema.$id
  ) {
    throw new Error('Skill v2 contract wrapper does not bind the v2 schema');
  }
  const definitionAjv = new Ajv2020({ allErrors: true, strict: true });
  const validateDefinition = definitionAjv.compile(schema);
  const results = [];
  for (const fixture of fixtures.cases) {
    const document = mergePatch(fixtures.base, fixture.patch);
    const semantic = semanticFailure(document);
    const schemaValid = validateDefinition(document);
    const actual = semantic || (schemaValid ? 'valid' : 'schema-invalid');
    if (actual !== fixture.expected) {
      const errors = schemaValid
        ? []
        : structuredClone(validateDefinition.errors || []);
      throw new Error(
        `${fixture.id}: expected ${fixture.expected}, got ${actual}; ${JSON.stringify(errors)}`,
      );
    }
    results.push({ id: fixture.id, result: actual });
  }
  const accepted = results.filter((row) => row.result === 'valid').length;
  const rejected = results.length - accepted;
  process.stdout.write(
    `${JSON.stringify(
      {
        schema: 'kungfu.skill-v2-contract-check/v1',
        verdict: 'pass',
        contractRoot: root(contract),
        definitionSchemaRoot: root(schema),
        fixtureRoot: root(fixtures),
        accepted,
        rejected,
        results,
      },
      null,
      2,
    )}\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(
    `[skill-contract-v2] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
