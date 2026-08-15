// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  DOGFOOD_PROVIDER,
  DOGFOOD_VERSION,
  FINDING_CAPABILITY,
  GitHubDogfoodBridge,
  createGitHubDogfoodBridgeService,
  packageIdentity,
} from '../src/service.mjs';

const rooted = (character) => `sha256:${character.repeat(64)}`;
const dependency = (overrides = {}) => ({
  providerId: DOGFOOD_PROVIDER,
  version: DOGFOOD_VERSION,
  installed: true,
  qualified: true,
  authorized: true,
  compatible: true,
  kfdRoot: rooted('7'),
  ...overrides,
});
const authority = (overrides = {}) => ({
  dependency: dependency(),
  grantedCapabilities: [FINDING_CAPABILITY],
  warrantRoot: rooted('2'),
  passportRoot: rooted('3'),
  capabilityGrantRoot: rooted('5'),
  revoked: false,
  ...overrides,
});
const evidence = (
  version = packageIdentity.version,
  dependencies = [dependency()],
) => ({
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
  grantedCapabilities: [
    'credential.verify',
    'network.listen',
    FINDING_CAPABILITY,
  ],
  dependencies,
});
const observation = Object.freeze({
  schema: 'kungfu.github-webhook-observation/v1',
  outcome: 'observed',
  code: null,
  provider: 'github',
  delivery: 'synthetic-delivery-1',
  event: 'issues',
  action: 'opened',
  repository: 'kungfu-systems/kungfu',
  sender: 'octocat',
  object: {
    kind: 'issue',
    id: '101',
    issueNumber: 42,
    url: 'https://example.invalid/issues/42',
    title: 'Synthetic qualification issue',
    excerpt: 'Synthetic public payload body.',
    contentRoot: rooted('8'),
  },
  payloadRoot: rooted('9'),
  observedAt: '2026-08-10T00:59:30.000Z',
});

const calls = [];
const capabilityExecutor = {
  async invoke(capability, proposal) {
    calls.push({ capability, proposal });
    return {
      kind: 'finding',
      immutable: true,
      findingRoot: rooted('a'),
      issueAdmitted: false,
      workMutated: false,
      githubMutated: false,
      semanticCompletion: false,
    };
  },
};

const forbiddenEffects = [
  ['issue-admission', { issueAdmitted: true }],
  ['work-mutation', { workMutated: true }],
  ['github-mutation', { githubMutated: true }],
  ['semantic-completion', { semanticCompletion: true }],
];
for (const [label, forbidden] of forbiddenEffects) {
  const refusingBridge = new GitHubDogfoodBridge({
    authority: authority(),
    capabilityExecutor: {
      async invoke() {
        return {
          kind: 'finding',
          immutable: true,
          findingRoot: rooted('d'),
          issueAdmitted: false,
          workMutated: false,
          githubMutated: false,
          semanticCompletion: false,
          ...forbidden,
        };
      },
    },
  });
  await assert.rejects(
    refusingBridge.captureObservation({
      ...observation,
      delivery: `forbidden-${label}`,
    }),
    /invalid Finding effect/,
  );
}

const captureLedger = new Map();
const bridge = new GitHubDogfoodBridge({
  authority: authority(),
  capabilityExecutor,
  captureLedger,
});
assert.equal(bridge.status().state, 'available');

const dormantCases = [
  [authority({ dependency: null }), 'KF_GITHUB_DOGFOOD_DEPENDENCY_MISSING'],
  [
    authority({ dependency: dependency({ version: '3.0.0' }) }),
    'KF_GITHUB_DOGFOOD_DEPENDENCY_INCOMPATIBLE',
  ],
  [
    authority({ dependency: dependency({ qualified: false }) }),
    'KF_GITHUB_DOGFOOD_DEPENDENCY_UNQUALIFIED',
  ],
  [authority({ revoked: true }), 'KF_GITHUB_DOGFOOD_CAPABILITY_REVOKED'],
  [authority({ grantedCapabilities: [] }), 'KF_GITHUB_DOGFOOD_UNAUTHORIZED'],
];
for (const [nextAuthority, code] of dormantCases) {
  assert.equal(bridge.updateAuthority(nextAuthority).code, code);
  const receipt = await bridge.captureObservation(observation);
  assert.equal(receipt.outcome, 'dormant');
  assert.equal(receipt.code, code);
}
assert.equal(calls.length, 0);

bridge.updateAuthority(authority());
const captured = await bridge.captureObservation(observation);
assert.equal(captured.outcome, 'captured');
assert.equal(captured.effect.kind, 'finding');
assert.equal(captured.effect.immutable, true);
assert.equal(calls.length, 1);
assert.equal(calls[0].capability, FINDING_CAPABILITY);
assert.equal(calls[0].proposal.operation, 'capture-finding');
assert.deepEqual(calls[0].proposal.limits, {
  immutableFindingOnly: true,
  issueAdmission: false,
  workMutation: false,
  githubMutation: false,
  semanticCompletion: false,
});
assert.equal('issue' in calls[0].proposal, false);
assert.equal('work' in calls[0].proposal, false);

const deduplicated = await bridge.captureObservation(observation);
assert.equal(deduplicated.outcome, 'deduplicated');
assert.equal(deduplicated.code, 'KF_GITHUB_DOGFOOD_ALREADY_CAPTURED');
assert.equal(calls.length, 1);
bridge.updateAuthority(authority({ revoked: true }));
bridge.updateAuthority(authority());
await bridge.captureObservation(observation);
assert.equal(calls.length, 1);
const recoveredBridge = new GitHubDogfoodBridge({
  authority: authority(),
  capabilityExecutor,
  captureLedger,
});
const recoveredDuplicate =
  await recoveredBridge.captureObservation(observation);
assert.equal(recoveredDuplicate.outcome, 'deduplicated');
assert.equal(calls.length, 1);

const hostBridge = new GitHubDogfoodBridge({
  authority: authority(),
  capabilityExecutor,
});
const host = createGitHubDogfoodBridgeService({
  evidence: evidence(),
  credentialBroker: {
    async verify(request) {
      return (
        request.handle === 'credential:github/observation-bridge' &&
        request.algorithm === 'hmac-sha256' &&
        request.signature === 'fixture-valid'
      );
    },
  },
  bridge: hostBridge,
  clock: { now: () => 1_000 },
});
const lifecycle = [host.start(), host.ready()];
const body = Buffer.from(
  JSON.stringify({ ...observation, delivery: 'host-delivery-1' }),
);
const accepted = await host.intake({
  method: 'POST',
  path: '/github/observations',
  headers: { 'content-type': 'application/json' },
  body,
  signature: 'fixture-valid',
  replayKey: 'host-delivery-1',
});
assert.equal(accepted.accepted, true);
const replay = await host.intake({
  method: 'POST',
  path: '/github/observations',
  headers: { 'content-type': 'application/json' },
  body,
  signature: 'fixture-valid',
  replayKey: 'host-delivery-1',
});
assert.equal(replay.receipt.code, 'KF_KFX_WEBHOOK_REPLAYED');
lifecycle.push(host.drain(), host.stop());
const dormantHost = host.updateDependencies(
  [dependency({ qualified: false })],
  rooted('b'),
);
assert.equal(dormantHost.code, 'KF_KFX_SERVICE_DEPENDENCY_DORMANT');
const restoredHost = host.updateDependencies([dependency()], rooted('c'));
assert.equal(restoredHost.state, 'installed');
lifecycle.push(host.upgrade('0.2.0', evidence('0.2.0')));
lifecycle.push(host.rollback(packageIdentity.version, evidence()));
lifecycle.push(host.deactivate(), host.uninstall());

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
  bridge: {
    available: true,
    dormantCodes: dormantCases.map(([, code]) => code),
    capability: calls[0].capability,
    proposalRoot: captured.proposalRoot,
    findingRoot: captured.effect.findingRoot,
    duplicateCode: deduplicated.code,
    automaticEffects: ['immutable-finding-capture'],
    refusedEffects: forbiddenEffects.map(([label]) => label),
  },
  intake: {
    acceptedRoot: accepted.receipt.receiptRoot,
    replayCode: replay.receipt.code,
  },
  lifecycle: lifecycle.map((row) => ({
    operation: row.operation,
    outcome: row.outcome,
    state: row.state,
    code: row.code,
    receiptRoot: row.receiptRoot,
  })),
  nonClaims: [
    'fixture-does-not-admit-dogfood-issues',
    'fixture-does-not-create-or-complete-work',
    'fixture-does-not-mutate-github',
    'fixture-does-not-assert-semantic-completion',
  ],
};
process.stdout.write(`${JSON.stringify(receipt)}\n`);
