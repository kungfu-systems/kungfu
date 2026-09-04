// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchPublicWarrantQueue,
  runNativeExecutionUnderWarrant,
} from '../developer/dev-delivery/native-execution-under-warrant.mjs';

const HEAD = '1'.repeat(40);
const TOKEN = `sha256:${'2'.repeat(64)}`;
const CANDIDATE = `sha256:${'3'.repeat(64)}`;
const TOOLCHAIN = `sha256:${'4'.repeat(64)}`;
const ENVIRONMENT = `sha256:${'5'.repeat(64)}`;
const BASE = '6'.repeat(40);
const NOW = '2026-08-12T00:00:00.000Z';

function observation(overrides = {}) {
  const warrant = {
    candidateId: CANDIDATE,
    pullRequestNumber: 42,
    sourceHead: HEAD,
    qualifiedBase: BASE,
    toolchainRoot: TOOLCHAIN,
    environmentRoot: ENVIRONMENT,
    phase: 'provisional',
    fencingToken: TOKEN,
    generation: 7,
    expiresAt: '2026-08-12T01:00:00.000Z',
    ...overrides,
  };
  return {
    observation: {
      activeWarrant: warrant,
      activeCandidate: {
        candidateId: warrant.candidateId,
        pullRequestNumber: warrant.pullRequestNumber,
        sourceHead: warrant.sourceHead,
      },
    },
  };
}

function options() {
  return {
    repository: 'kungfu-systems/kungfu',
    branch: 'dev/v4/v4.0',
    pullRequestNumber: 42,
    sourceHead: HEAD,
    qualifiedBase: BASE,
    toolchainRoot: TOOLCHAIN,
    environmentRoot: ENVIRONMENT,
    allowedPhases: 'provisional,qualified',
    command: './shifu gate run source.changed-scope',
    heartbeatSeconds: 1,
    leaseSeconds: 10,
  };
}

function fixture(initial = observation()) {
  let spawned = false;
  let observations = 0;
  return {
    get spawned() {
      return spawned;
    },
    get observations() {
      return observations;
    },
    dependencies: {
      now: () => NOW,
      observe: async () => {
        observations += 1;
        return initial;
      },
      runNative: async ({ heartbeat, executionBinding }) => {
        await heartbeat();
        spawned = true;
        assert.deepEqual(executionBinding, {
          repository: 'kungfu-systems/kungfu',
          protectedBase: 'dev/v4/v4.0',
          sourceHead: HEAD,
          qualifiedBase: BASE,
          toolchainRoot: TOOLCHAIN,
          environmentRoot: ENVIRONMENT,
        });
        await heartbeat();
        return { receiptRoot: `sha256:${'4'.repeat(64)}` };
      },
    },
  };
}

test('public Warrant queue reads retain a bounded buffer above one MiB', () => {
  const queue = JSON.stringify({ padding: 'x'.repeat(1024 * 1024) });
  const calls = [];
  const values = ['', `${HEAD}\n`, queue];
  const fetched = fetchPublicWarrantQueue({
    observerRoot: '/tmp/kungfu-public-warrant-observer',
    repository: 'kungfu-systems/kungfu',
    branch: 'dev/v4/v4.0',
    stateRef: 'buildchain/dev-delivery-warrant/dev-v4-v4.0',
    execGit: (file, args, options) => {
      calls.push({ file, args, options });
      return values.shift();
    },
  });

  assert.equal(fetched.stateCommit, HEAD);
  assert.equal(fetched.queue.padding.length, 1024 * 1024);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.file, 'git');
    assert.ok(call.options.maxBuffer >= Buffer.byteLength(queue));
  }
});

test('exact credentialless observations continuously fence native execution', async () => {
  const value = fixture();
  const receipt = await runNativeExecutionUnderWarrant(
    options(),
    value.dependencies,
  );
  assert.equal(value.spawned, true);
  assert.equal(value.observations, 4);
  assert.equal(receipt.fenceMode, 'credentialless-observation');
  assert.equal(receipt.fencingToken, TOKEN);
  assert.equal(receipt.leaseGeneration, 7);
  assert.equal(
    receipt.nativeExecutionReceipt.receiptRoot,
    `sha256:${'4'.repeat(64)}`,
  );
  assert.match(receipt.receiptRoot, /^sha256:[0-9a-f]{64}$/u);
});

test('queued emergency contender cannot preempt the active Warrant binding', async () => {
  const active = observation();
  active.observation.queue = [
    {
      candidateId: `sha256:${'8'.repeat(64)}`,
      pullRequestNumber: 99,
      sourceHead: '9'.repeat(40),
      priority: 'emergency',
      status: 'queued',
    },
  ];
  const value = fixture(active);
  value.dependencies.observe = async () => active;

  const receipt = await runNativeExecutionUnderWarrant(
    options(),
    value.dependencies,
  );

  assert.equal(value.spawned, true);
  assert.equal(receipt.pullRequestNumber, 42);
  assert.equal(receipt.sourceHead, HEAD);
  assert.equal(receipt.fencingToken, TOKEN);
  assert.equal(receipt.leaseGeneration, 7);
});

for (const [label, changed, pattern] of [
  ['missing', null, /exact active Delivery Warrant is missing/u],
  [
    'PR mismatch',
    observation({ pullRequestNumber: 41 }),
    /pull request mismatch/u,
  ],
  [
    'head mismatch',
    observation({ sourceHead: '5'.repeat(40) }),
    /source head mismatch/u,
  ],
  ['expired', observation({ expiresAt: NOW }), /lease expired/u],
  [
    'stale phase',
    observation({ phase: 'settling' }),
    /phase settling is not allowed/u,
  ],
]) {
  test(`${label} Warrant blocks native execution`, async () => {
    const value = fixture(changed || { observation: {} });
    await assert.rejects(
      runNativeExecutionUnderWarrant(options(), value.dependencies),
      pattern,
    );
    assert.equal(value.spawned, false);
    assert.equal(value.observations, 1);
  });
}

test('fence change during execution fails closed', async () => {
  const value = fixture();
  value.dependencies.observe = async () => {
    value.dependencies.observe.calls =
      (value.dependencies.observe.calls || 0) + 1;
    return value.dependencies.observe.calls === 1
      ? observation()
      : observation({ fencingToken: `sha256:${'6'.repeat(64)}` });
  };
  await assert.rejects(
    runNativeExecutionUnderWarrant(options(), value.dependencies),
    /stale Delivery Warrant fencing token/u,
  );
});

test('transient credentialless observation failure fails closed', async () => {
  const value = fixture();
  let attempts = 0;
  value.dependencies.observe = async () => {
    attempts += 1;
    if (attempts === 2) throw new Error('public state ref unavailable');
    return observation();
  };
  await assert.rejects(
    runNativeExecutionUnderWarrant(options(), value.dependencies),
    /public state ref unavailable/u,
  );
  assert.equal(attempts, 2);
});
