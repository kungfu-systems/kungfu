import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AgentRuntime,
  AgentRuntimeCatalog,
  AgentRuntimeProfile,
} from '@kungfu-tech/api/capability';
import {
  availableAgentRuntimeProfiles,
  rememberDiscoveredAgentRuntimeProfile,
} from '../src/view/agent-runtime-catalog.ts';

function profile(
  id: string,
  source: AgentRuntimeProfile['source'],
): AgentRuntimeProfile {
  return {
    schema: 'kungfu.agent-runtime-profile/v1',
    id,
    label: id,
    provider: 'codex',
    launch: { executable: '/usr/bin/codex', argv: [], shellMode: false },
    cwdPolicy: 'workspace-root',
    backendDefault: 'tmux',
    bootstrap: { adapter: 'codex', envelope: 'required' },
    source,
  };
}

test('detected recommended Agent is launchable before Settings configuration', () => {
  const detected = profile('codex.detected', 'discovered');
  const catalog = {
    configured: [],
    discovered: [
      {
        profile: detected,
        pathClass: 'path',
        version: 'codex-cli test',
        available: true,
        candidatesChecked: ['/usr/bin/codex'],
      },
    ],
    defaultProfileId: null,
    recommendedProfileId: detected.id,
  } as AgentRuntimeCatalog;

  assert.deepEqual(availableAgentRuntimeProfiles(catalog), [detected]);
});

test('first launch remembers a detected Agent as the exact default profile', async () => {
  const detected = profile('codex.detected', 'discovered');
  const calls: unknown[][] = [];
  const runtime = {
    upsert: async (...args: unknown[]) => {
      calls.push(['upsert', ...args]);
      return {};
    },
    setDefault: async (...args: unknown[]) => {
      calls.push(['setDefault', ...args]);
      return {};
    },
  } as unknown as AgentRuntime;

  assert.equal(
    await rememberDiscoveredAgentRuntimeProfile(runtime, detected),
    true,
  );
  assert.equal((calls[0][1] as { id: string }).id, detected.id);
  assert.deepEqual(calls[0].slice(-1), [true]);
  assert.deepEqual(calls[1], ['setDefault', detected.id, true]);
});
