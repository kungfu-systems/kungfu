#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Fail closed when KFX identity, discovery origin, or Product System metadata
// regains implicit runtime authority.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const json = (relative) => JSON.parse(read(relative));

const sourceContract = json('config/kungfu-kfx.contract.json');
const packageContract = json('framework/kfx/kungfu-kfx.contract.json');
assert.deepEqual(
  packageContract,
  sourceContract,
  'KFX package contract diverged from the canonical config contract',
);

const native = sourceContract.nativeRuntime;
assert.equal(native.contractVersion, 3);
assert.deepEqual(native.versionNegotiation.supported, [3]);
assert.equal(native.coreCapabilityPolicy.identityAuthority, false);
assert.equal(native.coreCapabilityPolicy.originAuthority, false);
assert.equal(native.coreCapabilityPolicy.productAssemblyAuthority, false);
assert.equal(native.coreCapabilityPolicy.kfdAuthority, 'eligibility-only');
assert.deepEqual(native.runtimeTiers, [
  'isolated',
  'integrated-explicit',
  'metadata-only',
]);
assert.deepEqual(native.admissionGrades, [
  'unverified',
  'identity-verified',
  'kfd-attested',
]);

const forbiddenSourcePattern =
  /firstParty|first_party|KF_FIRST_PARTY|isFirstParty|productSystem|product-system|system-role|systemAuthority|systemCapabilities|productSystemRoots/u;
const authorityEdges = [
  'framework/kfx/src/index.ts',
  'framework/api/src/capability/kfx-host.ts',
  'framework/api/src/capability/service-authz.ts',
  'framework/gui/src/main/index.ts',
  'framework/gui/src/navigation.ts',
  'framework/gui/src/main/session-window-authorization.ts',
  'framework/gui/src/main/session-windows-host.ts',
  'framework/gui/src/renderer/src/kfx-loader.ts',
  'framework/gui/src/renderer/session-window/main.tsx',
  'framework/tui/src/kfx-host.ts',
  'framework/tui/src/kfx-plan-parity.ts',
  'framework/tui/src/service-host.ts',
  'framework/core/src/python/kungfu/cli/commands/kfx.py',
  'framework/core/src/python/kungfu/host.py',
  'framework/core/src/python/kungfu/rewind/adapters.py',
];
for (const relative of authorityEdges) {
  assert.doesNotMatch(
    read(relative),
    forbiddenSourcePattern,
    `${relative} contains an identity- or origin-derived authority shortcut`,
  );
}

for (const removed of [
  'framework/kfx/schema/first-party-manifest.schema.json',
  'framework/gui/scripts/gen-first-party-manifest.mjs',
  'framework/gui/src/main/first-party-manifest.ts',
  'framework/core/src/python/kungfu/rewind/first_party.py',
]) {
  assert.equal(
    fs.existsSync(path.join(ROOT, removed)),
    false,
    `${removed} resurrected a parallel identity authority`,
  );
}

const forbiddenManifestKeys = new Set([
  'firstParty',
  'productSystem',
  'systemAuthority',
  'trusted',
  'supportsKFD',
  'system',
  'runtimeTier',
]);
const inspectManifestObject = (value, relative) => {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(
      forbiddenManifestKeys.has(key),
      false,
      `${relative} self-declares forbidden authority key ${key}`,
    );
    inspectManifestObject(child, relative);
  }
};

const extensionRoot = path.join(ROOT, 'extensions');
const manifests = [];
for (const suiteOrPackage of fs.readdirSync(extensionRoot)) {
  const first = path.join(extensionRoot, suiteOrPackage);
  const candidates = [first];
  if (fs.statSync(first).isDirectory()) {
    for (const child of fs.readdirSync(first))
      candidates.push(path.join(first, child));
  }
  for (const candidate of candidates) {
    const manifestPath = path.join(candidate, 'kungfu.kfx.json');
    if (fs.existsSync(manifestPath)) manifests.push(manifestPath);
    const transportPath = path.join(candidate, 'package.json');
    if (fs.existsSync(transportPath)) {
      const transport = JSON.parse(fs.readFileSync(transportPath, 'utf8'));
      assert.equal(
        Object.hasOwn(transport, 'kungfuConfig'),
        false,
        `${path.relative(ROOT, transportPath)} claims KFX semantic authority`,
      );
    }
  }
}

assert.ok(manifests.length > 0, 'no product KFX manifests were inspected');
for (const manifestPath of manifests) {
  const relative = path.relative(ROOT, manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  inspectManifestObject(manifest, relative);
  const facets = manifest.kungfuConfig?.config ?? {};
  for (const [facet, declaration] of Object.entries(facets)) {
    if (!['view', 'adapter', 'service', 'wasm'].includes(facet)) continue;
    assert.ok(
      Array.isArray(declaration.capabilities),
      `${relative} ${facet} must explicitly declare its least capability set`,
    );
  }
}

console.log(
  `[kfx-identity-neutral-authority] contract=v${native.contractVersion} manifests=${manifests.length} authorityEdges=${authorityEdges.length}`,
);
