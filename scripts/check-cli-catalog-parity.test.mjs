// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  auditCatalogParity,
  auditRepository,
  contentRoot,
} from './check-cli-catalog-parity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACK = path.join(ROOT, 'framework/core/src/python/kungfu/agent');
const CLI = path.join(ROOT, 'framework/core/src/python/kungfu/cli');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function inputs() {
  return {
    catalog: read(path.join(PACK, 'cli_surface.catalog.json')),
    registry: read(path.join(CLI, 'surface_contract.registry.json')),
    schema: read(path.join(CLI, 'surface_contract.schema.json')),
    kfd3: read(path.join(PACK, 'kfd3_api.registry.json')),
    commands: read(path.join(PACK, 'commands.json')),
    index: read(path.join(PACK, 'index.json')),
  };
}

test('repository CLI catalog parity is current', () => {
  assert.deepEqual(auditRepository(), { ok: true, issues: [] });
});

test('catalog root drift fails closed', () => {
  const fixture = inputs();
  fixture.catalog.surfaces[0].owner = 'profile-kfx';
  const result = auditCatalogParity(fixture);
  assert.equal(result.ok, false);
  assert(result.issues.includes('generated catalog root mismatch'));
  assert(result.issues.includes('generated catalog surface root mismatch'));
});

test('a hand-edited and re-rooted catalog still fails the registry fence', () => {
  const fixture = inputs();
  fixture.catalog.surfaces[0].owner = 'product-assembly';
  fixture.catalog.surfaceRoot = contentRoot(fixture.catalog.surfaces);
  fixture.catalog.contractRoot = contentRoot({
    schema: 'kungfu.cli-surface-contract/v1',
    version: fixture.registry.version,
    registryRoot: fixture.catalog.registryRoot,
    schemaRoot: fixture.catalog.schemaRoot,
    surfaceRoot: fixture.catalog.surfaceRoot,
  });
  const { catalogRoot: _catalogRoot, ...preimage } = fixture.catalog;
  fixture.catalog.catalogRoot = contentRoot(preimage);
  const result = auditCatalogParity(fixture);
  assert.equal(result.ok, false);
  assert(
    result.issues.includes('generated catalog violates expected surface root'),
  );
});

test('orphan and mismatched consumer entries fail closed', () => {
  const fixture = inputs();
  fixture.commands.commands[0].apiId = 'kungfu.unknown';
  const result = auditCatalogParity(fixture);
  assert.equal(result.ok, false);
  assert(
    result.issues.includes('commands.json unknown KFD-3 API kungfu.unknown'),
  );
});

test('standalone command routes require an explicit live Click target', () => {
  const fixture = inputs();
  fixture.registry.standaloneCatalogRoutes = [];
  const result = auditCatalogParity(fixture);
  assert.equal(result.ok, false);
  assert(
    result.issues.includes(
      'commands.json orphan path kungfu-exit-verify --file <package.json> --json',
    ),
  );
  assert(
    result.issues.includes(
      'commands.json orphan path python -m kungfu.exit_verifier --file <package.json> --json',
    ),
  );
});

test('orphan runtime API and packaged omission fail closed', () => {
  const fixture = inputs();
  fixture.kfd3.apis.push({
    id: 'kungfu.fixture.orphan',
    anchor: { kind: 'runtime-click' },
    projections: [],
  });
  fixture.index.documents = fixture.index.documents.filter(
    (row) => row.path !== 'cli_surface.catalog.json',
  );
  const result = auditCatalogParity(fixture);
  assert.equal(result.ok, false);
  assert(
    result.issues.includes('orphan runtime KFD-3 API kungfu.fixture.orphan'),
  );
  assert(
    result.issues.includes('agent pack index omits cli_surface.catalog.json'),
  );
});
