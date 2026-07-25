// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  bulkWorkspaceEntries,
  collectPublishabilityIssues,
  npmArchiveName,
  npmDistributionTag,
  validateStagedNpmArtifacts,
} from './npm-release-inventory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(
  fs.readFileSync(
    path.join(root, 'framework/release/npm-package-registry.json'),
    'utf8',
  ),
);
const version = JSON.parse(
  fs.readFileSync(path.join(root, 'lerna.json')),
).version;

test('all 28 packages are public and exactly 19 use portable workspace packing', () => {
  assert.deepEqual(collectPublishabilityIssues({ root, registry }), []);
  assert.equal(registry.packages.length, 28);
  assert.equal(bulkWorkspaceEntries(registry).length, 19);
  assert.equal(registry.trustedPublishing.exactArtifactPackages.length, 28);
});

test('private and non-public workspace packages fail closed', (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-npm-public-test-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.writeFileSync(path.join(temporary, 'lerna.json'), '{"version":"1.0.0"}');
  fs.mkdirSync(path.join(temporary, 'package'));
  fs.writeFileSync(
    path.join(temporary, 'package', 'package.json'),
    JSON.stringify({
      name: '@kungfu-tech/example',
      version: '1.0.0',
      private: true,
    }),
  );
  const fixture = {
    releaseInventory: { versionAuthority: 'lerna.json' },
    workspacePacking: { dedicatedPackages: [], bulkPackageCount: 1 },
    packages: [
      {
        name: '@kungfu-tech/example',
        kind: 'workspace',
        source: 'package/package.json',
      },
    ],
  };
  const issues = collectPublishabilityIssues({
    root: temporary,
    registry: fixture,
  });
  assert.ok(issues.some((entry) => entry.includes('private must be removed')));
  assert.ok(issues.some((entry) => entry.includes('public publishConfig')));
});

test('the staged npm set must contain one exact archive for every package', () => {
  const artifacts = registry.packages.map((entry) => ({
    kind: 'npm',
    name: npmArchiveName(entry.name, version),
    digest: '0'.repeat(64),
  }));
  assert.equal(
    validateStagedNpmArtifacts({ artifacts }, registry, version).size,
    28,
  );
  artifacts.pop();
  assert.throws(
    () => validateStagedNpmArtifacts({ artifacts }, registry, version),
    /expected 28 npm artifacts, found 27/u,
  );
});

test('npm distribution tags are deterministic and prereleases never become latest', () => {
  assert.equal(npmDistributionTag('4.0.0-alpha.1'), 'alpha');
  assert.equal(npmDistributionTag('4.0.0-beta.2'), 'beta');
  assert.equal(npmDistributionTag('4.0.0-rc.3'), 'next');
  assert.equal(npmDistributionTag('4.0.0'), 'latest');
  assert.throws(() => npmDistributionTag('4.0.0-preview.1'), /unsupported/u);
});
