// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CONTRACT_ENVELOPE_PATH,
  ENVELOPE_PATHS,
  validateRegistryEnvelope,
  writeRegistryEnvelope,
} from './registry-envelope.mjs';

const ROOT = process.cwd();
const ENVELOPE_SCHEMA_PATH =
  'framework/spec/registry/schema/registry-envelope-v1.schema.json';
const readJson = (root, relative) =>
  JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));

function copyFile(root, temporaryRoot, relative) {
  const target = path.join(temporaryRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, relative), target);
}

function copyEnvelopeFixture(envelope) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-registry-envelope-'),
  );
  for (const relative of [
    ENVELOPE_SCHEMA_PATH,
    ...ENVELOPE_PATHS,
    envelope.registry.source,
    envelope.registry.schemaPath,
    ...envelope.projections.flatMap((projection) => [
      projection.source,
      projection.artifact,
    ]),
  ])
    copyFile(ROOT, temporaryRoot, relative);
  return temporaryRoot;
}

test('contract and invariant envelopes validate current generated projections', () => {
  for (const relative of ENVELOPE_PATHS) {
    const envelope = readJson(ROOT, relative);
    assert.deepEqual(validateRegistryEnvelope(envelope), [], relative);
  }
});

test('registry entry identity duplication fails closed', (t) => {
  const envelope = readJson(ROOT, ENVELOPE_PATHS[0]);
  const temporaryRoot = copyEnvelopeFixture(envelope);
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const registry = readJson(temporaryRoot, envelope.registry.source);
  registry.contracts.push(structuredClone(registry.contracts[0]));
  fs.writeFileSync(
    path.join(temporaryRoot, envelope.registry.source),
    `${JSON.stringify(registry, null, 2)}\n`,
  );
  assert.match(
    validateRegistryEnvelope(envelope, temporaryRoot).join('\n'),
    /duplicate surface: config/u,
  );
});

test('generated projection mutation fails closed on its declared root', (t) => {
  const envelope = readJson(ROOT, ENVELOPE_PATHS[1]);
  const temporaryRoot = copyEnvelopeFixture(envelope);
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const artifact = envelope.projections[0].artifact;
  fs.appendFileSync(path.join(temporaryRoot, artifact), '\n');
  assert.match(
    validateRegistryEnvelope(envelope, temporaryRoot).join('\n'),
    /artifact drift/u,
  );
});

test('scoped matrix projection does not rewrite the contract registry artifact', (t) => {
  const envelope = readJson(ROOT, CONTRACT_ENVELOPE_PATH);
  const temporaryRoot = copyEnvelopeFixture(envelope);
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const registryProjection = envelope.projections.find(
    (projection) => projection.id === 'contract-registry',
  );
  const matrixProjection = envelope.projections.find(
    (projection) => projection.id === 'work-lifecycle-operation-matrix',
  );
  const registryArtifact = path.join(
    temporaryRoot,
    registryProjection.artifact,
  );
  const registryBytes = fs.readFileSync(registryArtifact);
  fs.appendFileSync(path.join(temporaryRoot, matrixProjection.source), '\n');
  writeRegistryEnvelope(CONTRACT_ENVELOPE_PATH, {
    root: temporaryRoot,
    projectionIds: ['work-lifecycle-operation-matrix'],
  });
  assert.deepEqual(fs.readFileSync(registryArtifact), registryBytes);
  assert.deepEqual(
    fs.readFileSync(path.join(temporaryRoot, matrixProjection.artifact)),
    fs.readFileSync(path.join(temporaryRoot, matrixProjection.source)),
  );
});

test('invalid registry content fails before artifact or envelope writes', (t) => {
  const envelope = readJson(ROOT, CONTRACT_ENVELOPE_PATH);
  const temporaryRoot = copyEnvelopeFixture(envelope);
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const registry = readJson(temporaryRoot, envelope.registry.source);
  registry.contracts.push(structuredClone(registry.contracts[0]));
  fs.writeFileSync(
    path.join(temporaryRoot, envelope.registry.source),
    `${JSON.stringify(registry, null, 2)}\n`,
  );
  const artifactPath = path.join(
    temporaryRoot,
    envelope.projections[0].artifact,
  );
  const envelopePath = path.join(temporaryRoot, CONTRACT_ENVELOPE_PATH);
  const artifactBytes = fs.readFileSync(artifactPath);
  const envelopeBytes = fs.readFileSync(envelopePath);
  assert.throws(
    () =>
      writeRegistryEnvelope(CONTRACT_ENVELOPE_PATH, { root: temporaryRoot }),
    /duplicate surface: config/u,
  );
  assert.deepEqual(fs.readFileSync(artifactPath), artifactBytes);
  assert.deepEqual(fs.readFileSync(envelopePath), envelopeBytes);
});
