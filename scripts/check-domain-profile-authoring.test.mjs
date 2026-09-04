// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import {
  createReferencePackageFiles,
  readDomainProfileAuthoringContract,
  renderDomainProfileAuthoring,
  validateActivationAdmission,
  validateDomainProfileDeclaration,
} from './domain-profile-authoring.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const contract = readDomainProfileAuthoringContract();
const cloneReference = () => structuredClone(contract.referenceProfile);
const sha256 = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');

const canonicalJson = (value) => {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
};

test('validates the authoring contract and its non-software reference declaration', () => {
  const validateContract = new Ajv2020({
    allErrors: true,
    strict: true,
  }).compile(contract.contractSchema);
  assert.equal(
    validateContract(contract),
    true,
    JSON.stringify(validateContract.errors),
  );
  assert.equal(
    validateDomainProfileDeclaration(contract.referenceProfile, contract),
    contract.referenceProfile,
  );
  assert.equal(
    contract.referenceProfile.id,
    'kungfu.reference.course-production',
  );
});

test('generates a complete hash-closed KFX Profile Suite source package', () => {
  const files = createReferencePackageFiles(contract);
  const parse = (file) => JSON.parse(files.get(file));
  const kfx = readJson('framework/kfx/kungfu-kfx.contract.json');
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validateProfile = ajv.compile(kfx.profileSuiteSchema);
  const validatePackage = ajv.compile(kfx.packageManifestSchema);
  const profile = parse('profile.json');
  const packageManifest = parse('kungfu.kfx.json');
  const memberManifest = parse(
    'members/course-production-domain/kungfu.kfx.json',
  );
  assert.equal(
    validateProfile(profile),
    true,
    JSON.stringify(validateProfile.errors),
  );
  assert.equal(
    validatePackage(packageManifest),
    true,
    JSON.stringify(validatePackage.errors),
  );
  assert.equal(
    validatePackage(memberManifest),
    true,
    JSON.stringify(validatePackage.errors),
  );
  assert.deepEqual(
    packageManifest.kungfuConfig.suite.members,
    profile.members.required,
  );

  const refs = [];
  const collectRefs = (value) => {
    if (Array.isArray(value)) value.forEach(collectRefs);
    else if (value !== null && typeof value === 'object') {
      if (typeof value.path === 'string' && typeof value.sha256 === 'string')
        refs.push(value);
      Object.values(value).forEach(collectRefs);
    }
  };
  collectRefs(contract.referenceProfile);
  collectRefs(profile);
  for (const ref of refs) {
    assert.equal(files.has(ref.path), true, ref.path);
    assert.equal(sha256(files.get(ref.path)), ref.sha256, ref.path);
  }
});

test('fails closed on role fusion and undeclared authority', () => {
  const fused = cloneReference();
  fused.responsibilityMappings[4].responsibility = 'atlas';
  assert.throws(
    () => validateDomainProfileDeclaration(fused, contract),
    /role-fusion/,
  );

  const elevated = cloneReference();
  elevated.responsibilityMappings[2].authority = 'fact-reference';
  assert.throws(
    () => validateDomainProfileDeclaration(elevated, contract),
    /undeclared-authority/,
  );
});

test('fails closed on dependency cycles and schema or root drift', () => {
  const cycle = cloneReference();
  cycle.dependencies.push({
    id: cycle.id,
    versionRange: cycle.version,
    root: cycle.dependencies[0].root,
  });
  assert.throws(
    () => validateDomainProfileDeclaration(cycle, contract),
    /dependency-cycle/,
  );

  const drift = cloneReference();
  drift.dependencies[0].root = 'sha256:not-a-root';
  assert.throws(
    () => validateDomainProfileDeclaration(drift, contract),
    /schema-invalid/,
  );
});

test('fails closed on incompatible migrations', () => {
  const incompatible = cloneReference();
  incompatible.migrations[0].preserves = [
    'fact-identity',
    'episode-identity',
    'responsibility-separation',
  ];
  incompatible.migrations[0].rollback = 'unsupported';
  assert.throws(
    () => validateDomainProfileDeclaration(incompatible, contract),
    /migration-incompatible/,
  );
});

test('fails closed on unsigned or unqualified activation evidence', () => {
  const complete = Object.fromEntries(
    contract.lifecycle.activationAdmission.map((requirement) => [
      requirement,
      true,
    ]),
  );
  assert.equal(validateActivationAdmission(complete, contract), complete);
  for (const requirement of [
    'valid-supply-chain-signature',
    'fresh-qualification-receipt',
  ]) {
    const incomplete = { ...complete, [requirement]: false };
    assert.throws(
      () => validateActivationAdmission(incomplete, contract),
      new RegExp(requirement, 'u'),
    );
  }
});

test('registers one byte-identical canonical contract artifact', () => {
  const registry = readJson(
    'framework/spec/contract/kungfu-contracts.registry.json',
  );
  const policy = readJson(
    'framework/spec/contract/kungfu-agent-first-canonical-policy.json',
  );
  const entry = registry.contracts.find(
    (candidate) => candidate.surface === 'domain-profile-authoring',
  );
  assert.ok(entry);
  assert.equal(
    entry.contractSchemaRoot,
    `sha256:${crypto
      .createHash('sha256')
      .update(canonicalJson(contract.contractSchema))
      .digest('hex')}`,
  );
  assert.equal(read(entry.source), read(entry.artifact));
  const sourceRoot = `sha256:${crypto
    .createHash('sha256')
    .update(read(entry.source))
    .digest('hex')}`;
  const policyEntry = policy.surfaces.find(
    (candidate) => candidate.surface === entry.surface,
  );
  assert.ok(policyEntry);
  assert.equal(policyEntry.source.sha256, sourceRoot);
  assert.equal(policyEntry.artifact.expectedSha256, sourceRoot);
});

test('generates docs and the reference package from the contract', () => {
  assert.equal(
    read('docs/architecture/domain-profile-authoring.md'),
    renderDomainProfileAuthoring(contract),
  );
  assert.deepEqual(
    readJson(
      'tests/fixtures/domain-profile-authoring/course-production/domain-profile.json',
    ),
    contract.referenceProfile,
  );
});
