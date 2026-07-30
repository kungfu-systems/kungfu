// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  collectNpmRegistryIssues,
  loadComponentDistributionInputs,
  validateComponentDistribution,
} from './check-npm-package-registry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(
  fs.readFileSync(
    path.join(root, 'framework/release/npm-package-registry.json'),
    'utf8',
  ),
);

test('accepts the exact 29-package Release inventory', () => {
  assert.deepEqual(collectNpmRegistryIssues({ root, registry: source }), []);
});

test('rejects package-count and rollback drift', () => {
  const registry = structuredClone(source);
  registry.packages.pop();
  registry.rollback.unpublishAllowed = true;
  const codes = collectNpmRegistryIssues({ root, registry }).map(
    (entry) => entry.code,
  );
  assert.ok(codes.includes('count'));
  assert.ok(codes.includes('rollback'));
});

test('rejects private package sources and an incomplete exact artifact set', (t) => {
  const registry = structuredClone(source);
  registry.trustedPublishing.exactArtifactPackages.pop();
  const packagePath = path.join(root, registry.packages[0].source);
  const packageSource = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-npm-registry-test-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.mkdirSync(
    path.dirname(path.join(temporary, registry.packages[0].source)),
    {
      recursive: true,
    },
  );
  fs.writeFileSync(
    path.join(temporary, registry.packages[0].source),
    JSON.stringify({ ...packageSource, private: true }),
  );
  for (const entry of registry.packages.slice(1)) {
    const sourcePath = path.join(root, entry.source.split('#')[0]);
    if (!fs.existsSync(sourcePath)) continue;
    const targetPath = path.join(temporary, entry.source.split('#')[0]);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
  const codes = collectNpmRegistryIssues({ root: temporary, registry }).map(
    (entry) => entry.code,
  );
  assert.ok(codes.includes('source-private'));
  assert.ok(codes.includes('exact-artifacts'));
});

test('component distribution closes embedded, standalone, and npm boundaries', () => {
  assert.deepEqual(
    validateComponentDistribution(loadComponentDistributionInputs()),
    [],
  );
});

test('component distribution rejects a second Core npm executable', () => {
  const inputs = structuredClone(loadComponentDistributionInputs());
  inputs.corePackage.bin.shifu = 'lib/shifu.js';
  assert.match(
    validateComponentDistribution(inputs).join('\n'),
    /exactly the kungfu bin/u,
  );
});

test('component distribution rejects unsigned release workflow drift', () => {
  const inputs = structuredClone(loadComponentDistributionInputs());
  inputs.workflow = inputs.workflow.replace(
    'actions/attest-build-provenance@',
    'actions/removed@',
  );
  assert.match(
    validateComponentDistribution(inputs).join('\n'),
    /actions\/attest-build-provenance/u,
  );
});
