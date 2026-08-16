import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  agentSessionSemanticRoot,
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
    interactiveArgv: ['--no-alt-screen'],
    versionArgv: ['--version'],
    shellMode: false,
  },
  cwdPolicy: 'workspace-root' as const,
  backendDefault: 'tmux' as const,
  bootstrap: { adapter: 'codex' as const, envelope: 'required' as const },
  source: 'user' as const,
  lastVerified: null,
};

test('TypeScript canonical roots match the Agent Session golden fixture', async () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      new URL(
        '../../agent-session/tests/fixtures/agent-session-core-golden.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  assert.equal(
    await agentSessionSemanticRoot(fixture.workRef),
    fixture.workRefRoot,
  );
  assert.equal(
    await agentSessionSemanticRoot(fixture.envelopeBody),
    fixture.envelopeRoot,
  );
});

test('Console envelope binds exact work and launch identity', async () => {
  const workRef = await buildWorkRef({
    workspaceId: 'project-alpha',
    profileId: 'kungfu.work-control',
    profileRoot: `sha256:${'a'.repeat(64)}`,
    entityType: 'assignment',
    entityId: 'assignment-1',
    entity: { assignment_id: 'assignment-1', status: 'active' },
    purpose: 'finish the assignment',
    systemTimeCut: '123',
    initiativeId: 'initiative-1',
  });
  const envelope = await buildAgentConsoleEnvelope({
    workspaceId: 'project-alpha',
    consoleId: 'work:assignment-1',
    attemptId: 'attempt:1',
    runtimeProfile: profile,
    workRef,
    activeProfiles: [{ id: workRef.profileId, root: workRef.profileRoot }],
  });
  assert.match(workRef.entityRoot, /^sha256:[a-f0-9]{64}$/);
  assert.match(envelope.envelopeRoot, /^sha256:[a-f0-9]{64}$/);
  const launch = prepareAgentConsoleLaunch({
    profile,
    envelope,
    workspaceRoot: '/workspace',
    controlRuntimeDir: '/control/runtime',
  });
  assert.equal(launch.command, '/usr/bin/codex');
  assert.equal(launch.cwd, '/workspace');
  assert.equal(launch.backend, 'tmux');
  assert.equal(launch.env.KUNGFU_CONTROL_RUNTIME_DIR, '/control/runtime');
  assert.equal(launch.env.KUNGFU_WORKSPACE_ROOT, '/workspace');
  assert.equal(launch.env.KF_HOME, undefined);
  assert.equal(launch.env.KF_RUNTIME_DIR, undefined);
  assert.equal('runtimeRouting' in envelope, false);
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
