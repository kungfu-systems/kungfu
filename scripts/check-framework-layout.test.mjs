// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  collectFrameworkLayoutIssues,
  discoverFrameworkDependencies,
  validateFrameworkLayout,
} from './check-framework-layout.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_REGISTRY = {
  schema: 'kungfu.npm-release-package-registry/v1',
  packages: [
    {
      name: '@kungfu-tech/alpha',
      kind: 'workspace',
      source: 'framework/alpha/package.json',
    },
  ],
};

function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-framework-layout-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['alpha', 'beta', 'release'])
    fs.mkdirSync(path.join(root, 'framework', directory), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'framework/alpha/package.json'),
    JSON.stringify({ name: '@kungfu-tech/alpha' }),
  );
  fs.writeFileSync(
    path.join(root, 'framework/alpha/index.js'),
    'export const alpha = true;\n',
  );
  fs.writeFileSync(
    path.join(root, 'framework/beta/index.mjs'),
    'import(`../alpha/index.js`);\n',
  );
  const manifest = {
    schema: 'kungfu.framework-layout-manifest/v1',
    frameworkRoot: 'framework',
    releaseRegistry: 'framework/release/npm-package-registry.json',
    entries: [
      {
        path: 'framework/alpha',
        distribution: 'npm-package',
        role: 'runtime-package',
        boundaryReview: 'none',
        packageName: '@kungfu-tech/alpha',
        dependencies: [],
      },
      {
        path: 'framework/beta',
        distribution: 'source-only',
        role: 'internal-library',
        boundaryReview: 'candidate',
        dependencies: ['framework/alpha'],
      },
      {
        path: 'framework/release',
        distribution: 'source-only',
        role: 'repository-tool',
        boundaryReview: 'none',
        dependencies: [],
      },
    ],
  };
  return { root, manifest };
}

function codes(result) {
  return result.issues.map((entry) => entry.code);
}

function completeBoundary(entry, overrides = {}) {
  entry.boundaryReview = 'complete';
  entry.boundary = {
    disposition: 'repository-stable',
    stableEntrypoints: [`${entry.path}/index.mjs`],
    consumers: [],
    deepImportPolicy: 'stable-entrypoints-with-exact-legacy-ratchet',
    legacyDeepImports: [],
    ...overrides,
  };
  return entry;
}

test('accepts an exact framework classification and dependency map', (t) => {
  const { root, manifest } = fixture(t);
  assert.deepEqual(discoverFrameworkDependencies({ root }), {
    'framework/alpha': [],
    'framework/beta': ['framework/alpha'],
    'framework/release': [],
  });
  assert.deepEqual(
    validateFrameworkLayout({
      root,
      manifest,
      releaseRegistry: RELEASE_REGISTRY,
    }),
    { ok: true, issues: [] },
  );
});

test('fails closed when a framework directory is not classified', (t) => {
  const { root, manifest } = fixture(t);
  manifest.entries = manifest.entries.filter(
    (entry) => entry.path !== 'framework/beta',
  );
  const issues = collectFrameworkLayoutIssues({
    root,
    manifest,
    releaseRegistry: RELEASE_REGISTRY,
  });
  assert.ok(issues.some((entry) => entry.code === 'directory-missing'));
});

test('fails when source-only and npm package authorities disagree', (t) => {
  const { root, manifest } = fixture(t);
  const alpha = manifest.entries.find(
    (entry) => entry.path === 'framework/alpha',
  );
  alpha.distribution = 'source-only';
  Reflect.deleteProperty(alpha, 'packageName');
  const result = validateFrameworkLayout({
    root,
    manifest,
    releaseRegistry: RELEASE_REGISTRY,
  });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('source-only-package'));
  assert.ok(codes(result).includes('release-package-drift'));
});

test('fails for both undeclared and stale cross-directory dependencies', (t) => {
  const { root, manifest } = fixture(t);
  const beta = manifest.entries.find(
    (entry) => entry.path === 'framework/beta',
  );
  beta.dependencies = [];
  let result = validateFrameworkLayout({
    root,
    manifest,
    releaseRegistry: RELEASE_REGISTRY,
  });
  assert.ok(codes(result).includes('dependency-drift'));

  beta.dependencies = ['framework/alpha'];
  const release = manifest.entries.find(
    (entry) => entry.path === 'framework/release',
  );
  release.dependencies = ['framework/alpha'];
  result = validateFrameworkLayout({
    root,
    manifest,
    releaseRegistry: RELEASE_REGISTRY,
  });
  assert.ok(codes(result).includes('dependency-drift'));
});

test('accepts a completed source boundary with resolved stable paths', (t) => {
  const { root, manifest } = fixture(t);
  const beta = manifest.entries.find(
    (entry) => entry.path === 'framework/beta',
  );
  completeBoundary(beta);
  assert.deepEqual(
    validateFrameworkLayout({
      root,
      manifest,
      releaseRegistry: RELEASE_REGISTRY,
    }),
    { ok: true, issues: [] },
  );
});

test('fails closed for missing stable entrypoints and consumer paths', (t) => {
  const { root, manifest } = fixture(t);
  const beta = manifest.entries.find(
    (entry) => entry.path === 'framework/beta',
  );
  completeBoundary(beta, {
    stableEntrypoints: ['framework/beta/missing.mjs'],
    consumers: ['framework/missing-consumer'],
  });
  const result = validateFrameworkLayout({
    root,
    manifest,
    releaseRegistry: RELEASE_REGISTRY,
  });
  assert.ok(codes(result).includes('boundary-entrypoint-missing'));
  assert.ok(codes(result).includes('boundary-consumer-missing'));
});

test('fails when completed boundaries form a dependency cycle', (t) => {
  const { root, manifest } = fixture(t);
  const beta = manifest.entries.find(
    (entry) => entry.path === 'framework/beta',
  );
  const release = manifest.entries.find(
    (entry) => entry.path === 'framework/release',
  );
  completeBoundary(beta, { consumers: ['framework/release'] });
  completeBoundary(release, { consumers: ['framework/beta'] });
  beta.dependencies = ['framework/alpha', 'framework/release'];
  release.dependencies = ['framework/beta'];
  fs.writeFileSync(
    path.join(root, 'framework/beta/index.mjs'),
    "import '../alpha/index.js';\nimport '../release/index.mjs';\n",
  );
  fs.writeFileSync(
    path.join(root, 'framework/release/index.mjs'),
    "import '../beta/index.mjs';\n",
  );
  const result = validateFrameworkLayout({
    root,
    manifest,
    releaseRegistry: RELEASE_REGISTRY,
  });
  assert.ok(codes(result).includes('boundary-cycle'));
});

test('rejects a new private deep import outside the exact ratchet', (t) => {
  const { root, manifest } = fixture(t);
  const beta = manifest.entries.find(
    (entry) => entry.path === 'framework/beta',
  );
  const release = manifest.entries.find(
    (entry) => entry.path === 'framework/release',
  );
  completeBoundary(beta, { consumers: ['framework/release'] });
  release.dependencies = ['framework/beta'];
  fs.writeFileSync(
    path.join(root, 'framework/beta/private.mjs'),
    'export const privateValue = true;\n',
  );
  fs.writeFileSync(
    path.join(root, 'framework/release/check.mjs'),
    "import '../beta/private.mjs';\n",
  );
  const result = validateFrameworkLayout({
    root,
    manifest,
    releaseRegistry: RELEASE_REGISTRY,
  });
  assert.ok(codes(result).includes('legacy-deep-import-drift'));
});

test('rejects stale and duplicate legacy deep-import entries', (t) => {
  const { root, manifest } = fixture(t);
  const beta = manifest.entries.find(
    (entry) => entry.path === 'framework/beta',
  );
  const stale = {
    importer: 'framework/release/index.mjs',
    target: 'framework/beta/private.mjs',
  };
  fs.writeFileSync(
    path.join(root, 'framework/release/index.mjs'),
    'export const release = true;\n',
  );
  fs.writeFileSync(
    path.join(root, 'framework/beta/private.mjs'),
    'export const privateValue = true;\n',
  );
  completeBoundary(beta, {
    consumers: ['framework/release'],
    legacyDeepImports: [stale, stale],
  });
  const result = validateFrameworkLayout({
    root,
    manifest,
    releaseRegistry: RELEASE_REGISTRY,
  });
  assert.ok(codes(result).includes('legacy-deep-import-order'));
  assert.ok(codes(result).includes('legacy-deep-import-drift'));
});

test('the repository matches its framework layout manifest', () => {
  const result = validateFrameworkLayout({ root: ROOT });
  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'framework/layout.manifest.json'), 'utf8'),
  );
  assert.deepEqual(
    manifest.entries
      .filter((entry) => entry.boundaryReview === 'complete')
      .map((entry) => entry.path),
    [
      'framework/action',
      'framework/assignment-runtime',
      'framework/evidence',
      'framework/project-cut',
    ],
  );
});
