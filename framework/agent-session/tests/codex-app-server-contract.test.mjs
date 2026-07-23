// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CodexAppServerContractError,
  createCodexAppServerContractGate,
  loadCodexAppServerContract,
  loadCodexAppServerSchemaManifest,
  verifyCodexAppServerSchemaManifest,
} from '../src/codex-app-server-contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function fixture(name) {
  return JSON.parse(
    fs.readFileSync(
      path.join(here, 'fixtures', 'codex-app-server', name),
      'utf8',
    ),
  );
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof CodexAppServerContractError);
    assert.equal(error.code, code);
    return true;
  });
}

test('pinned stable schema manifest has a self-recomputing deterministic bundle digest', () => {
  const manifest = loadCodexAppServerSchemaManifest();
  assert.deepEqual(verifyCodexAppServerSchemaManifest(manifest), {
    fileCount: 267,
    sha256: 'db6486174d318cc61d0ea100b5cfc9f6c3441d3a7c402382f971477802d11af7',
  });
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(manifest.protocolInventory).map(([key, value]) => [
        key,
        value.count,
      ]),
    ),
    {
      clientRequests: 87,
      clientNotifications: 1,
      serverRequests: 10,
      serverNotifications: 68,
    },
  );

  const tampered = structuredClone(manifest);
  tampered.bundle.files[0].canonicalBytes += 1;
  expectCode(
    () => verifyCodexAppServerSchemaManifest(tampered),
    'schema-manifest-digest',
  );
});

test('contract gate pins CLI, stable schema and non-experimental capability shape', () => {
  const contract = loadCodexAppServerContract();
  const manifest = loadCodexAppServerSchemaManifest(contract);
  const gate = createCodexAppServerContractGate({
    contract,
    manifest,
    cliVersion: '0.144.3',
    initializeCapabilities: {},
  });
  assert.equal(gate.provider, 'codex');
  assert.equal(gate.experimentalApi, false);

  expectCode(
    () =>
      createCodexAppServerContractGate({
        contract,
        manifest,
        cliVersion: '0.145.0',
      }),
    'cli-version-drift',
  );
  expectCode(
    () =>
      createCodexAppServerContractGate({
        contract,
        manifest,
        cliVersion: '0.144.3',
        initializeCapabilities: { experimentalApi: true },
      }),
    'experimental-api',
  );
  expectCode(
    () =>
      createCodexAppServerContractGate({
        contract,
        manifest,
        cliVersion: '0.144.3',
        initializeCapabilities: {
          optOutNotificationMethods: ['turn/completed'],
        },
      }),
    'capability-drift',
  );

  const driftedContract = structuredClone(contract);
  driftedContract.surfacePin.schemaBundleSha256 = '0'.repeat(64);
  expectCode(
    () =>
      createCodexAppServerContractGate({
        contract: driftedContract,
        manifest,
        cliVersion: '0.144.3',
      }),
    'schema-bundle-drift',
  );
});

test('positive fixtures map only typed provider events without retaining raw payloads', () => {
  const gate = createCodexAppServerContractGate({ cliVersion: '0.144.3' });
  for (const entry of fixture('positive-cases.json')) {
    const plan = gate.classify(entry);
    assert.equal(plan.normalizedSemantic, entry.expectedSemantic, entry.id);
    assert.equal(plan.provider, 'codex', entry.id);
    assert.equal(plan.rawPointerRequired, true, entry.id);
    assert.ok(!Object.hasOwn(plan, 'message'), entry.id);
    assert.ok(!Object.hasOwn(plan, 'params'), entry.id);
  }
});

test('negative fixtures fail closed on method, direction, envelope and identity drift', () => {
  const gate = createCodexAppServerContractGate({ cliVersion: '0.144.3' });
  for (const entry of fixture('negative-cases.json')) {
    expectCode(() => gate.classify(entry), entry.expectedCode);
  }
});

test('contract preserves provider-specific authority and recovery limits', () => {
  const contract = loadCodexAppServerContract();
  assert.equal(
    contract.authority.sharedInteractionPort,
    'kungfu.agent-session.contract/v1',
  );
  assert.equal(contract.authority.hotSwitch, false);
  assert.equal(contract.authority.textInference, false);
  assert.equal(contract.recoveryBoundary.eventReplay, false);
  assert.equal(contract.recoveryBoundary.blindInputRetry, false);
  assert.equal(contract.recoveryBoundary.clientUserMessageIdIdempotency, false);
  assert.deepEqual(contract.capabilitySnapshot.knownMissing, [
    'reconnect-cursor-or-event-replay',
    'provider-at-most-once-input-admission',
    'stdio-slow-consumer-backpressure-contract',
  ]);
});
