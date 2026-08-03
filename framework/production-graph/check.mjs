#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  SCHEMA_PATHS,
  applyFixtureMutation,
  contractRoot,
  fileRoot,
  loadFixture,
  loadProductionGraphContract,
  materializeFixture,
  rooted,
  schemaValidators,
  semanticRoot,
  verifyBundle,
} from './contract.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const FIXTURE_ROOT = 'docs/shifu/examples/production-graph';
const INVALID_ROOT = `${FIXTURE_ROOT}/invalid`;

function fixtureFiles(relativeRoot) {
  return fs
    .readdirSync(path.join(ROOT, relativeRoot))
    .filter((name) => name.endsWith('.fixture.json'))
    .sort()
    .map((name) => `${relativeRoot}/${name}`);
}

function verifyContractBoundary(contract) {
  assert.equal(contract.schema, 'shifu.production-graph-contract/v0');
  assert.deepEqual(contract.schemas, SCHEMA_PATHS);
  assert.equal(contract.verification.command, './shifu check:production-graph');
  assert.equal(contract.verification.protectedGate, './shifu check:source');
  assert.equal(contract.verification.executesNodes, false);
  assert.equal(contract.authorityReferences.semanticImpactOwner, 'xinfa');
  assert.equal(
    contract.authorityReferences.semanticImpactInput,
    'graph.semanticImpact.selectionRoot',
  );
  assert.deepEqual(contract.authorityBoundary.forbiddenOperations, [
    'capture',
    'claim',
    'dispatch',
    'execute',
    'approve',
    'merge',
    'close',
  ]);
}

function verifierRoot() {
  return semanticRoot(
    [
      'framework/production-graph/contract.mjs',
      'framework/production-graph/check.mjs',
      'framework/production-graph/check.test.mjs',
    ].map((relative) => ({
      path: relative,
      root: fileRoot(path.join(ROOT, relative)),
    })),
  );
}

export async function checkProductionGraphContract() {
  const contract = loadProductionGraphContract(ROOT);
  verifyContractBoundary(contract);
  const validators = await schemaValidators(ROOT);
  const validFiles = fixtureFiles(FIXTURE_ROOT);
  const invalidFiles = fixtureFiles(INVALID_ROOT);
  assert.equal(
    validFiles.length,
    3,
    'exactly three valid outcome fixtures are required',
  );
  assert.ok(
    invalidFiles.length >= 7,
    'at least seven negative fixtures are required',
  );

  const fixtureSources = validFiles.map((relative) => ({
    relative,
    fixture: loadFixture(ROOT, relative),
  }));
  const sourceById = new Map(
    fixtureSources.map(({ fixture }) => [fixture.fixtureId, fixture]),
  );
  const valid = new Map();
  for (const { relative, fixture: sourceFixture } of fixtureSources) {
    const inherited = sourceFixture.graphFixture
      ? sourceById.get(sourceFixture.graphFixture)
      : null;
    assert.ok(
      !sourceFixture.graphFixture || inherited,
      `${relative}: unknown graph fixture ${sourceFixture.graphFixture}`,
    );
    const fixture = {
      ...sourceFixture,
      context: sourceFixture.context || inherited?.context,
      graph: sourceFixture.graph || inherited?.graph,
    };
    const bundle = materializeFixture(fixture, ROOT);
    const result = await verifyBundle(bundle, fixture.context, {
      root: ROOT,
      validators,
    });
    assert.equal(
      result.valid,
      true,
      `${relative}: ${JSON.stringify(result.diagnostics)}`,
    );
    valid.set(fixture.fixtureId, { fixture, bundle });
  }

  for (const relative of invalidFiles) {
    const fixture = loadFixture(ROOT, relative);
    const base = valid.get(fixture.baseFixture);
    assert.ok(base, `${relative}: unknown base fixture ${fixture.baseFixture}`);
    const mutated = applyFixtureMutation(
      base.bundle,
      base.fixture.context,
      fixture.mutation,
    );
    const result = await verifyBundle(mutated.bundle, mutated.context, {
      root: ROOT,
      validators,
    });
    assert.equal(result.valid, false, `${relative}: negative fixture passed`);
    assert.ok(
      result.diagnostics.some(({ code }) => code === fixture.expect),
      `${relative}: expected ${fixture.expect}, got ${JSON.stringify(result.diagnostics)}`,
    );
  }

  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  const receipt = rooted(
    {
      schema: 'shifu.production-graph-verification-receipt/v0',
      status: 'qualified',
      sourceRevision,
      contractRoot: contractRoot(ROOT),
      schemaRoots: Object.fromEntries(
        Object.entries(SCHEMA_PATHS).map(([kind, relative]) => [
          kind,
          semanticRoot(loadFixture(ROOT, relative)),
        ]),
      ),
      authorityReferences: {
        layers: fileRoot(path.join(ROOT, contract.authorityReferences.layers)),
        buildCapabilities: fileRoot(
          path.join(ROOT, contract.authorityReferences.buildCapabilities),
        ),
      },
      verifierRoot: verifierRoot(),
      validFixtureRoots: [...valid.values()].map(
        ({ bundle }) => bundle.receipt.receiptRoot,
      ),
      validFixtureCount: validFiles.length,
      invalidFixtureCount: invalidFiles.length,
      protectedGate: './shifu check:source',
      nodesExecuted: false,
    },
    'receiptRoot',
  );
  const validateReceipt = validators.verificationReceipt;
  assert.equal(
    validateReceipt(receipt),
    true,
    JSON.stringify(validateReceipt.errors),
  );
  return receipt;
}

async function main() {
  console.log(JSON.stringify(await checkProductionGraphContract(), null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
}
