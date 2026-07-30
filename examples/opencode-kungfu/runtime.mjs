// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const REQUIRED_METHODS = [
  'storageEpisodeBeginTyped',
  'storageEpisodeHeartbeatTyped',
  'storageEpisodeCloseTyped',
  'storageEpisodeRecoverTyped',
  'storageEpisodeInspectTyped',
  'runStorageTransferOperationJson',
];

function defaultBinding() {
  return require('@kungfu-tech/core').kungfu();
}

function defaultClock() {
  return Date.now() * 1_000_000;
}

function assertBinding(binding) {
  const missing = REQUIRED_METHODS.filter(
    (method) => typeof binding?.[method] !== 'function',
  );
  if (missing.length > 0) {
    throw new Error(
      `libkungfu native Episode binding unavailable: ${missing.join(', ')}`,
    );
  }
}

function sessionId(input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('OpenCode session id is required');
  }
  return input;
}

export function resolveRuntimeDir({ directory, worktree, runtimeDir } = {}) {
  const configured =
    runtimeDir || process.env.KUNGFU_OPENCODE_RUNTIME_DIR || '';
  const projectRoot = worktree || directory || process.cwd();
  return path.resolve(
    configured || path.join(projectRoot, '.kungfu', 'opencode'),
  );
}

export function createEpisodeRuntime({
  binding = defaultBinding(),
  runtimeDir,
  clock = defaultClock,
} = {}) {
  assertBinding(binding);
  if (!runtimeDir) throw new Error('libkungfu runtime directory is required');

  const active = new Map();
  const closed = new Map();

  function begin(id) {
    const key = sessionId(id);
    if (active.has(key)) return active.get(key);
    closed.delete(key);
    const opened = binding.storageEpisodeBeginTyped(runtimeDir, {
      begin_time: clock(),
      title: 'OpenCode agent session',
      actor: 'opencode',
      source: 'opencode.plugin.lifecycle',
    });
    active.set(key, opened.episode_id);
    return opened.episode_id;
  }

  function heartbeat(id, phase) {
    const key = sessionId(id);
    const episodeId = begin(key);
    return binding.storageEpisodeHeartbeatTyped(runtimeDir, {
      episode_id: episodeId,
      update_time: clock(),
      note: phase,
    });
  }

  function close(id, { aborted = false, reason = 'session idle' } = {}) {
    const key = sessionId(id);
    const episodeId = active.get(key);
    if (episodeId === undefined) return null;
    const result = binding.storageEpisodeCloseTyped(runtimeDir, {
      episode_id: episodeId,
      aborted,
      end_time: clock(),
      reason,
    });
    active.delete(key);
    closed.set(key, episodeId);
    return result;
  }

  function inspect(id) {
    const key = sessionId(id);
    const episodeId = active.get(key) ?? closed.get(key);
    if (episodeId === undefined) return null;
    return binding.storageEpisodeInspectTyped(runtimeDir, {
      episode_id: episodeId,
    });
  }

  function exportEpisode(id) {
    const key = sessionId(id);
    const episodeId = closed.get(key);
    if (episodeId === undefined) {
      throw new Error(`OpenCode session is not sealed: ${key}`);
    }
    return binding.runStorageTransferOperationJson(
      'export_bundle',
      runtimeDir,
      JSON.stringify({
        scope: 'episode',
        episode_id: String(episodeId),
        thin: false,
      }),
    );
  }

  const recovery = binding.storageEpisodeRecoverTyped(runtimeDir, {
    end_time: clock(),
    reason: 'OpenCode plugin process restart',
  });

  return {
    runtimeDir,
    recovery,
    begin,
    heartbeat,
    close,
    inspect,
    exportEpisode,
  };
}
