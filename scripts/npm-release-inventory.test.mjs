// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

import tar from 'tar-stream';

import {
  bulkWorkspaceEntries,
  canonicalizePackedArchive,
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

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function writePackedFixture(file, manifest, body = 'same') {
  const pack = tar.pack();
  const write = pipeline(pack, createGzip(), fs.createWriteStream(file));
  await new Promise((resolve, reject) => {
    pack.entry(
      {
        name: 'package/package.json',
        mode: 0o644,
        uid: 501,
        gid: 20,
        mtime: new Date(),
      },
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
      (error) => (error ? reject(error) : resolve()),
    );
  });
  await new Promise((resolve, reject) => {
    pack.entry(
      {
        name: 'package/index.js',
        mode: 0o644,
        uid: 501,
        gid: 20,
        mtime: new Date(),
      },
      Buffer.from(body),
      (error) => (error ? reject(error) : resolve()),
    );
  });
  pack.finalize();
  await write;
}

test('all 29 packages are public and exactly 19 use portable workspace packing', () => {
  assert.deepEqual(collectPublishabilityIssues({ root, registry }), []);
  assert.equal(registry.packages.length, 29);
  assert.equal(bulkWorkspaceEntries(registry).length, 19);
  assert.equal(registry.trustedPublishing.exactArtifactPackages.length, 29);
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
    29,
  );
  artifacts.pop();
  assert.throws(
    () => validateStagedNpmArtifacts({ artifacts }, registry, version),
    /expected 29 npm artifacts, found 28/u,
  );
});

test('npm distribution tags are deterministic and prereleases never become latest', () => {
  assert.equal(npmDistributionTag('4.0.0-alpha.1'), 'alpha');
  assert.equal(npmDistributionTag('4.0.0-beta.2'), 'beta');
  assert.equal(npmDistributionTag('4.0.0-rc.3'), 'next');
  assert.equal(npmDistributionTag('4.0.0'), 'latest');
  assert.throws(() => npmDistributionTag('4.0.0-preview.1'), /unsupported/u);
});

test('packed workspace manifests are byte-stable without hiding content drift', async (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-npm-canonical-test-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const first = path.join(temporary, 'first.tgz');
  const reordered = path.join(temporary, 'reordered.tgz');
  const changed = path.join(temporary, 'changed.tgz');
  await writePackedFixture(first, {
    name: '@kungfu-tech/example',
    dependencies: { beta: '1.0.0', alpha: '1.0.0' },
  });
  await writePackedFixture(reordered, {
    dependencies: { alpha: '1.0.0', beta: '1.0.0' },
    name: '@kungfu-tech/example',
  });
  await writePackedFixture(
    changed,
    {
      dependencies: { alpha: '1.0.0', beta: '1.0.0' },
      name: '@kungfu-tech/example',
    },
    'changed',
  );

  await canonicalizePackedArchive(first);
  await canonicalizePackedArchive(reordered);
  await canonicalizePackedArchive(changed);
  assert.equal(sha256(first), sha256(reordered));
  assert.notEqual(sha256(first), sha256(changed));
});
