// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';

import {
  fetchPublicWarrantQueue,
  runNativeExecutionUnderWarrant,
} from '../developer/dev-delivery/native-execution-under-warrant.mjs';
import {
  digest,
  nativeToolchainIdentity,
  observeNativeToolchain,
} from './affected-native-proof.mjs';

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
      environment: {},
      now: () => NOW,
      observe: async () => {
        observations += 1;
        return initial;
      },
      runNative: async ({ command, heartbeat, executionBinding }) => {
        assert.equal(command, options().command);
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

test('protected runtime credential ancestry rejection cannot issue a consumer receipt', async () => {
  const value = fixture();
  const rejection = new Error('credential ancestry contains GITHUB_TOKEN');
  value.dependencies.runNative = async (input) => {
    assert.equal(Object.hasOwn(input, 'ancestryCheck'), false);
    throw rejection;
  };
  await assert.rejects(
    runNativeExecutionUnderWarrant(options(), value.dependencies),
    (error) => error === rejection,
  );
  assert.equal(value.spawned, false);
});

const HOSTED_RUNNER_FACTS = {
  RUNNER_ENVIRONMENT: 'github-hosted',
  RUNNER_OS: 'Linux',
  RUNNER_ARCH: 'X64',
  ImageOS: 'ubuntu24',
  ImageVersion: '20260831.293.1',
};

test('credentialless native execution retains admissible exact hosted runner facts', async () => {
  const value = fixture();
  value.dependencies.environment = {
    ...HOSTED_RUNNER_FACTS,
    BUILDCHAIN_CREDENTIAL_ANCESTRY_BOUNDARY: 'github-actions-runner-worker/v1',
    GH_TOKEN: 'must-not-reach-native',
    GITHUB_TOKEN: 'must-not-reach-native',
    UNRELATED_SETTING: 'must-not-reach-native',
  };
  let executedCommand;
  let environment;
  value.dependencies.runNative = async ({ command, heartbeat }) => {
    await heartbeat();
    executedCommand = command;
    const output = execFileSync(
      'bash',
      ['--noprofile', '--norc', '-c', command],
      {
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        encoding: 'utf8',
      },
    );
    environment = Object.fromEntries(
      output
        .split('\0')
        .filter(Boolean)
        .map((entry) => {
          const separator = entry.indexOf('=');
          return [entry.slice(0, separator), entry.slice(separator + 1)];
        }),
    );
    return { receiptRoot: TOOLCHAIN };
  };
  const receipt = await runNativeExecutionUnderWarrant(
    { ...options(), command: 'env -0' },
    value.dependencies,
  );
  const toolchain = observeNativeToolchain(environment, {
    compiler: process.execPath,
    cmake: process.execPath,
    ninja: process.execPath,
  });
  assert.doesNotThrow(() => nativeToolchainIdentity(toolchain, true));
  for (const [name, expected] of Object.entries(HOSTED_RUNNER_FACTS)) {
    assert.equal(environment[name], expected);
  }
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'UNRELATED_SETTING']) {
    assert.equal(environment[name], undefined);
    assert.equal(
      executedCommand.includes(value.dependencies.environment[name]),
      false,
    );
  }
  assert.equal(receipt.commandRoot, digest({ command: executedCommand }));
});

for (const name of Object.keys(HOSTED_RUNNER_FACTS)) {
  test(`hosted execution rejects a missing ${name} before spawning`, async () => {
    const value = fixture();
    value.dependencies.environment = {
      ...HOSTED_RUNNER_FACTS,
      BUILDCHAIN_CREDENTIAL_ANCESTRY_BOUNDARY:
        'github-actions-runner-worker/v1',
    };
    delete value.dependencies.environment[name];
    await assert.rejects(
      runNativeExecutionUnderWarrant(options(), value.dependencies),
      new RegExp(`hosted runner fact ${name}`, 'u'),
    );
    assert.equal(value.spawned, false);
  });
}

test('hosted runner facts cannot inject shell syntax into the native command', async () => {
  const value = fixture();
  value.dependencies.environment = {
    ...HOSTED_RUNNER_FACTS,
    ImageVersion: '$(printf injected)',
  };
  await assert.rejects(
    runNativeExecutionUnderWarrant(options(), value.dependencies),
    /hosted runner fact ImageVersion/u,
  );
  assert.equal(value.spawned, false);
});

test('native shard commands reconstruct required build settings from a minimal child environment', () => {
  const workflow = fs.readFileSync(
    new URL('../.github/workflows/affected-native-pr.yml', import.meta.url),
    'utf8',
  );
  const shard = workflow.slice(workflow.indexOf('  affected_native_shards:\n'));
  const start = shard.indexOf('          command: |\n');
  const end = shard.indexOf(
    '            ./shifu install --frozen-lockfile',
    start,
  );
  assert.ok(start >= 0 && end > start);
  const prelude = shard.slice(start + '          command: |\n'.length, end);
  for (const partition of [0, 1]) {
    for (const cache of ['true', 'false']) {
      const command = prelude
        .replaceAll('${{ steps.revisions.outputs.base_sha }}', BASE)
        .replaceAll('${{ steps.revisions.outputs.head_sha }}', HEAD)
        .replaceAll('${{ matrix.partition }}', String(partition))
        .replaceAll(
          '${{ steps.compiler-cache-tool.outputs.available }}',
          cache,
        );
      assert.doesNotMatch(command, /\$\{\{/u);
      const output = execFileSync(
        'bash',
        ['--noprofile', '--norc', '-c', `${command}\nenv -0`],
        {
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
          encoding: 'utf8',
        },
      );
      const environment = Object.fromEntries(
        output
          .split('\0')
          .filter(Boolean)
          .map((entry) => {
            const separator = entry.indexOf('=');
            return [entry.slice(0, separator), entry.slice(separator + 1)];
          }),
      );
      assert.equal(
        environment.KUNGFU_AFFECTED_NATIVE_PARTITION_INDEX,
        String(partition),
      );
      assert.equal(environment.KUNGFU_AFFECTED_NATIVE_PARTITION_COUNT, '2');
      assert.equal(environment.KUNGFU_BUILDCHAIN_SOURCE_BUILD, '1');
      assert.equal(environment.GITHUB_BASE_SHA, BASE);
      assert.equal(environment.GITHUB_HEAD_SHA, HEAD);
      assert.equal(environment.GITHUB_WORKSPACE, process.cwd());
      assert.equal(environment.CC, 'gcc-14');
      assert.equal(environment.CXX, 'g++-14');
      assert.equal(
        environment.KUNGFU_CANDIDATE_GATE_ID,
        'source.changed-scope',
      );
      assert.equal(
        environment.KUNGFU_CANDIDATE_TIMELINE_EVENTS,
        `${process.cwd()}/product/qualification/affected-native/candidate-events.jsonl`,
      );
      assert.equal(
        environment.CMAKE_C_COMPILER_LAUNCHER,
        cache === 'true' ? 'ccache' : undefined,
      );
      assert.equal(environment.GITHUB_TOKEN, undefined);
      assert.equal(environment.GH_TOKEN, undefined);
    }
  }
});
