// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SyntheticGitHubCredentialBroker } from '../fixtures/github-credential-broker.mjs';
import { startLocalReceiver } from '../fixtures/local-receiver.mjs';
import {
  MemoryDeliveryStore,
  createGitHubWebhookService,
  isContentRoot,
  packageIdentity,
} from '../src/service.mjs';

const rooted = (character) => `sha256:${character.repeat(64)}`;
const evidence = (version = packageIdentity.version) => ({
  packageKey: packageIdentity.key,
  packageVersion: version,
  kfdRoot: rooted('1'),
  warrantRoot: rooted('2'),
  passportRoot: rooted('3'),
  authorizationRoot: rooted('4'),
  capabilityGrantRoot: rooted('5'),
  dependencyRoot: rooted('6'),
  qualified: true,
  authorized: true,
  grantedCapabilities: ['credential.verify', 'network.listen'],
  dependencies: [
    {
      providerId: 'fixture-runtime-support',
      version: packageIdentity.productVersion,
      installed: true,
      qualified: true,
      authorized: true,
      compatible: true,
    },
  ],
});

let now = Date.parse('2026-08-10T01:00:00.000Z');
const clock = { now: () => now++ };
const broker = new SyntheticGitHubCredentialBroker();
const processed = [];
const processingEvidence = [];
const deliveryStore = new MemoryDeliveryStore();
const service = createGitHubWebhookService({
  evidence: evidence(),
  credentialBroker: broker,
  repositories: ['kungfu-systems/kungfu'],
  processEvent: async (event) => processed.push(event),
  onEvidence: (row) => processingEvidence.push(row),
  clock,
  deliveryStore,
});
const lifecycle = [service.host.start(), service.host.ready()];
const receiver = await startLocalReceiver(service.host);

function fixturePayload(overrides = {}) {
  return {
    action: 'opened',
    repository: { full_name: 'kungfu-systems/kungfu' },
    sender: { login: 'octocat' },
    issue: {
      id: 101,
      number: 42,
      title: 'Synthetic qualification issue',
      body: 'Synthetic public payload body.',
      html_url: 'https://example.invalid/issues/42',
      created_at: '2026-08-10T00:59:00.000Z',
      updated_at: '2026-08-10T00:59:30.000Z',
    },
    ...overrides,
  };
}

async function send(delivery, payload, options = {}) {
  const body = Buffer.from(options.rawBody ?? JSON.stringify(payload), 'utf8');
  const signature = options.signature ?? broker.sign(body);
  const headers = {
    'content-type': options.contentType ?? 'application/json',
    'x-github-event': options.event ?? 'issues',
    ...(delivery ? { 'x-github-delivery': delivery } : {}),
    ...(signature ? { 'x-hub-signature-256': signature } : {}),
  };
  const started = performance.now();
  const response = await fetch(receiver.url, {
    method: 'POST',
    headers,
    body,
  });
  return {
    elapsedMs: performance.now() - started,
    status: response.status,
    body: await response.json(),
  };
}

try {
  const accepted = await send('delivery-accepted-1', fixturePayload());
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.accepted, true);
  assert.equal(accepted.body.event.outcome, 'observed');
  assert.equal(accepted.body.event.repository, 'kungfu-systems/kungfu');
  assert.ok(isContentRoot(accepted.body.event.payloadRoot));
  assert.ok(isContentRoot(accepted.body.event.object.contentRoot));
  assert.ok(accepted.elapsedMs < 10_000);

  const replay = await send('delivery-accepted-1', fixturePayload());
  assert.equal(replay.status, 403);
  assert.equal(replay.body.receipt.code, 'KF_KFX_WEBHOOK_REPLAYED');

  const unsigned = await send('delivery-unsigned-1', fixturePayload(), {
    signature: '',
  });
  assert.equal(unsigned.body.receipt.code, 'KF_KFX_WEBHOOK_UNSIGNED');
  const invalid = await send('delivery-invalid-signature-1', fixturePayload(), {
    signature: 'sha256=00',
  });
  assert.equal(
    invalid.body.receipt.code,
    'KF_KFX_WEBHOOK_AUTHENTICATION_FAILED',
  );
  const unknownDelivery = await send('', fixturePayload());
  assert.equal(unknownDelivery.body.receipt.code, 'KF_KFX_WEBHOOK_REPLAYED');

  const noOps = [
    await send(
      'delivery-repository-1',
      fixturePayload({
        repository: { full_name: 'untrusted/example' },
      }),
    ),
    await send('delivery-event-1', fixturePayload(), { event: 'push' }),
    await send('delivery-action-1', fixturePayload({ action: 'transferred' })),
    await send(
      'delivery-stale-1',
      fixturePayload({
        issue: {
          ...fixturePayload().issue,
          updated_at: '2026-07-01T00:00:00.000Z',
        },
      }),
    ),
    await send('delivery-content-1', fixturePayload(), {
      contentType: 'text/plain',
    }),
  ];
  assert.deepEqual(
    noOps.map((row) => row.body.event.code),
    [
      'KF_GITHUB_REPOSITORY_DISALLOWED',
      'KF_GITHUB_EVENT_DISALLOWED',
      'KF_GITHUB_ACTION_DISALLOWED',
      'KF_GITHUB_TIMESTAMP_STALE',
      'KF_GITHUB_CONTENT_UNSUPPORTED',
    ],
  );

  const oversizedBody = Buffer.alloc(262_145, 0x20);
  const oversized = await service.host.intake({
    method: 'POST',
    path: '/github/events',
    headers: {},
    body: oversizedBody,
    signature: broker.sign(oversizedBody),
    replayKey: 'delivery-oversized-1',
  });
  assert.equal(oversized.receipt.code, 'KF_KFX_WEBHOOK_OVERSIZED');

  const preRotationBody = Buffer.from(JSON.stringify(fixturePayload()));
  const preRotationSignature = broker.sign(preRotationBody);
  broker.rotate();
  const rotated = await service.host.intake({
    method: 'POST',
    path: '/github/events',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-github-delivery': 'delivery-rotated-1',
    },
    body: preRotationBody,
    signature: preRotationSignature,
    replayKey: 'delivery-rotated-1',
  });
  assert.equal(rotated.receipt.code, 'KF_KFX_WEBHOOK_AUTHENTICATION_FAILED');
  broker.invalidate();
  const invalidated = await send('delivery-invalidated-1', fixturePayload());
  assert.equal(
    invalidated.body.receipt.code,
    'KF_KFX_WEBHOOK_AUTHENTICATION_FAILED',
  );
  broker.restore();

  const timeoutService = createGitHubWebhookService({
    evidence: evidence(),
    credentialBroker: {
      verify: () => new Promise(() => {}),
    },
    repositories: ['kungfu-systems/kungfu'],
    processEvent: async () => {},
    clock,
  });
  timeoutService.host.start();
  timeoutService.host.ready();
  const timeoutBody = Buffer.from(JSON.stringify(fixturePayload()));
  const timedOut = await timeoutService.host.intake({
    method: 'POST',
    path: '/github/events',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-github-delivery': 'delivery-timeout-1',
    },
    body: timeoutBody,
    signature: broker.sign(timeoutBody),
    replayKey: 'delivery-timeout-1',
  });
  assert.equal(timedOut.receipt.code, 'KF_KFX_WEBHOOK_TIMEOUT');

  let releaseVerification;
  const revokedProcessed = [];
  const revocationService = createGitHubWebhookService({
    evidence: evidence(),
    credentialBroker: {
      verify: () =>
        new Promise((resolve) => {
          releaseVerification = resolve;
        }),
    },
    repositories: ['kungfu-systems/kungfu'],
    processEvent: async (event) => revokedProcessed.push(event),
    clock,
  });
  revocationService.host.start();
  revocationService.host.ready();
  const revocationBody = Buffer.from(JSON.stringify(fixturePayload()));
  const revocationPending = revocationService.host.intake({
    method: 'POST',
    path: '/github/events',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-github-delivery': 'delivery-revoked-1',
    },
    body: revocationBody,
    signature: broker.sign(revocationBody),
    replayKey: 'delivery-revoked-1',
  });
  await Promise.resolve();
  revocationService.host.updateDependencies(
    [{ ...evidence().dependencies[0], authorized: false }],
    rooted('e'),
  );
  releaseVerification(true);
  const revoked = await revocationPending;
  assert.equal(revoked.accepted, false);
  assert.equal(revoked.receipt.code, 'KF_KFX_SERVICE_DEPENDENCY_DORMANT');
  await revocationService.queue.flush();
  assert.equal(revokedProcessed.length, 0);

  lifecycle.push(
    service.host.crash(),
    service.host.restart(),
    service.host.ready(),
  );
  const afterRestart = await send('delivery-accepted-1', fixturePayload());
  assert.equal(afterRestart.body.receipt.code, 'KF_KFX_WEBHOOK_REPLAYED');

  const recoveredProcessed = [];
  const recovered = createGitHubWebhookService({
    evidence: evidence(),
    credentialBroker: broker,
    repositories: ['kungfu-systems/kungfu'],
    processEvent: async (event) => recoveredProcessed.push(event),
    clock,
    deliveryStore,
  });
  recovered.host.start();
  recovered.host.ready();
  const recoveredBody = Buffer.from(JSON.stringify(fixturePayload()));
  const recoveredDuplicate = await recovered.host.intake({
    method: 'POST',
    path: '/github/events',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-github-delivery': 'delivery-accepted-1',
    },
    body: recoveredBody,
    signature: broker.sign(recoveredBody),
    replayKey: 'delivery-accepted-1',
  });
  assert.equal(recoveredDuplicate.accepted, true);
  assert.equal(recoveredDuplicate.event.code, 'KF_GITHUB_DELIVERY_DUPLICATE');
  await recovered.queue.flush();
  assert.equal(recoveredProcessed.length, 0);

  let releaseProcessing;
  const queueEvidence = [];
  const saturated = createGitHubWebhookService({
    evidence: evidence(),
    credentialBroker: broker,
    repositories: ['kungfu-systems/kungfu'],
    processEvent: () =>
      new Promise((resolve) => {
        releaseProcessing = resolve;
      }),
    onEvidence: (row) => queueEvidence.push(row),
    clock,
    queueDepth: 2,
  });
  saturated.host.start();
  saturated.host.ready();
  async function direct(delivery) {
    const body = Buffer.from(JSON.stringify(fixturePayload()));
    return saturated.host.intake({
      method: 'POST',
      path: '/github/events',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': delivery,
      },
      body,
      signature: broker.sign(body),
      replayKey: delivery,
    });
  }
  await direct('delivery-queue-1');
  await direct('delivery-queue-2');
  await direct('delivery-queue-3');
  assert.ok(queueEvidence.some((row) => row.code === 'KF_GITHUB_QUEUE_FULL'));
  releaseProcessing();

  await service.queue.flush();
  assert.equal(processed.length, 1);
  assert.ok(processingEvidence.some((row) => row.outcome === 'applied'));
  assert.ok(
    processingEvidence.filter((row) => row.outcome === 'no-op').length >= 5,
  );

  lifecycle.push(service.host.drain(), service.host.stop());
  lifecycle.push(service.host.upgrade('0.2.0', evidence('0.2.0')));
  lifecycle.push(service.host.rollback(packageIdentity.version, evidence()));
  lifecycle.push(service.host.deactivate(), service.host.uninstall());

  const sdkPath = fileURLToPath(
    new URL('../sdk/service-webhook-host.mjs', import.meta.url),
  );
  const sdkBytes = await readFile(sdkPath);
  const sdkProjectionRoot = `sha256:${createHash('sha256')
    .update(sdkBytes)
    .digest('hex')}`;
  const receipt = {
    schema: 'kungfu.kfx-authoring-qualification/v1',
    status: 'passed',
    packageKey: packageIdentity.key,
    packageVersion: packageIdentity.version,
    sdkRoot: packageIdentity.sdkRoot,
    sdkProjectionRoot,
    receiver: {
      bindAddress: receiver.bindAddress,
      externalNetwork: false,
      credentialMaterial: false,
      acknowledgementMs: accepted.elapsedMs,
    },
    intake: {
      acceptedRoot: accepted.body.receipt.receiptRoot,
      replayCode: replay.body.receipt.code,
      signatureCode: invalid.body.receipt.code,
      oversizedCode: oversized.receipt.code,
      normalizedPayloadRoot: accepted.body.event.payloadRoot,
      processed: processed.length,
      noOps: noOps.map((row) => row.body.event.code),
      queueSaturation: 'KF_GITHUB_QUEUE_FULL',
      restartReplay: afterRestart.body.receipt.code,
      processRecoveryDuplicate: recoveredDuplicate.event.code,
      timeout: timedOut.receipt.code,
      dependencyRevocation: revoked.receipt.code,
    },
    lifecycle: lifecycle.map((row) => ({
      operation: row.operation,
      outcome: row.outcome,
      state: row.state,
      code: row.code,
      receiptRoot: row.receiptRoot,
    })),
    nonClaims: [
      'fixture-does-not-open-a-public-listener',
      'fixture-does-not-grant-production-authority',
      'github-observations-do-not-authorize-domain-effects',
    ],
  };
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  await receiver.close();
}
