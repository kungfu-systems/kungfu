// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { createKungfuOpenCodePlugin } from '../index.mjs';
import { createEpisodeRuntime } from '../runtime.mjs';

function inspectCalls(calls) {
  return JSON.stringify(calls, (_, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

function fakeBinding() {
  let nextEpisode = 700n;
  const open = new Map();
  const calls = [];
  return {
    calls,
    storageEpisodeBeginTyped(runtimeDir, options) {
      const episode_id = nextEpisode;
      nextEpisode += 1n;
      open.set(episode_id, { ...options });
      calls.push({ operation: 'begin', runtimeDir, options });
      return { episode_id };
    },
    storageEpisodeHeartbeatTyped(runtimeDir, options) {
      assert.equal(open.has(options.episode_id), true);
      calls.push({ operation: 'heartbeat', runtimeDir, options });
      return options;
    },
    storageEpisodeCloseTyped(runtimeDir, options) {
      assert.equal(open.delete(options.episode_id), true);
      calls.push({ operation: 'close', runtimeDir, options });
      return { close: options };
    },
    storageEpisodeRecoverTyped(runtimeDir, options) {
      const recovered = [...open].map(([episode_id]) => ({
        close: { episode_id, status: 3 },
      }));
      open.clear();
      calls.push({ operation: 'recover', runtimeDir, options });
      return { recovered, skipped_open: [] };
    },
    storageEpisodeInspectTyped(runtimeDir, options) {
      calls.push({ operation: 'inspect', runtimeDir, options });
      return { episode: { episode_id: options.episode_id } };
    },
    runStorageTransferOperationJson(operation, runtimeDir, optionsJson) {
      const options = JSON.parse(optionsJson);
      calls.push({ operation, runtimeDir, options });
      return JSON.stringify({
        schema: 'kungfu.storage.episode-bundle/v1',
        episode_id: options.episode_id,
      });
    },
  };
}

test('official OpenCode hooks retain lifecycle metadata without prompt or credentials', async () => {
  const binding = fakeBinding();
  const secret = 'never-retain-provider-token-or-prompt';
  const plugin = createKungfuOpenCodePlugin({
    binding,
    clock: () => 1000,
    runtimeDir: '/tmp/opencode-reference.kungfu',
  });
  const hooks = await plugin({
    directory: '/project',
    worktree: '/project',
    client: { providerToken: secret },
  });

  await hooks.event({
    event: {
      type: 'session.created',
      properties: { info: { id: 'session-1', prompt: secret } },
    },
  });
  const beforeOutput = { args: { command: secret } };
  await hooks['tool.execute.before'](
    { sessionID: 'session-1', tool: 'bash', prompt: secret },
    beforeOutput,
  );
  await hooks['tool.execute.after'](
    { sessionID: 'session-1', tool: 'bash' },
    { output: secret },
  );
  await hooks.event({
    event: { type: 'session.idle', properties: { sessionID: 'session-1' } },
  });

  assert.deepEqual(beforeOutput, { args: { command: secret } });
  assert.deepEqual(
    binding.calls.map(({ operation }) => operation),
    ['recover', 'begin', 'heartbeat', 'heartbeat', 'close'],
  );
  assert.equal(
    binding.calls
      .filter(({ operation }) => ['heartbeat', 'close'].includes(operation))
      .some(({ options }) => Object.hasOwn(options, 'frame_count')),
    false,
  );
  assert.equal(inspectCalls(binding.calls).includes(secret), false);
});

test('restart recovers an unsealed Episode before accepting resumed work', async () => {
  const binding = fakeBinding();
  const first = await createKungfuOpenCodePlugin({
    binding,
    clock: () => 2000,
    runtimeDir: '/tmp/opencode-restart.kungfu',
  })({});
  await first.event({
    event: {
      type: 'session.created',
      properties: { info: { id: 'long-task' } },
    },
  });
  await first['tool.execute.before']({ sessionID: 'long-task' }, {});

  const second = await createKungfuOpenCodePlugin({
    binding,
    clock: () => 3000,
    runtimeDir: '/tmp/opencode-restart.kungfu',
  })({});
  await second.event({
    event: {
      type: 'session.updated',
      properties: { info: { id: 'long-task' } },
    },
  });
  await second.event({
    event: {
      type: 'session.error',
      properties: { sessionID: 'long-task', error: 'private-error-body' },
    },
  });

  const recoveries = binding.calls.filter(
    ({ operation }) => operation === 'recover',
  );
  assert.equal(recoveries.length, 2);
  assert.equal(
    binding.calls.some(
      ({ operation, options }) =>
        operation === 'close' && options.aborted === true,
    ),
    true,
  );
  assert.equal(
    inspectCalls(binding.calls).includes('private-error-body'),
    false,
  );
});

test('service-operation JSON edge uses decimal Episode identifiers', () => {
  const binding = fakeBinding();
  const runtime = createEpisodeRuntime({
    binding,
    clock: () => 4000,
    runtimeDir: '/tmp/opencode-export.kungfu',
  });
  const episodeId = runtime.begin('export-task');
  assert.equal(typeof episodeId, 'bigint');
  runtime.close('export-task');

  runtime.exportEpisode('export-task');

  const exported = binding.calls.find(
    ({ operation }) => operation === 'export_bundle',
  );
  assert.equal(exported.options.episode_id, '700');
});
