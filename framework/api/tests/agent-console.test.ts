import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAgentConsoleEnvelope,
  buildWorkRef,
  prepareAgentConsoleLaunch,
} from '../src/capability/agent-console.ts';
import { openAgentRuntime } from '../src/capability/agent-runtime.ts';

const profile = {
  schema: 'kungfu.agent-runtime-profile/v1' as const,
  id: 'codex.test',
  label: 'Codex test',
  provider: 'codex' as const,
  launch: {
    executable: '/usr/bin/codex',
    argv: ['--model', 'test'],
    shellMode: false,
  },
  cwdPolicy: 'workspace-root' as const,
  backendDefault: 'tmux' as const,
  bootstrap: { adapter: 'codex' as const, envelope: 'required' as const },
  source: 'user' as const,
};

test('Console envelope binds exact work and launch identity', async () => {
  const workRef = await buildWorkRef({
    workspaceId: 'atlas',
    profileId: 'kungfu.mission-control',
    profileRoot: `sha256:${'a'.repeat(64)}`,
    entityType: 'go',
    entityId: 'goal-1',
    entity: { goal_id: 'goal-1', status: 'active' },
    purpose: 'finish the goal',
    systemTimeCut: '123',
  });
  const envelope = await buildAgentConsoleEnvelope({
    workspaceId: 'atlas',
    consoleId: 'work:goal-1',
    attemptId: 'attempt:1',
    runtimeProfile: profile,
    workRef,
    activeProfiles: [{ id: workRef.profileId, root: workRef.profileRoot }],
    controlRuntimeDir: '/control/runtime',
  });
  assert.match(workRef.entityRoot, /^sha256:[a-f0-9]{64}$/);
  assert.match(envelope.envelopeRoot, /^sha256:[a-f0-9]{64}$/);
  const launch = prepareAgentConsoleLaunch({
    profile,
    envelope,
    workspaceRoot: '/workspace',
  });
  assert.equal(launch.command, '/usr/bin/codex');
  assert.equal(launch.cwd, '/workspace');
  assert.equal(launch.backend, 'tmux');
  assert.equal(launch.env.KUNGFU_CONTROL_RUNTIME_DIR, '/control/runtime');
  assert.equal(launch.env.KUNGFU_WORKSPACE_ROOT, '/workspace');
  assert.equal(launch.env.KF_HOME, undefined);
  assert.equal(launch.env.KF_RUNTIME_DIR, undefined);
  assert.deepEqual(envelope.runtimeRouting, {
    controlRuntimeDir: '/control/runtime',
    workRuntimeDir: null,
    workRuntimeResolution: 'agent-project-cut',
  });
  assert.deepEqual(launch.args.slice(0, 2), ['--model', 'test']);
  assert.equal(
    JSON.parse(launch.env.KUNGFU_AGENT_CONSOLE_ENVELOPE).envelopeRoot,
    envelope.envelopeRoot,
  );
});

test('Agent Runtime adapter keeps writes preview-first', async () => {
  const calls: string[][] = [];
  const runtime = openAgentRuntime({
    bin: '/kungfu',
    execFile: async (_file, args) => {
      calls.push(args);
      return '{}';
    },
  });
  await runtime.upsert({
    id: 'codex.test',
    label: 'Test',
    provider: 'codex',
    executable: '/codex',
  });
  await runtime.setDefault('codex.test', true);
  assert.equal(calls[0].includes('--execute'), false);
  assert.equal(calls[1].includes('--execute'), true);
  assert.deepEqual(calls[0].slice(0, 3), ['agent', 'runtime', 'upsert']);
});
