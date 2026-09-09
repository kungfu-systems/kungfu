// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { optionalAjv2020 } from './readonly-source-toolchain.mjs';

import {
  CUT_CATALOG_PATH,
  EPISODE_CATALOG_PATH,
  GENERATOR_PATH,
  materializeWorkLifecycleOperationMatrix,
  verifyWorkLifecycleGeneration,
} from './materialize-work-lifecycle-operation-matrix.mjs';
import {
  readContract,
  renderWorkLifecycleOperationMatrix,
} from './render-work-lifecycle-operation-matrix.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const Ajv2020 = optionalAjv2020();
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const contract = readContract();
const registry = readJson(
  'framework/spec/contract/kungfu-contracts.registry.json',
);
const policy = readJson(
  'framework/spec/contract/kungfu-agent-first-canonical-policy.json',
);
const apiHeader = read('framework/core/src/libkungfu/include/kungfu/api.h');
const rustSdk = read('crates/kungfu-sdk/src/lib.rs');
const pythonSdk = read('framework/storage/python/kungfu_sdk/native.py');
const runtimeAction = read(
  'framework/core/src/libkungfu/src/runtime/action/action_runtime.cpp',
);
const missionActions = readJson(
  'extensions/work-control/actions/registry.json',
);

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

test('validates the exact matrix with its embedded Draft 2020-12 schema', (t) => {
  if (!Ajv2020) {
    t.skip('ajv is not installed; CI enforces JSON Schema conformance');
    return;
  }
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
    contract.contractSchema,
  );
  assert.equal(validate(contract), true, JSON.stringify(validate.errors));
});

test('keeps stable ids, sole owners, failure classes, and target conformance closed', () => {
  const ids = contract.operations.map((operation) => operation.id);
  assert.equal(new Set(ids).size, ids.length);
  const knownFailures = new Set(contract.failureClasses);
  for (const operation of contract.operations) {
    assert.match(operation.authorityOwner, /^[a-z0-9-]+$/u);
    assert.ok(
      operation.failureClasses.every((code) => knownFailures.has(code)),
    );
    assert.deepEqual(operation.targetParity, {
      cpp: 'conformant',
      python: 'conformant',
      node: 'conformant',
      rust: 'conformant',
    });
  }
  assert.deepEqual(
    new Set(contract.operations.map((operation) => operation.capability)),
    new Set([
      'inspect',
      'create',
      'update',
      'transition',
      'archive',
      'recover',
      'export',
      'import',
      'verify',
      'settle',
      'register',
      'validate',
      'qualify',
      'install',
      'activate',
      'deactivate',
      'upgrade',
      'rollback',
    ]),
  );
});

test('records four-language projection without inventing authority', () => {
  const coreCut = contract.operations.filter(
    (operation) => operation.layer === 'cut',
  );
  assert.ok(coreCut.length >= 5);
  for (const operation of contract.operations) {
    assert.deepEqual(operation.currentParity, {
      cpp: 'projected',
      python: 'projected',
      node: 'projected',
      rust: 'projected',
    });
  }
  for (const operation of coreCut) {
    assert.match(operation.id, /^work\.lifecycle\.cut\./u);
    assert.equal(operation.native.status, 'implemented');
    assert.equal(operation.native.interface, 'kf_runtime_action_api_v1');
    assert.deepEqual(operation.native.operations, ['work_lifecycle']);
  }
  const assignmentArchive = contract.operations.find(
    (operation) => operation.id === 'work.lifecycle.assignment.archive/v1',
  );
  assert.equal(assignmentArchive.native.status, 'missing');
  assert.deepEqual(assignmentArchive.native.operations, []);
  for (const id of [
    'work.lifecycle.episode.export/v1',
    'work.lifecycle.episode.import/v1',
  ]) {
    const operation = contract.operations.find(
      (candidate) => candidate.id === id,
    );
    assert.equal(operation.currentParity.rust, 'projected');
    for (const route of operation.native.operations) {
      assert.match(rustSdk, new RegExp(`"${route}"\\s*=>`, 'u'));
    }
  }
});

test('defines one native semantic owner and fail-visible state vocabulary', () => {
  const membrane = contract.authorityMembrane;
  assert.equal(membrane.semanticDecisionOwner, 'native-runtime-only');
  assert.deepEqual(
    new Set(contract.languageStates),
    new Set([
      'conformant',
      'projected',
      'unsupported',
      'unavailable',
      'degraded',
      'stale',
      'unknown',
    ]),
  );
  for (const operation of contract.operations) {
    assert.equal(
      typeof membrane.semanticOwnerRules[operation.native.interface],
      'string',
      operation.id,
    );
  }
  assert.equal(membrane.conformanceOracle.productionFallback, false);
  assert.equal(membrane.requestBoundary.hiddenDefaults, 'forbidden');
  assert.equal(membrane.resultBoundary.unknownToFalseOrAbsent, 'forbidden');
  assert.ok(membrane.reasonCodes.includes('invalid-request'));
});

test('mechanically closes the native ABI and runtime-action operation inventory', () => {
  const inventory = contract.authorityMembrane.closedInventory.operations;
  const enumValues = (prefix) =>
    [...apiHeader.matchAll(new RegExp(`\\b${prefix}_([A-Z0-9_]+)\\s*=`, 'gu'))]
      .map((match) => match[1].toLowerCase())
      .map((name) =>
        prefix === 'KF_MAINTENANCE' && name === 'export'
          ? 'export_bundle'
          : prefix === 'KF_MAINTENANCE' && name === 'import'
            ? 'import_bundle'
            : name,
      );
  assert.deepEqual(enumValues('KF_LEDGER_ACTION'), inventory.ledgerAction);
  assert.deepEqual(enumValues('KF_MAINTENANCE'), inventory.maintenance);

  const descriptorBlock = runtimeAction.match(
    /constexpr auto ACTION_DESCRIPTORS = std::array\{([\s\S]*?)\n\};/u,
  )?.[1];
  assert.ok(descriptorBlock);
  const actionList = [
    ...descriptorBlock.matchAll(
      /action_descriptor\{"([a-z0-9_]+)",[\s\S]*?action_capability::([a-z_]+)(?:\s*\|\s*action_capability::([a-z_]+))?\},/gu,
    ),
  ].filter(
    (match) => match[2] === 'discoverable' || match[3] === 'discoverable',
  );
  assert.deepEqual(
    actionList.map((match) => match[1]),
    inventory.runtimeAction,
  );

  for (const operation of [
    ...inventory.ledgerAction,
    ...inventory.maintenance,
  ]) {
    assert.match(pythonSdk, new RegExp(`"${operation}"\\s*:`, 'u'));
    assert.match(rustSdk, new RegExp(`"${operation}"\\s*=>`, 'u'));
  }
});

test('binds implemented native and Work Control routes to repository evidence', () => {
  const missionIds = new Set(missionActions.actions.map((action) => action.id));
  for (const operation of contract.operations) {
    if (operation.native.interface === 'kf_ledger_action_api_v1') {
      for (const name of operation.native.operations) {
        assert.match(
          apiHeader,
          new RegExp(`KF_LEDGER_ACTION_${name.toUpperCase()}\\b`, 'u'),
        );
        if (!['authority_export', 'authority_import'].includes(name)) {
          assert.match(rustSdk, new RegExp(`"${name}"`, 'u'));
        }
      }
    }
    if (operation.native.interface === 'kf_maintenance_api_v1') {
      for (const name of operation.native.operations) {
        assert.match(
          apiHeader,
          new RegExp(`KF_MAINTENANCE_${name.toUpperCase()}\\b`, 'u'),
        );
        assert.match(rustSdk, new RegExp(`"${name}"`, 'u'));
      }
    }
    if (operation.native.interface === 'work-control-actions') {
      for (const name of operation.native.operations) {
        assert.equal(missionIds.has(name), true, name);
      }
    }
  }
});

test('registers and ships one byte-identical contract artifact', () => {
  const entry = registry.contracts.find(
    (candidate) => candidate.surface === 'work-lifecycle-operation-matrix',
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
  assert.deepEqual(
    entry.extraArtifacts.map((artifact) => artifact.source),
    [
      contract.generation.semanticSources.cut.path,
      contract.generation.semanticSources.episode.path,
      contract.generation.generator.path,
      ...contract.generation.generator.dependencies.map(
        (dependency) => dependency.path,
      ),
    ],
  );
  for (const artifact of entry.extraArtifacts)
    assert.equal(read(artifact.source), read(artifact.artifact));
});

test('renders the checked human document from the machine source', () => {
  assert.equal(
    read('docs/architecture/work-lifecycle-operation-matrix.md'),
    renderWorkLifecycleOperationMatrix(contract),
  );
});

test('catalog and generator closure drift fail closed independently', (t) => {
  assert.deepEqual(verifyWorkLifecycleGeneration(contract.generation), []);
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-work-lifecycle-generation-'),
  );
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const records = [
    contract.generation.generator,
    ...contract.generation.generator.dependencies,
    ...Object.values(contract.generation.semanticSources),
  ];
  for (const record of records) {
    const target = path.join(temporaryRoot, record.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, record.path), target);
  }

  fs.appendFileSync(
    path.join(temporaryRoot, contract.generation.semanticSources.cut.path),
    '\n',
  );
  assert.match(
    verifyWorkLifecycleGeneration(contract.generation, temporaryRoot).join(
      '\n',
    ),
    /cut: root drift/u,
  );
  fs.copyFileSync(
    path.join(ROOT, contract.generation.semanticSources.cut.path),
    path.join(temporaryRoot, contract.generation.semanticSources.cut.path),
  );
  fs.appendFileSync(path.join(temporaryRoot, GENERATOR_PATH), '\n');
  assert.match(
    verifyWorkLifecycleGeneration(contract.generation, temporaryRoot).join(
      '\n',
    ),
    /generator: root drift/u,
  );
});

test('projects Cut and Episode descriptions from their authority catalogs', () => {
  const cutCatalog = readJson(CUT_CATALOG_PATH);
  const episodeCatalog = readJson(EPISODE_CATALOG_PATH);
  const materialized = materializeWorkLifecycleOperationMatrix({
    matrix: contract,
    cutCatalog,
    episodeCatalog,
  });
  assert.deepEqual(materialized, contract);
  assert.equal(cutCatalog.operations.length, 6);
  assert.equal(episodeCatalog.operations.length, 7);
  assert.deepEqual(contract.generation.managedLayers, ['cut', 'episode']);
  assert.deepEqual(contract.generation.retainedMetadata, [
    'public',
    'native',
    'currentParity',
    'targetParity',
    'evidence',
  ]);

  const drifted = structuredClone(contract);
  drifted.operations.find(
    (operation) => operation.id === 'work.lifecycle.cut.verify/v1',
  ).preconditions = ['hand-written duplicate'];
  assert.deepEqual(
    materializeWorkLifecycleOperationMatrix({
      matrix: drifted,
      cutCatalog,
      episodeCatalog,
    }),
    contract,
  );
});
