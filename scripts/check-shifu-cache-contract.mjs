#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIFU_DOCS = path.join(ROOT, 'docs', 'shifu');
const CONTRACT_PATH = path.join(SHIFU_DOCS, 'cache-contract.json');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

function ajv2020() {
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

export function checkShifuCacheContract(root = ROOT) {
  const contractPath = path.join(root, rel(CONTRACT_PATH));
  const contract = readJson(contractPath);
  assert.equal(contract.schema, 'shifu.cache-contract/v1');
  assert.equal(contract.owner, 'shifu');

  const profilePath = path.join(root, contract.authority.profileSchema);
  const resolutionPath = path.join(root, contract.authority.resolutionSchema);
  const decisionPath = path.join(root, contract.authority.decision);
  for (const source of [profilePath, resolutionPath, decisionPath]) {
    assert.ok(
      fs.existsSync(source),
      `contract source is missing: ${rel(source)}`,
    );
  }

  const profileSchema = readJson(profilePath);
  const resolutionSchema = readJson(resolutionPath);
  assert.equal(profileSchema.$id, contract.schemaIds.profile);
  assert.equal(resolutionSchema.$id, contract.schemaIds.resolution);

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

  const ajv = ajv2020();
  const validateProfile = ajv.compile(profileSchema);
  const validateResolution = ajv.compile(resolutionSchema);
  const exampleDir = path.join(root, 'docs', 'shifu', 'examples');
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
    validFixtures: 3,
    rejectedFixtures: 2,
  };
}

function main() {
  const result = checkShifuCacheContract();
  console.log(
    `[shifu-cache] contract=${result.contract} valid=${result.validFixtures} rejected=${result.rejectedFixtures}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
