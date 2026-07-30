// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { validateReadonlyRouteInventory } from './check-readonly-source-routes.mjs';

const inventory = JSON.parse(
  fs.readFileSync(
    'framework/maintainability/readonly-source-routes.json',
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
