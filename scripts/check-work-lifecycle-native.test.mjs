// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (file) => fs.readFileSync(file, 'utf8');
const matrix = JSON.parse(
  read(
    'framework/work-lifecycle/kungfu-work-lifecycle-operation-matrix.contract.json',
  ),
);
const contract = JSON.parse(
  read('framework/work-lifecycle/work-lifecycle-native.contract.json'),
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
    contract.admission.routingAdmissionDoesNotProveAuthorityExecution,
    true,
  );
});

test('all four generated bindings expose the same operation-set root and invocation symbols', () => {
  const files = [
    'framework/core/src/libkungfu/include/kungfu/sdk/generated/work_lifecycle_v1.hpp',
    'framework/sdk/generated/work-lifecycle-v1.js',
    'framework/sdk/python/kungfu_sdk/generated/work_lifecycle_v1.py',
    'crates/kungfu-sdk/src/generated/work_lifecycle_v1.rs',
  ];
  for (const file of files) {
    const source = read(file);
    assert.equal(source.includes(contract.operationSetRoot), true);
    assert.match(source, /capabilities/u);
    assert.match(source, /invoke/u);
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

test('runtime authority exposes lifecycle routing without laundering delegated authority', () => {
  const source = read(
    'framework/core/src/libkungfu/src/runtime/action/action_runtime.cpp',
  );
  assert.match(source, /work_lifecycle/u);
  assert.match(
    source,
    /delegated mutation requires an exact authority receipt/u,
  );
  assert.match(source, /authority receipt does not match lifecycle operation/u);
  assert.match(source, /authority-receipt-admitted/u);
  assert.match(source, /authorityExecuted/u);
});
