#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIFU_DOCS = path.join(ROOT, 'docs', 'shifu');
const CONTRACT_PATH = path.join(SHIFU_DOCS, 'cache-contract.json');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

// ajv is a devDependency (root package.json), present in CI and after a full
// `pnpm install`, but a freshly created git worktree has no node_modules yet.
// Load it lazily so a missing setup dependency degrades to a skip of the schema
// checks instead of crashing the whole pre-commit gate — the same "a setup gap
// must not block a commit" rule the hook shim already follows. The structural and
// private-IP leak checks below do not need ajv and always run; CI (with ajv
// installed) still enforces the full schema/fixture validation.
async function loadAjv2020() {
  try {
    return (await import('ajv/dist/2020.js')).default;
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}

function ajv2020(Ajv2020) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('date-time', (value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && /(?:Z|[+-]\d\d:\d\d)$/.test(value);
  });
  ajv.addFormat('uri-reference', (value) => {
    try {
      new URL(value, 'https://libkungfu.dev/');
      return true;
    } catch {
      return false;
    }
  });
  return ajv;
}

function validateOrThrow(validate, value, label) {
  if (validate(value)) return;
  const details = (validate.errors || [])
    .map((item) => `${item.instancePath || '/'} ${item.message || 'invalid'}`)
    .join('; ');
  throw new Error(`${label} does not satisfy its schema: ${details}`);
}

export async function checkShifuCacheContract(root = ROOT) {
  const contractPath = path.join(root, rel(CONTRACT_PATH));
  const contract = readJson(contractPath);
  assert.equal(contract.schema, 'shifu.cache-contract/v1');
  assert.equal(contract.owner, 'shifu');

  const profilePath = path.join(root, contract.authority.profileSchema);
  const resolutionPath = path.join(root, contract.authority.resolutionSchema);
  const diagnosticPath = path.join(root, contract.authority.diagnosticSchema);
  const configPlanPath = path.join(root, contract.authority.configPlanSchema);
  const decisionPath = path.join(root, contract.authority.decision);
  for (const source of [
    profilePath,
    resolutionPath,
    diagnosticPath,
    configPlanPath,
    decisionPath,
  ]) {
    assert.ok(
      fs.existsSync(source),
      `contract source is missing: ${rel(source)}`,
    );
  }

  const profileSchema = readJson(profilePath);
  const resolutionSchema = readJson(resolutionPath);
  const diagnosticSchema = readJson(diagnosticPath);
  const configPlanSchema = readJson(configPlanPath);
  assert.equal(profileSchema.$id, contract.schemaIds.profile);
  assert.equal(resolutionSchema.$id, contract.schemaIds.resolution);
  assert.equal(diagnosticSchema.$id, contract.schemaIds.diagnostic);
  assert.equal(configPlanSchema.$id, contract.schemaIds.configPlan);

  const dispatchMarkers = [
    ['shifu', 'if [ "${1:-}" = "cache" ]; then'],
    ['shifu.cmd', 'if /i "%~1"=="cache" goto delegate'],
    ['crates/shifu/src/main.rs', '"cache", "proxy", "config"'],
  ];
  for (const [source, marker] of dispatchMarkers) {
    assert.match(
      fs.readFileSync(path.join(root, source), 'utf8'),
      new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${source} does not route the cache command`,
    );
  }

  const exampleDir = path.join(root, 'docs', 'shifu', 'examples');
  const Ajv2020 = await loadAjv2020();
  let validFixtures = 0;
  let rejectedFixtures = 0;
  if (Ajv2020) {
    const ajv = ajv2020(Ajv2020);
    const validateProfile = ajv.compile(profileSchema);
    const validateResolution = ajv.compile(resolutionSchema);
    for (const name of [
      'development.cache-profile.json',
      'self-hosted-runner.cache-profile.json',
    ]) {
      validateOrThrow(
        validateProfile,
        readJson(path.join(exampleDir, name)),
        name,
      );
    }
    validateOrThrow(
      validateResolution,
      readJson(path.join(exampleDir, 'cache-resolution.json')),
      'cache-resolution.json',
    );
    validFixtures = 3;

    for (const name of [
      'embedded-credential.cache-profile.json',
      'required-with-fallback.cache-profile.json',
    ]) {
      const fixture = readJson(path.join(exampleDir, 'invalid', name));
      assert.equal(
        validateProfile(fixture),
        false,
        `negative fixture unexpectedly passed: ${name}`,
      );
    }
    rejectedFixtures = 2;
  } else {
    console.warn(
      '[shifu-cache] ajv not installed; skipped schema/fixture validation ' +
        '(structural + private-IP leak checks still ran). Run `pnpm install` to ' +
        'enable it locally; CI enforces the full schema/fixture validation.',
    );
  }

  const publicJson = fs
    .readdirSync(exampleDir, { recursive: true })
    .filter((name) => String(name).endsWith('.json'))
    .map((name) => fs.readFileSync(path.join(exampleDir, String(name)), 'utf8'))
    .join('\n');
  assert.doesNotMatch(publicJson, /\b(?:10|127)\.\d+\.\d+\.\d+\b/);
  assert.doesNotMatch(publicJson, /\b192\.168\.\d+\.\d+\b/);
  assert.doesNotMatch(publicJson, /\b172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+\b/);

  return {
    contract: rel(contractPath),
    profileSchema: rel(profilePath),
    resolutionSchema: rel(resolutionPath),
    diagnosticSchema: rel(diagnosticPath),
    configPlanSchema: rel(configPlanPath),
    validFixtures,
    rejectedFixtures,
  };
}

async function main() {
  const result = await checkShifuCacheContract();
  console.log(
    `[shifu-cache] contract=${result.contract} valid=${result.validFixtures} rejected=${result.rejectedFixtures}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
