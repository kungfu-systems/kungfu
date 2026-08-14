// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { runNativeExecutionUnderWarrant } from '../framework/dev-delivery/native-execution-under-warrant.mjs';

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
  let heartbeats = 0;
  return {
    get spawned() {
      return spawned;
    },
    get heartbeats() {
      return heartbeats;
    },
    dependencies: {
      now: () => NOW,
      observe: async () => initial,
      heartbeat: async () => {
        heartbeats += 1;
        return observation();
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

test('exact observe and heartbeat precede native execution', async () => {
  const value = fixture();
  const receipt = await runNativeExecutionUnderWarrant(
    options(),
    value.dependencies,
  );
  assert.equal(value.spawned, true);
  assert.equal(value.heartbeats, 3);
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
  value.dependencies.heartbeat = async () => active;

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
    assert.equal(value.heartbeats, 0);
  });
}

test('fence change during execution fails closed', async () => {
  const value = fixture();
  value.dependencies.heartbeat = async () => {
    value.dependencies.heartbeat.calls =
      (value.dependencies.heartbeat.calls || 0) + 1;
    return value.dependencies.heartbeat.calls === 1
      ? observation()
      : observation({ fencingToken: `sha256:${'6'.repeat(64)}` });
  };
  await assert.rejects(
    runNativeExecutionUnderWarrant(options(), value.dependencies),
    /stale Delivery Warrant fencing token/u,
  );
});

test('same-fence concurrent heartbeat write is observed and retried', async () => {
  const value = fixture();
  let attempts = 0;
  let waits = 0;
  value.dependencies.heartbeat = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Update is not a fast forward');
    return observation();
  };
  value.dependencies.wait = async (milliseconds) => {
    waits += 1;
    assert.equal(milliseconds, 200);
  };
  const receipt = await runNativeExecutionUnderWarrant(
    options(),
    value.dependencies,
  );
  assert.equal(value.spawned, true);
  assert.equal(waits, 1);
  assert.equal(receipt.fencingToken, TOKEN);
});

test('concurrent heartbeat retry fails closed when the fence changed', async () => {
  const value = fixture();
  let observations = 0;
  value.dependencies.observe = async () => {
    observations += 1;
    return observations === 1
      ? observation()
      : observation({ fencingToken: `sha256:${'6'.repeat(64)}` });
  };
  value.dependencies.heartbeat = async () => {
    throw new Error('Update is not a fast forward');
  };
  value.dependencies.wait = async () => {
    assert.fail('changed fence must not be retried');
  };
  await assert.rejects(
    runNativeExecutionUnderWarrant(options(), value.dependencies),
    /stale Delivery Warrant fencing token/u,
  );
  assert.equal(value.spawned, false);
});
