// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import {
  readContract,
  renderWorkLifecycleOperationMatrix,
} from './render-work-lifecycle-operation-matrix.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const contract = readContract();
const registry = readJson('framework/contract/kungfu-contracts.registry.json');
const policy = readJson(
  'framework/contract/kungfu-agent-first-canonical-policy.json',
);
const apiHeader = read('framework/core/src/libkungfu/include/kungfu/api.h');
const rustSdk = read('crates/kungfu-sdk/src/lib.rs');
const missionActions = readJson(
  'extensions/mission-control/actions/registry.json',
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

test('validates the exact matrix with its embedded Draft 2020-12 schema', () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
    contract.contractSchema,
  );
  assert.equal(validate(contract), true, JSON.stringify(validate.errors));
});

test('keeps stable ids, sole owners, failure classes, and target parity closed', () => {
  const ids = contract.operations.map((operation) => operation.id);
  assert.equal(new Set(ids).size, ids.length);
  const knownFailures = new Set(contract.failureClasses);
  for (const operation of contract.operations) {
    assert.match(operation.authorityOwner, /^[a-z0-9-]+$/u);
    assert.ok(
      operation.failureClasses.every((code) => knownFailures.has(code)),
    );
    assert.deepEqual(operation.targetParity, {
      cpp: 'required',
      python: 'required',
      node: 'required',
      rust: 'required',
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

test('records proved four-language envelope parity without inventing authority', () => {
  const coreCut = contract.operations.filter(
    (operation) => operation.layer === 'cut',
  );
  assert.ok(coreCut.length >= 5);
  for (const operation of contract.operations) {
    assert.deepEqual(operation.currentParity, {
      cpp: 'proved',
      python: 'proved',
      node: 'proved',
      rust: 'proved',
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
    assert.equal(operation.currentParity.rust, 'proved');
    for (const route of operation.native.operations) {
      assert.doesNotMatch(rustSdk, new RegExp(`"${route}"\\s*=>`, 'u'));
    }
  }
});

test('binds implemented native and Mission Control routes to repository evidence', () => {
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
    if (operation.native.interface === 'mission-control-actions') {
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
});

test('renders the checked human document from the machine source', () => {
  assert.equal(
    read('docs/architecture/work-lifecycle-operation-matrix.md'),
    renderWorkLifecycleOperationMatrix(contract),
  );
});
