#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyGeneratorClosure } from './lib/sdk-generator.mjs';

const CONTRACT_PATH =
  'framework/core/architecture/layered-api-encoding-boundary.contract.json';
const read = (path) => fs.readFileSync(path, 'utf8');
const readJson = (path) => JSON.parse(read(path));
const sha256 = (path) =>
  createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const contract = readJson(CONTRACT_PATH);
const sourceFiles = (root) => {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'target' || entry.name === '.git') continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(target));
    else files.push(target);
  }
  return files;
};

test('the layered API contract projects one public ABI waist', () => {
  assert.equal(
    contract.$schema,
    'kungfu.layered-api-encoding-boundary.contract/v1',
  );
  assert.equal(contract.waist.bootstrap, 'kungfu_get_api');
  assert.equal(contract.waist.abiVersion, 1);
  assert.deepEqual(contract.waist.publicSymbols, ['kungfu_get_api']);
  assert.equal(
    contract.waist.rootIdentity,
    'owned-by-named-versioned-protocol',
  );

  const header = read(contract.authority.publicAbi.path);
  assert.match(header, /KF_ABI_V1\s+UINT32_C\(1\)/);
  assert.match(header, /kungfu_get_api\s*\(/);
  assert.match(header, /KF_INTERFACE_RUNTIME_ACTION\s+UINT32_C\(5\)/);
  assert.match(header, /KF_RUNTIME_ACTION_ABI_V1\s+UINT32_C\(1\)/);
  assert.equal(
    sha256(contract.authority.publicAbi.path),
    contract.authority.publicAbi.sha256,
    'public ABI projection root is stale',
  );
  assert.equal(
    contract.waist.windowsNodeRuntimeOwnership,
    'one-static-runtime-with-in-addon-kungfu-abi-bootstrap',
  );
  const nodeCmake = read('framework/core/src/bindings/node/CMakeLists.txt');
  assert.match(
    nodeCmake,
    /if\(WIN32\)[\s\S]*target_sources\(\$\{KF_NODE_BINDING_NAME\} PRIVATE \$<TARGET_OBJECTS:kungfu_abi_exports>\)/,
  );
  const coreCmake = read('framework/core/src/libkungfu/CMakeLists.txt');
  assert.match(
    coreCmake,
    /set_target_properties\(kungfu_abi PROPERTIES[\s\S]*ARCHIVE_OUTPUT_NAME kungfu_abi[\s\S]*ARCHIVE_OUTPUT_DIRECTORY \$\{KUNGFU_BUILD_DIR\}[\s\S]*\)/,
    "the Windows kungfu_abi import library must land in Cargo's native search directory",
  );
});

test('identity protocols retain their existing canonical preimages', () => {
  for (const entry of Object.values(contract.authority)) {
    assert.ok(fs.existsSync(entry.path), `missing authority ${entry.path}`);
    assert.equal(
      sha256(entry.path),
      entry.sha256,
      `stale authority root for ${entry.path}`,
    );
  }

  const classes = new Map(
    contract.identityProtocols.map((entry) => [entry.id, entry.class]),
  );
  assert.equal(
    classes.get('kungfu.fact-root.canonical/v2'),
    'closed-typed-binary',
  );
  assert.equal(
    classes.get('kungfu.episode-root-link/v1'),
    'typed-pod-field-chain',
  );
  assert.equal(
    classes.get('kungfu.action-binding/v1'),
    'implementation-local-json',
  );
  assert.equal(
    contract.identityProtocols.find(
      (entry) => entry.id === 'kungfu.action-binding/v1',
    ).portableCanonicalClaim,
    false,
  );
  assert.equal(
    classes.get('content-addressed-opaque-bytes'),
    'exact-artifact-bytes',
  );
  assert.equal(classes.get('kungfu.cut/v1'), 'canonical-json');
  assert.equal(
    contract.identityProtocols.find(
      (entry) => entry.id === 'kungfu.project-cut/v1',
    ).jsonRole,
    'legacy-identity-only',
  );

  const fact = readJson(contract.authority.factRootProtocol.path);
  assert.equal(fact.protocol.magicHex, '4b465232');
  assert.equal(fact.valueSemantics.integerTransport.includes('not'), true);
});

test('FlatBuffers carrier identity is not confused with logical identity', () => {
  assert.equal(
    contract.carrierPolicy.persistedStructuredFacts.closedKernel,
    'hana-pod',
  );
  assert.equal(
    contract.carrierPolicy.persistedStructuredFacts.openDomain,
    'flatbuffers-single-schema-owner',
  );
  assert.equal(
    contract.carrierPolicy.flatbuffers.semanticRootRule,
    'builder-buffer-is-not-a-portable-logical-preimage',
  );
  assert.match(
    contract.carrierPolicy.flatbuffers.opaqueArtifactRule,
    /content hash/,
  );

  const schemaAuthority = readJson(contract.authority.schemaOwners.path);
  assert.ok(
    schemaAuthority.authorities.some(
      (entry) => entry.owner === 'hana' && entry.identity.includes('kernel'),
    ),
  );
  assert.ok(
    schemaAuthority.authorities.some((entry) => entry.owner === 'flatbuffers'),
  );
  assert.ok(
    schemaAuthority.non_authorities.some(
      (entry) => entry.kind === 'opaque-body',
    ),
  );
});

test('the L1 SDK pilot is generated for all four language consumers', () => {
  const layer = contract.layers.find(
    (entry) => entry.id === 'l1-runtime-action',
  );
  assert.deepEqual(layer.interface, {
    id: 5,
    name: 'runtime-action',
    version: 1,
  });
  assert.equal(
    layer.protocol.requestSchema,
    'kungfu.action-runtime.operation/v1',
  );
  assert.equal(layer.protocol.encoding, 'application/json');
  assert.equal(layer.authorityDeployment.mode, 'separate-profile-registry');
  assert.equal(layer.authorityDeployment.sdkPackageOwnsProfileContracts, false);
  assert.deepEqual(contract.sdkPilot.languages, [
    'cpp',
    'node',
    'python',
    'rust',
  ]);
  assert.equal(contract.sdkPilot.operation.sideEffects, 'none');
  const generatedFiles = Object.values(contract.sdkPilot.generatedFiles);
  assert.deepEqual(Object.keys(contract.sdkPilot.generatedFiles), [
    'cpp',
    'node',
    'python',
    'rust',
  ]);
  for (const path of generatedFiles) {
    assert.ok(fs.existsSync(path), `missing generated SDK projection ${path}`);
  }
  assert.deepEqual(
    contract.sdkPilot.generatedOutputRoots.map((entry) => entry.path),
    generatedFiles,
  );
  for (const entry of contract.sdkPilot.generatedOutputRoots) {
    assert.equal(
      sha256(entry.path),
      entry.sha256,
      `generated SDK projection root is stale: ${entry.path}`,
    );
  }
  for (const path of generatedFiles) {
    const projection = read(path);
    assert.match(projection, /INTERFACE_ID/);
    assert.match(projection, /INTERFACE_VERSION/);
    assert.match(projection, /RESPONSE_SCHEMA/);
  }
  assert.equal(
    sha256(contract.conformance.fixture),
    contract.conformance.fixtureSha256,
    'cross-language wire fixture root is stale',
  );
  assert.equal(
    contract.conformance.oracle,
    'frozen-vectors-over-shared-native-authority',
  );
  assert.equal(contract.conformance.independentSerializers, false);
  const publication = Object.fromEntries(
    Object.entries(contract.sdkPilot.publication).map(([language, path]) => [
      language,
      read(path),
    ]),
  );
  assert.match(publication.cpp, /runtime_action_v1\.hpp/);
  assert.match(publication.node, /generated\/runtime-action-v1\.js/);
  assert.match(publication.python, /from \.generated import/);
  assert.match(publication.rust, /pub mod generated/);
  const nodePackage = readJson('framework/sdk/package.json');
  assert.ok(
    nodePackage.files.includes('generated'),
    'the Node package omits generated SDK projections',
  );
});

test('the layered SDK generator roots its complete executable closure', (t) => {
  const generator = contract.authority.sdkGenerator;
  const closure = {
    path: generator.path,
    root: `sha256:${generator.sha256}`,
    dependencies: generator.dependencies.map((dependency) => ({
      path: dependency.path,
      root: `sha256:${dependency.sha256}`,
    })),
  };
  assert.deepEqual(verifyGeneratorClosure(closure, process.cwd()), []);
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-layered-sdk-generator-'),
  );
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  for (const record of [closure, ...closure.dependencies]) {
    const target = path.join(temporaryRoot, record.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(record.path, target);
  }
  const helper = closure.dependencies[0].path;
  fs.appendFileSync(path.join(temporaryRoot, helper), '\n');
  assert.match(
    verifyGeneratorClosure(closure, temporaryRoot).join('\n'),
    /generator dependency scripts\/lib\/sdk-generator\.mjs: root drift/u,
  );
});

test('Xinfa keeps JSON evidence dependencies and no FlatBuffers authority', () => {
  const manifest = read(contract.xinfaBoundary.manifest);
  const lockfile = read(contract.xinfaBoundary.lockfile);
  for (const dependency of contract.xinfaBoundary.requiredDependencies) {
    assert.match(
      manifest,
      new RegExp(`^${dependency}\\s*=`, 'm'),
      `Xinfa is missing ${dependency}`,
    );
  }
  for (const dependency of contract.xinfaBoundary.forbiddenDependencies) {
    assert.doesNotMatch(
      manifest,
      new RegExp(`^${dependency}\\s*=`, 'm'),
      `Xinfa acquired forbidden dependency ${dependency}`,
    );
    assert.doesNotMatch(
      lockfile,
      new RegExp(`^name = "${dependency}"$`, 'm'),
      `Xinfa acquired transitive forbidden dependency ${dependency}`,
    );
  }
  const authoritativeSources = sourceFiles(
    path.dirname(contract.xinfaBoundary.manifest),
  ).filter((file) => /\.(?:rs|toml|json)$/.test(file));
  for (const file of authoritativeSources) {
    assert.doesNotMatch(
      read(file),
      /flatbuffers?/i,
      `Xinfa source/cache authority mentions FlatBuffers: ${file}`,
    );
  }
});

test('Work lifecycle publishes one generated operation set through the same waist', () => {
  assert.equal(contract.workLifecycle.action, 'work_lifecycle');
  assert.equal(
    contract.workLifecycle.authorityRule,
    'bindings route to the named authority and delegated mutation cannot succeed without an exact authority receipt',
  );
  for (const path of Object.values(contract.workLifecycle.generatedFiles)) {
    assert.ok(fs.existsSync(path), path);
    assert.match(read(path), /OPERATION_SET_ROOT/u);
  }
});
