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

test('accepts the exact 33-package Release inventory', () => {
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
    const sourceManifest = path.join(
      path.dirname(sourcePath),
      'kungfu.kfx.json',
    );
    if (!fs.existsSync(sourceManifest)) continue;
    const targetManifest = path.join(
      path.dirname(targetPath),
      'kungfu.kfx.json',
    );
    fs.copyFileSync(sourceManifest, targetManifest);
    const profile = JSON.parse(fs.readFileSync(sourceManifest, 'utf8'))
      .kungfuConfig?.suite?.profile;
    if (profile)
      fs.copyFileSync(
        path.join(path.dirname(sourceManifest), profile),
        path.join(path.dirname(targetManifest), profile),
      );
  }
  const codes = collectNpmRegistryIssues({ root: temporary, registry }).map(
    (entry) => entry.code,
  );
  assert.ok(codes.includes('source-private'));
  assert.ok(codes.includes('exact-artifacts'));
});

test('rejects KFX manifest and Suite profile version drift', (t) => {
  const registry = structuredClone(source);
  const suite = registry.packages.find(
    ({ name }) => name === '@kungfu-tech/kfx-suite-github-webhook-reference',
  );
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-npm-kfx-identity-test-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  for (const entry of registry.packages) {
    const source = entry.source.split('#')[0];
    const sourcePath = path.join(root, source);
    if (!fs.existsSync(sourcePath)) continue;
    const targetPath = path.join(temporary, source);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    if (!entry.source.startsWith('extensions/')) continue;
    const sourceDirectory = path.dirname(sourcePath);
    const targetDirectory = path.dirname(targetPath);
    fs.copyFileSync(
      path.join(sourceDirectory, 'kungfu.kfx.json'),
      path.join(targetDirectory, 'kungfu.kfx.json'),
    );
    const profile = JSON.parse(
      fs.readFileSync(path.join(sourceDirectory, 'kungfu.kfx.json'), 'utf8'),
    ).kungfuConfig?.suite?.profile;
    if (profile)
      fs.copyFileSync(
        path.join(sourceDirectory, profile),
        path.join(targetDirectory, profile),
      );
  }
  const manifestPath = path.join(
    temporary,
    path.dirname(suite.source),
    'kungfu.kfx.json',
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = '0.1.0';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const codes = collectNpmRegistryIssues({ root: temporary, registry }).map(
    (entry) => entry.code,
  );
  assert.ok(codes.includes('kfx-identity-drift'));
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

test('component distribution rejects native component version drift', () => {
  const inputs = structuredClone(loadComponentDistributionInputs());
  inputs.xinfaCargo = inputs.xinfaCargo.replace(
    /^version = "[^"]+"$/mu,
    'version = "0.1.0"',
  );
  assert.match(
    validateComponentDistribution(inputs).join('\n'),
    /xinfa user-visible version must match Kungfu/u,
  );
});

test('component distribution rejects version-policy drift', () => {
  const inputs = structuredClone(loadComponentDistributionInputs());
  inputs.contract.components.find(({ id }) => id === 'xinfa').versionPolicy =
    'independent';
  assert.match(
    validateComponentDistribution(inputs).join('\n'),
    /xinfa user-visible version must match Kungfu/u,
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
