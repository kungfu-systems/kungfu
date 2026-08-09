import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORK_CONSOLE_REGISTRY_SCHEMA,
  WorkConsoleRegistry,
  primaryWorkConsoleId,
} from '../src/work-console-registry.mjs';

const ROOT = `sha256:${'a'.repeat(64)}`;

function workRef(initiativeId, entityId = 'same-assignment-id') {
  return {
    schema: 'kungfu.work-ref/v1',
    workspaceId: 'workspace:project',
    profileId: 'kungfu.work-control',
    profileRoot: ROOT,
    entityType: 'assignment',
    entityId,
    entityRoot: `sha256:${'b'.repeat(64)}`,
    purpose: 'continue-project-assignment',
    systemTimeCut: '2026-08-02T00:00:00Z',
    initiativeId,
  };
}

function nativeSnapshot({ observedAt = 1000, staleAfterMs = 2000 } = {}) {
  const ref = workRef('initiative-a');
  return {
    schema: WORK_CONSOLE_REGISTRY_SCHEMA,
    activeWorkLeases: [],
    consoles: [
      {
        consoleId: 'assistant:workspace:project:native:first',
        workspaceId: 'workspace:project',
        binding: { kind: 'workspace-assistant', workRef: null },
        runtimeProfileId: 'codex.path.test',
        backend: 'native-interactive',
        attempts: [
          {
            sessionAttemptId: 'native:first',
            runId: 'native:first',
            provider: 'codex',
            providerVersion: '1.0.0',
            runtimeProfileId: 'codex.path.test',
            backend: 'native-interactive',
            status: 'running',
            startedAt: 500,
            plans: [],
            receipts: [],
            observer: {
              state: 'fresh',
              observedAt,
              staleAfterMs,
              processIdentityRoot: ROOT,
              work: null,
              diagnostic: null,
            },
            workBinding: { kind: 'work', workRef: ref },
          },
        ],
        createdAt: 500,
        updatedAt: observedAt,
      },
    ],
  };
}

test('canonical Work identity includes Initiative while consoles stay automatic', () => {
  const first = primaryWorkConsoleId({
    workspaceId: 'workspace:project',
    binding: { kind: 'work', workRef: workRef('initiative-a') },
  });
  const second = primaryWorkConsoleId({
    workspaceId: 'workspace:project',
    binding: { kind: 'work', workRef: workRef('initiative-b') },
  });
  assert.notEqual(first, second);
  assert.match(first, /initiative-a/u);
});

test('a fresh recovery lease remains exclusive and exact process evidence revives it', () => {
  let now = 2000;
  const registry = new WorkConsoleRegistry({
    snapshot: nativeSnapshot({ observedAt: 1500, staleAfterMs: 2000 }),
    now: () => now,
  });
  const binding = { kind: 'work', workRef: workRef('initiative-a') };
  assert.equal(
    registry.activeWorkConflict(binding).lease.state,
    'recovery-pending',
  );
  registry.recordNativeHeartbeat(
    {
      workConsoleId: 'assistant:workspace:project:native:first',
      sessionAttemptId: 'native:first',
    },
    {
      state: 'fresh',
      observedAt: now,
      staleAfterMs: 2000,
      processIdentityRoot: ROOT,
      work: null,
      diagnostic: null,
    },
  );
  now = 8000;
  assert.equal(registry.activeWorkConflict(binding).lease.state, 'active');
});

test('an expired recovery lease is released only after its evidence deadline', () => {
  const registry = new WorkConsoleRegistry({
    snapshot: nativeSnapshot({ observedAt: 1000, staleAfterMs: 2000 }),
    now: () => 4000,
  });
  const binding = { kind: 'work', workRef: workRef('initiative-a') };
  assert.equal(registry.activeWorkConflict(binding), null);
  const attempt = registry.snapshot().consoles[0].attempts[0];
  assert.equal(
    attempt.receipts.at(-1).reason,
    'exact-native-process-evidence-expired-after-worker-restart',
  );
});
