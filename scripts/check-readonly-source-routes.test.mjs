// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { validateReadonlyRouteInventory } from './check-readonly-source-routes.mjs';

const inventory = JSON.parse(
  fs.readFileSync(
    'developer/maintainability/readonly-source-routes.json',
    'utf8',
  ),
);

test('route inventory closes source and Agent discovery commands', () => {
  assert.deepEqual(validateReadonlyRouteInventory(inventory), []);
});

test('unclassified, writing, or missing routes fail closed', () => {
  const broken = structuredClone(inventory);
  broken.routes = broken.routes.filter(
    (route) => route.id !== 'core-architecture-query',
  );
  broken.routes[0].network = true;
  broken.routes[1].implementation = 'missing.mjs';
  const codes = validateReadonlyRouteInventory(broken).map((item) => item.code);
  assert.ok(codes.includes('source-route-unclassified'));
  assert.ok(codes.includes('read-route-side-effect'));
  assert.ok(codes.includes('route-implementation'));
});

test('every shim-routed Work Design query remains classified', () => {
  for (const id of [
    'work-design-preflight-preflight',
    'work-design-feedback',
  ]) {
    const broken = structuredClone(inventory);
    broken.routes = broken.routes.filter((route) => route.id !== id);
    assert.ok(
      validateReadonlyRouteInventory(broken).some(
        (item) => item.code === 'source-route-unclassified',
      ),
      `${id} must not disappear behind a self-consistent inventory`,
    );
  }
});

test('checkout-readonly documentation materialization stays explicit', () => {
  const route = inventory.routes.find(
    (candidate) => candidate.id === 'documentation-readonly-checkout',
  );
  assert.equal(route?.classification, 'explicit-materialization');
  assert.equal(route?.network, true);
  assert.equal(route?.dependencyInstallation, true);
  const broken = structuredClone(inventory);
  broken.routes = broken.routes.filter(
    (candidate) => candidate.id !== 'documentation-readonly-checkout',
  );
  assert.ok(
    validateReadonlyRouteInventory(broken).some(
      (item) => item.code === 'explicit-source-route-unclassified',
    ),
  );
});

test('source acceptance requires exact writer ownership, recovery, and checkout denials', () => {
  const broken = structuredClone(inventory);
  const source = broken.routes.find(
    (route) => route.id === 'source-acceptance',
  );
  source.writerOwner = 'nested-task';
  source.recovery = '';
  source.deniedCheckoutWriters = [];
  const diagnostics = validateReadonlyRouteInventory(broken);
  const codes = diagnostics.map((item) => item.code);
  assert.ok(codes.includes('source-writer-owner'));
  assert.ok(codes.includes('source-writer-recovery'));
  assert.equal(
    diagnostics.filter((item) => item.code === 'source-writer-denial').length,
    5,
  );
  for (const item of diagnostics.filter(
    (diagnostic) => diagnostic.code === 'source-writer-denial',
  )) {
    assert.equal(item.owner, 'source-acceptance-runtime');
    assert.equal(item.recovery, '');
  }
});
