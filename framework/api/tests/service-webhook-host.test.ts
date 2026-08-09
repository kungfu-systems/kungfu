import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type KfxCredentialBroker,
  type KfxServiceAuthorityEvidence,
  type KfxServiceHostDeclaration,
  KfxServiceWebhookHost,
  type KfxWebhookHandler,
  type KfxWebhookRequest,
  validateKfxServiceHostDeclaration,
} from '../src/capability/service-authz.ts';

const ROOT = (value: string) => `sha256:${value.repeat(64)}`;

function evidence(
  overrides: Partial<KfxServiceAuthorityEvidence> = {},
): KfxServiceAuthorityEvidence {
  return {
    packageKey: 'ordinary-provider',
    packageVersion: '1.0.0',
    kfdRoot: ROOT('1'),
    warrantRoot: ROOT('2'),
    passportRoot: ROOT('3'),
    authorizationRoot: ROOT('4'),
    capabilityGrantRoot: ROOT('5'),
    dependencyRoot: ROOT('6'),
    qualified: true,
    authorized: true,
    grantedCapabilities: ['network.listen', 'credential.verify'],
    dependencies: [
      {
        providerId: 'runtime-support',
        version: '1.0.0',
        installed: true,
        qualified: true,
        authorized: true,
        compatible: true,
      },
    ],
    ...overrides,
  };
}

function declaration(
  overrides: {
    listenerMode?: 'disabled' | 'loopback' | 'explicit';
    maxPayloadBytes?: number;
    maxInflight?: number;
    maxRequestsPerWindow?: number;
    handlerTimeoutMs?: number;
  } = {},
): KfxServiceHostDeclaration {
  const mode = overrides.listenerMode ?? 'loopback';
  return {
    schema: 'kungfu.kfx.service-host/v1',
    contractVersion: 1,
    lifecycle: {
      restartPolicy: 'on-failure',
      readinessTimeoutMs: 5_000,
      drainTimeoutMs: 5_000,
      shutdownTimeoutMs: 5_000,
    },
    webhook: {
      listener: {
        mode,
        ...(mode === 'disabled'
          ? {}
          : {
              bindAddress: mode === 'loopback' ? '127.0.0.1' : '0.0.0.0',
              port: 9_911,
            }),
        path: '/events',
        methods: ['POST'],
      },
      credentials: [
        {
          handle: 'credential:webhook/signing',
          purpose: 'webhook-signature-verification',
          algorithms: ['hmac-sha256'],
        },
      ],
      intake: {
        maxPayloadBytes: overrides.maxPayloadBytes ?? 16,
        maxQueueDepth: 2,
        maxInflight: overrides.maxInflight ?? 1,
        maxRequestsPerWindow: overrides.maxRequestsPerWindow ?? 10,
        rateWindowMs: 60_000,
        handlerTimeoutMs: overrides.handlerTimeoutMs ?? 50,
        replayWindowMs: 300_000,
      },
    },
  };
}

function request(
  overrides: Partial<KfxWebhookRequest> = {},
): KfxWebhookRequest {
  return {
    method: 'POST',
    path: '/events',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode('{}'),
    signature: 'valid',
    replayKey: 'delivery-1',
    ...overrides,
  };
}

function harness(
  options: {
    declaration?: KfxServiceHostDeclaration;
    evidence?: KfxServiceAuthorityEvidence;
    broker?: KfxCredentialBroker;
    handler?: KfxWebhookHandler<{ size: number }>;
    now?: () => number;
  } = {},
) {
  const effects: Array<{ size: number }> = [];
  const broker = options.broker ?? {
    async verify(input) {
      return input.signature === 'valid';
    },
  };
  const handler = options.handler ?? {
    credentialHandle: 'credential:webhook/signing',
    algorithm: 'hmac-sha256',
    async normalize(input) {
      return { size: input.body.byteLength };
    },
    async onEvent(event) {
      effects.push(event);
    },
  };
  const host = new KfxServiceWebhookHost(
    options.declaration ?? declaration(),
    options.evidence ?? evidence(),
    broker,
    handler,
    { now: options.now ?? (() => 1_000) },
  );
  return { host, effects };
}

function readyHost(options: Parameters<typeof harness>[0] = {}) {
  const result = harness(options);
  assert.equal(result.host.start().outcome, 'applied');
  assert.equal(result.host.ready().outcome, 'applied');
  return result;
}

test('the retained v1 fixture validates and fails closed with stable diagnostics', async () => {
  const path = fileURLToPath(
    new URL(
      './fixtures/kfx-service-webhook/v1/conformance.json',
      import.meta.url,
    ),
  );
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as {
    declaration: KfxServiceHostDeclaration;
    refusals: Array<{
      request: {
        method: string;
        path: string;
        body: string;
        signature: string | null;
        replayKey: string;
      };
      expectedCode: string;
    }>;
  };
  validateKfxServiceHostDeclaration(fixture.declaration);
  for (const row of fixture.refusals) {
    const { host, effects } = readyHost({ declaration: fixture.declaration });
    const result = await host.intake(
      request({
        ...row.request,
        body: new TextEncoder().encode(row.request.body),
      }),
    );
    assert.equal(result.accepted, false);
    assert.equal(result.receipt.code, row.expectedCode);
    assert.deepEqual(effects, []);
  }
});

test('lifecycle receipts cover restart, crash recovery, upgrade, rollback, deactivate, and uninstall', () => {
  const { host } = harness();
  assert.equal(host.start().state, 'starting');
  assert.equal(host.ready().state, 'ready');
  assert.equal(host.drain().state, 'draining');
  assert.equal(host.stop().state, 'stopped');
  assert.equal(host.restart().state, 'starting');
  assert.equal(host.ready().state, 'ready');
  assert.equal(host.crash().state, 'crashed');
  assert.equal(host.restart().state, 'starting');
  assert.equal(host.stop().state, 'stopped');
  const upgraded = evidence({ packageVersion: '2.0.0' });
  assert.equal(host.upgrade('2.0.0', upgraded).packageVersion, '2.0.0');
  const rolledBack = evidence({ packageVersion: '1.0.0' });
  assert.equal(host.rollback('1.0.0', rolledBack).packageVersion, '1.0.0');
  assert.equal(host.deactivate().state, 'deactivated');
  const removed = host.uninstall();
  assert.equal(removed.state, 'uninstalled');
  assert.match(removed.receiptRoot, /^sha256:[0-9a-f]{64}$/);
  assert.equal(host.start().code, 'KF_KFX_SERVICE_LIFECYCLE_INVALID');
});

test('no listener is the valid default and non-loopback binding needs its exact grant', async () => {
  const disabled = readyHost({
    declaration: declaration({ listenerMode: 'disabled' }),
  });
  assert.equal(disabled.host.start().code, 'KF_KFX_SERVICE_LIFECYCLE_INVALID');
  const refused = await disabled.host.intake(request());
  assert.equal(refused.receipt.code, 'KF_KFX_LISTENER_DISABLED');

  const explicit = harness({
    declaration: declaration({ listenerMode: 'explicit' }),
  });
  assert.equal(explicit.host.start().code, 'KF_KFX_LISTENER_POLICY_REJECTED');
  const admitted = harness({
    declaration: declaration({ listenerMode: 'explicit' }),
    evidence: evidence({
      grantedCapabilities: [
        'network.listen',
        'network.listen.non-loopback',
        'credential.verify',
      ],
    }),
  });
  assert.equal(admitted.host.start().outcome, 'applied');
});

test('qualification, authorization, and dependency evidence are identity-neutral', async () => {
  assert.equal(
    harness({ evidence: evidence({ qualified: false }) }).host.start().code,
    'KF_KFX_SERVICE_UNQUALIFIED',
  );
  assert.equal(
    harness({ evidence: evidence({ warrantRoot: null }) }).host.start().code,
    'KF_KFX_SERVICE_UNAUTHORIZED',
  );

  const dependency = evidence().dependencies[0];
  assert.ok(dependency);
  const dormant = harness({
    evidence: evidence({
      dependencies: [{ ...dependency, authorized: false }],
    }),
  });
  assert.equal(dormant.host.state, 'dormant');
  assert.equal(dormant.host.start().code, 'KF_KFX_SERVICE_DEPENDENCY_DORMANT');
  assert.equal(
    dormant.host.updateDependencies([{ ...dependency }], ROOT('7')).state,
    'installed',
  );

  const firstParty = readyHost({
    evidence: evidence({ packageKey: 'kungfu-origin-package' }),
  });
  const thirdParty = readyHost({
    evidence: evidence({ packageKey: 'ordinary-third-party-package' }),
  });
  const [first, third] = await Promise.all([
    firstParty.host.intake(request()),
    thirdParty.host.intake(request()),
  ]);
  assert.equal(first.accepted, true);
  assert.equal(third.accepted, true);
  assert.equal(first.receipt.receiptRoot, third.receipt.receiptRoot);

  const revoked = firstParty.host.updateDependencies(
    [{ ...dependency, qualified: false }],
    ROOT('8'),
  );
  assert.equal(revoked.state, 'dormant');
  assert.equal(revoked.code, 'KF_KFX_SERVICE_DEPENDENCY_DORMANT');
});

test('authentication, replay, payload, and rate fences precede domain effects', async () => {
  const rawSecret = 'raw-secret-must-not-escape';
  const brokerFailure = readyHost({
    broker: {
      async verify() {
        throw new Error(rawSecret);
      },
    },
  });
  const failed = await brokerFailure.host.intake(request());
  assert.equal(failed.receipt.code, 'KF_KFX_WEBHOOK_AUTHENTICATION_FAILED');
  assert.doesNotMatch(JSON.stringify(failed.receipt), new RegExp(rawSecret));
  assert.deepEqual(brokerFailure.effects, []);

  const replayed = readyHost();
  assert.equal((await replayed.host.intake(request())).accepted, true);
  const replay = await replayed.host.intake(request());
  assert.equal(replay.receipt.code, 'KF_KFX_WEBHOOK_REPLAYED');
  assert.equal(replayed.effects.length, 1);

  const rate = readyHost({
    declaration: declaration({ maxRequestsPerWindow: 1 }),
  });
  assert.equal((await rate.host.intake(request())).accepted, true);
  const limited = await rate.host.intake(request({ replayKey: 'delivery-2' }));
  assert.equal(limited.receipt.code, 'KF_KFX_WEBHOOK_RATE_EXCEEDED');
  assert.equal(rate.effects.length, 1);
});

test('bounded inflight work and handler timeouts fail closed', async () => {
  let release: ((event: { size: number }) => void) | undefined;
  const pending = new Promise<{ size: number }>((resolve) => {
    release = resolve;
  });
  const handler: KfxWebhookHandler<{ size: number }> = {
    credentialHandle: 'credential:webhook/signing',
    algorithm: 'hmac-sha256',
    async normalize() {
      return pending;
    },
    async onEvent() {},
  };
  const bounded = readyHost({ handler });
  const first = bounded.host.intake(request());
  await Promise.resolve();
  const full = await bounded.host.intake(request({ replayKey: 'delivery-2' }));
  assert.equal(full.receipt.code, 'KF_KFX_WEBHOOK_QUEUE_FULL');
  assert.equal(bounded.host.drain().state, 'draining');
  assert.equal(bounded.host.stop().code, 'KF_KFX_SERVICE_LIFECYCLE_INVALID');
  release?.({ size: 2 });
  assert.equal((await first).accepted, true);
  assert.equal(bounded.host.stop().state, 'stopped');

  let releaseRevoked: ((event: { size: number }) => void) | undefined;
  const pendingRevoked = new Promise<{ size: number }>((resolve) => {
    releaseRevoked = resolve;
  });
  const revoked = readyHost({
    handler: {
      ...handler,
      async normalize() {
        return pendingRevoked;
      },
    },
  });
  const revokedIntake = revoked.host.intake(request());
  await Promise.resolve();
  const dependency = evidence().dependencies[0];
  assert.ok(dependency);
  revoked.host.updateDependencies(
    [{ ...dependency, authorized: false }],
    ROOT('9'),
  );
  releaseRevoked?.({ size: 2 });
  assert.equal(
    (await revokedIntake).receipt.code,
    'KF_KFX_SERVICE_DEPENDENCY_DORMANT',
  );
  assert.deepEqual(revoked.effects, []);

  const timed = readyHost({
    declaration: declaration({ handlerTimeoutMs: 5 }),
    handler: {
      ...handler,
      async normalize() {
        return new Promise<{ size: number }>(() => {});
      },
    },
  });
  const timeout = await timed.host.intake(request());
  assert.equal(timeout.receipt.code, 'KF_KFX_WEBHOOK_TIMEOUT');
  assert.deepEqual(timed.effects, []);

  const stalledBroker = readyHost({
    declaration: declaration({ handlerTimeoutMs: 5 }),
    broker: {
      async verify() {
        return new Promise<boolean>(() => {});
      },
    },
  });
  const brokerTimeout = await stalledBroker.host.intake(request());
  assert.equal(brokerTimeout.receipt.code, 'KF_KFX_WEBHOOK_TIMEOUT');
  assert.deepEqual(stalledBroker.effects, []);
});
