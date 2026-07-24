// SPDX-License-Identifier: Apache-2.0

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const {
  adrMapPath,
  agentIndexPath,
  loadBundle,
  schemaPath,
  verifyBundle,
} = require('./index.js');

test('publishes one integrity-bound human and agent product map', () => {
  const result = verifyBundle();
  assert.equal(result.status, 'passing');
  assert.equal(result.package.name, '@kungfu-tech/site');
  assert.ok(result.surfaces >= 10);
  assert.ok(result.sources >= 10);
  assert.ok(fs.existsSync(schemaPath));
  assert.ok(fs.existsSync(agentIndexPath));
  assert.ok(fs.existsSync(adrMapPath));
});

test('keeps maturity and authority boundaries explicit', () => {
  const bundle = loadBundle();
  const byId = new Map(bundle.surfaces.map((surface) => [surface.id, surface]));
  assert.equal(byId.get('format').maturity, 'pre-normative');
  assert.equal(byId.get('primitives').maturity, 'qualified-shadow');
  assert.equal(byId.get('products').maturity, 'coming-soon');
  assert.match(bundle.adrMap.authorityBoundary, /navigation-only/);
  assert.ok(bundle.nonClaims.some((entry) => entry.includes('Spec 0.1')));
});

test('exposes the complete product route hierarchy', () => {
  const routes = loadBundle().surfaces.map((surface) => surface.route);
  assert.deepEqual(routes, [
    '/',
    '/format/',
    '/primitives/',
    '/runtime/',
    '/abi/',
    '/sdk/',
    '/extensions/',
    '/products/',
    '/qualification/',
    '/decisions/',
    '/horizons/',
  ]);
});
