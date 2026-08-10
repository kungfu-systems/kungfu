// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  compileKfxSiteBundle,
  verifyKfxSiteBundle,
} from './kfx-site-bundle.mjs';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const declaration = JSON.parse(
  fs.readFileSync(
    path.join(PACKAGE_ROOT, 'src', 'kfx-site-bundle.source.json'),
    'utf8',
  ),
);
const schema = JSON.parse(
  fs.readFileSync(
    path.join(PACKAGE_ROOT, 'schema', 'kfx-site-bundle.schema.json'),
    'utf8',
  ),
);
const REVISION = 'a'.repeat(40);

function clone(value) {
  return structuredClone(value);
}

function sourceBytes(sourcePath) {
  return Buffer.from(`fixture:${sourcePath}\n`);
}

function compile(overrides = {}) {
  return compileKfxSiteBundle({
    declaration: overrides.declaration || clone(declaration),
    schema: overrides.schema || clone(schema),
    packageVersion: '4.0.0-alpha.1',
    revision: overrides.revision || REVISION,
    expectedRevision: overrides.expectedRevision || REVISION,
    sourceLoader: overrides.sourceLoader || sourceBytes,
  });
}

function materialize(compiled) {
  const outputRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-kfx-site-bundle-'),
  );
  for (const [relative, bytes] of Object.entries(compiled.artifactBytes)) {
    const target = path.join(outputRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  return outputRoot;
}

function verify(outputRoot, overrides = {}) {
  return verifyKfxSiteBundle({
    outputRoot,
    declaration: overrides.declaration || clone(declaration),
    schema: overrides.schema || clone(schema),
    revision: overrides.revision || REVISION,
    expectedRevision: overrides.expectedRevision || REVISION,
    sourceLoader: overrides.sourceLoader || sourceBytes,
  });
}

test('generates and verifies the dedicated rooted KFX Site Bundle', () => {
  const compiled = compile();
  const outputRoot = materialize(compiled);
  const receipt = verify(outputRoot);
  assert.equal(receipt.status, 'passing');
  assert.equal(receipt.sources, declaration.sources.length);
  assert.equal(receipt.facets, declaration.facets.length);
  assert.equal(receipt.artifacts, 6);
  const bundle = compiled.artifactValues['site-bundle.json'];
  assert.equal(bundle.contract, 'kungfu.kfx-site-bundle/v1');
  assert.deepEqual(bundle.humanReadingOrder, bundle.agentReadingOrder);
  assert.ok(
    bundle.facets.every(
      (facet) =>
        facet.maturity === 'pre-release' &&
        facet.nonClaim &&
        facet.authorities.every(
          (source) =>
            source.revision === REVISION &&
            source.coordinate.includes(REVISION) &&
            source.contentRoot.startsWith('sha256:'),
        ),
    ),
  );
});

test('fails closed when a declared source is missing', () => {
  assert.throws(
    () =>
      compile({
        sourceLoader(sourcePath) {
          if (sourcePath === declaration.sources[0].path) {
            throw new Error(`declared KFX source is missing: ${sourcePath}`);
          }
          return sourceBytes(sourcePath);
        },
      }),
    /source is missing/u,
  );
});

test('rejects mutable and stale source revisions', () => {
  assert.throws(
    () => compile({ revision: 'dev/v4/v4.0' }),
    /immutable 40-character Git commit/u,
  );
  assert.throws(
    () => compile({ revision: 'b'.repeat(40), expectedRevision: REVISION }),
    /source revision is stale/u,
  );
});

test('rejects source content drift after generation', () => {
  const outputRoot = materialize(compile());
  assert.throws(
    () =>
      verify(outputRoot, {
        sourceLoader(sourcePath) {
          const bytes = sourceBytes(sourcePath);
          return sourcePath === declaration.sources[0].path
            ? Buffer.concat([bytes, Buffer.from('drift')])
            : bytes;
        },
      }),
    /source root mismatch|projected source order or content drifted/u,
  );
});

test('rejects declared facet order drift', () => {
  const changed = clone(declaration);
  [changed.humanReadingOrder[0], changed.humanReadingOrder[1]] = [
    changed.humanReadingOrder[1],
    changed.humanReadingOrder[0],
  ];
  changed.agentReadingOrder = [...changed.humanReadingOrder];
  assert.throws(
    () => compile({ declaration: changed }),
    /reading order diverges/u,
  );
});

test('rejects schema mismatch', () => {
  const changed = clone(schema);
  changed.properties.contract.const = 'kungfu.kfx-site-bundle/v2';
  assert.throws(() => compile({ schema: changed }), /schema mismatch/u);
});

test('rejects conflicting maturity', () => {
  const changed = clone(declaration);
  changed.facets[0].maturity = 'stable';
  assert.throws(
    () => compile({ declaration: changed }),
    /conflicting maturity/u,
  );
});

test('rejects fabricated roots', () => {
  const compiled = compile();
  const outputRoot = materialize(compiled);
  const bundlePath = path.join(outputRoot, 'site-bundle.json');
  const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  bundle.sourceRoot = `sha256:${'0'.repeat(64)}`;
  fs.writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  assert.throws(
    () => verify(outputRoot),
    /content root mismatch|source root mismatch/u,
  );
});

test('rejects human and Agent reading-order divergence', () => {
  const changed = clone(declaration);
  [changed.agentReadingOrder[0], changed.agentReadingOrder[1]] = [
    changed.agentReadingOrder[1],
    changed.agentReadingOrder[0],
  ];
  assert.throws(
    () => compile({ declaration: changed }),
    /Agent reading order diverges|human and Agent reading orders diverge/u,
  );
});
