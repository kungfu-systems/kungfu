// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyGeneratedOutputRoots } from './generate-work-lifecycle-sdk.mjs';

const read = (file) => fs.readFileSync(file, 'utf8');
const matrix = JSON.parse(
  read(
    'framework/work/work-lifecycle/kungfu-work-lifecycle-operation-matrix.contract.json',
  ),
);
const contract = JSON.parse(
  read('framework/work/work-lifecycle/work-lifecycle-native.contract.json'),
);

test('native Work lifecycle contract is a lossless projection of the operation matrix', () => {
  assert.deepEqual(
    contract.operations.map((entry) => entry.id),
    matrix.operations.map((entry) => entry.id),
  );
  assert.equal(
    new Set(contract.operations.map((entry) => entry.id)).size,
    matrix.operations.length,
  );
  assert.equal(
    contract.admission.delegatedMutationCannotReturnSuccessWithoutReceipt,
    true,
  );
  assert.equal(
    contract.admission.delegatedMutationRequiresExactAuthorityReceipt,
    true,
  );
  assert.equal(
    contract.admission.nativeMutationRequiresExactBasisAndNativeReceipt,
    true,
  );
  assert.equal(
    contract.admission.routingAdmissionDoesNotProveAuthorityExecution,
    true,
  );
  assert.equal(
    matrix.authorityMembrane.closedInventory.clientProjectionRoots.includes(
      'framework/storage',
    ),
    true,
  );
  assert.equal(
    matrix.authorityMembrane.closedInventory.clientProjectionRoots.includes(
      'framework/sdk',
    ),
    false,
  );
});

test('SDK qualification resolves the live storage workspace, never the retired root', () => {
  const qualification = read('tests/qualification/layers/sdk/run.mjs');
  assert.match(qualification, /['"]framework['"]\s*,\s*['"]storage['"]/u);
  assert.doesNotMatch(qualification, /['"]framework['"]\s*,\s*['"]sdk['"]/u);
});

test('all four generated bindings expose the same operation-set root and invocation symbols', () => {
  const files = [
    'framework/core/src/libkungfu/include/kungfu/sdk/generated/work_lifecycle_v1.hpp',
    'framework/storage/generated/work-lifecycle-v1.js',
    'framework/storage/python/kungfu_sdk/generated/work_lifecycle_v1.py',
    'crates/kungfu-sdk/src/generated/work_lifecycle_v1.rs',
  ];
  for (const file of files) {
    const source = read(file);
    assert.equal(source.includes(contract.operationSetRoot), true);
    assert.match(source, /capabilities/u);
    assert.match(source, /invoke/u);
    assert.match(source, /invoke_raw|invokeRaw/u);
    assert.match(source, /semanticOwner|semantic_owner/u);
    assert.match(source, /reasonCode|reason_code/u);
    for (const operation of matrix.operations)
      assert.match(
        source,
        new RegExp(
          operation.id.replaceAll('.', '\\.').replace('/', '\\/'),
          'u',
        ),
      );
  }
});

test('generated output roots and generator self-hash fail closed on mutation', (t) => {
  assert.deepEqual(verifyGeneratedOutputRoots(contract), []);
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-work-lifecycle-sdk-'),
  );
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  for (const record of [
    contract.generator,
    ...contract.generator.dependencies,
    ...Object.values(contract.generatedOutputRoots),
  ]) {
    const target = path.join(temporaryRoot, record.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(record.path, target);
  }
  const mutated = contract.generatedOutputRoots.node.path;
  fs.appendFileSync(path.join(temporaryRoot, mutated), '\n');
  assert.match(
    verifyGeneratedOutputRoots(contract, temporaryRoot).join('\n'),
    /node: root drift/u,
  );
  fs.copyFileSync(mutated, path.join(temporaryRoot, mutated));
  const dependency = contract.generator.dependencies[0].path;
  fs.appendFileSync(path.join(temporaryRoot, dependency), '\n');
  assert.match(
    verifyGeneratedOutputRoots(contract, temporaryRoot).join('\n'),
    /generator dependency scripts\/lib\/sdk-generator\.mjs: root drift/u,
  );
});

test('runtime authority rejects retired WorkStore routes and never exposes a second Work writer', () => {
  const source = read(
    'framework/core/src/libkungfu/src/runtime/action/action_runtime.cpp',
  );
  assert.match(source, /work_lifecycle/u);
  assert.match(
    source,
    /delegated mutation requires an exact authority receipt/u,
  );
  assert.match(source, /authority receipt does not match lifecycle operation/u);
  assert.match(source, /bypass-not-admitted/u);
  assert.match(source, /authorityExecuted/u);
  assert.doesNotMatch(source, /work_journal/u);
  assert.doesNotMatch(source, /native-work-journal/u);
  assert.equal(
    contract.operations.some((entry) => entry.layer === 'work'),
    false,
  );
});
