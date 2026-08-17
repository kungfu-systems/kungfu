// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CodexAppServerContractError,
  createCodexAppServerContractGate,
  loadCodexAppServerContract,
  loadCodexAppServerSchemaManifest,
  resolveCodexAppServerContractRoot,
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

test('bundled TUI worker resolves the source Agent Session contract root', () => {
  const bundledWorker = path.resolve(
    here,
    '..',
    '..',
    'tui',
    'dist',
    'agent-session-worker.mjs',
  );
  assert.equal(
    resolveCodexAppServerContractRoot({
      moduleUrl: pathToFileURL(bundledWorker).href,
      env: {},
    }),
    path.resolve(here, '..'),
  );
});

test('pinned stable schema manifest has a self-recomputing deterministic bundle digest', () => {
  const manifest = loadCodexAppServerSchemaManifest();
  assert.deepEqual(verifyCodexAppServerSchemaManifest(manifest), {
    fileCount: 275,
    sha256: 'c1ab53bbe1955ea63bc4fbb976f01a1fb4dc5af8e2f3067fb9d228c035692538',
  });
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(manifest.protocolInventory).map(([key, value]) => [
        key,
        value.count,
      ]),
    ),
    {
      clientRequests: 90,
      clientNotifications: 1,
      serverRequests: 10,
      serverNotifications: 70,
    },
  );

  const tampered = structuredClone(manifest);
  tampered.bundle.files[0].canonicalBytes += 1;
  expectCode(
    () => verifyCodexAppServerSchemaManifest(tampered),
    'schema-manifest-digest',
  );
});

test('contract gate pins schema provenance while runtime version stays diagnostic', () => {
  const contract = loadCodexAppServerContract();
  const manifest = loadCodexAppServerSchemaManifest(contract);
  const gate = createCodexAppServerContractGate({
    contract,
    manifest,
    cliVersion: '0.146.0',
    initializeCapabilities: {},
  });
  assert.equal(gate.provider, 'codex');
  assert.equal(gate.experimentalApi, false);
  assert.equal(gate.cliVersion, '0.146.0');

  for (const cliVersion of [
    '0.145.0',
    '0.147.0',
    '999.42.7-edge',
    'opaque-nightly',
    'unknown',
  ]) {
    assert.equal(
      createCodexAppServerContractGate({ contract, manifest, cliVersion })
        .cliVersion,
      cliVersion,
    );
  }
  expectCode(
    () =>
      createCodexAppServerContractGate({
        contract,
        manifest,
        cliVersion: '0.146.0',
        initializeCapabilities: { experimentalApi: true },
      }),
    'experimental-api',
  );
  expectCode(
    () =>
      createCodexAppServerContractGate({
        contract,
        manifest,
        cliVersion: '0.146.0',
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
        cliVersion: '0.146.0',
      }),
    'schema-bundle-drift',
  );

  const driftedManifest = structuredClone(manifest);
  driftedManifest.cliVersion = 'different-qualification-source';
  expectCode(
    () =>
      createCodexAppServerContractGate({
        contract,
        manifest: driftedManifest,
        cliVersion: 'opaque-nightly',
      }),
    'qualification-source-version-drift',
  );
});

test('positive fixtures map only typed provider events without retaining raw payloads', () => {
  const gate = createCodexAppServerContractGate({ cliVersion: '0.146.0' });
  for (const entry of fixture('positive-cases.json')) {
    const plan = gate.classify(entry);
    assert.equal(plan.normalizedSemantic, entry.expectedSemantic, entry.id);
    assert.equal(plan.provider, 'codex', entry.id);
    assert.equal(plan.rawPointerRequired, true, entry.id);
    assert.ok(!Object.hasOwn(plan, 'message'), entry.id);
    assert.ok(!Object.hasOwn(plan, 'params'), entry.id);
  }
});

test('unknown provider notifications stay diagnostic across arbitrary runtime versions', () => {
  for (const [cliVersion, method] of [
    ['0.146.0', 'skills/changed'],
    ['opaque-future-build', 'future/provider-diagnostic'],
  ]) {
    const gate = createCodexAppServerContractGate({ cliVersion });
    const plan = gate.classify({
      direction: 'server-notification',
      message: { method, params: { futurePayload: 'not-public' } },
    });
    assert.deepEqual(plan, {
      schema: 'kungfu.codex-app-server.normalization-plan/v1',
      provider: 'codex',
      providerMethod: method,
      providerSchemaFile: null,
      direction: 'server-notification',
      normalizedSemantic: 'provider-notification-unclassified',
      interactionOperation: null,
      rawRetention: 'metadata-only',
      authority: 'provider-diagnostic-not-work-fact',
      rawPointerRequired: true,
    });
    assert.ok(!Object.hasOwn(plan, 'message'));
    assert.ok(!Object.hasOwn(plan, 'params'));
  }
});

test('negative fixtures fail closed on method, direction, envelope and identity drift', () => {
  const gate = createCodexAppServerContractGate({ cliVersion: '0.146.0' });
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
