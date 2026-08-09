import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  Rewind,
  RewindEvent,
  RewindRun,
  RewindRunSummary,
} from '@kungfu-tech/api/capability';
import { loadGoalProgress } from '../src/view/agent-progress.ts';

function fakeRewind(events: RewindEvent[]): Rewind & { refreshes: number } {
  const summary: RewindRunSummary = {
    runId: 'attempt-1',
    beginTime: 1n,
    eventCount: events.length,
    errorCount: 0,
  };
  const run: RewindRun = { summary, events, roots: [] };
  const rewind = {
    runtimeDir: '/control/runtime',
    refreshes: 0,
    runs: () => [summary],
    loadRun: (runId: string) => (runId === summary.runId ? run : null),
    refresh: () => {
      rewind.refreshes += 1;
    },
  };
  return rewind;
}

test('loads newest live observations for the selected Go only', () => {
  const rewind = fakeRewind([
    {
      kind: 'RunProgress',
      genTime: 2n,
      runId: 'attempt-1',
      entityType: 'go',
      entityId: 'go-1',
      message: 'building',
      phase: 'implement',
      signal: 'progress',
      severity: 'info',
    },
    {
      kind: 'RunProgress',
      genTime: 3n,
      runId: 'attempt-1',
      entityType: 'go',
      entityId: 'go-2',
      message: 'other goal',
    },
    {
      kind: 'RunProgress',
      genTime: 4n,
      runId: 'attempt-1',
      entityType: 'go',
      entityId: 'go-1',
      message: 'waiting for review',
      signal: 'waiting',
      severity: 'warn',
      nextAction: 'review',
    },
  ]);

  assert.deepEqual(loadGoalProgress(rewind, 'go-1'), [
    {
      runId: 'attempt-1',
      genTime: 4n,
      phase: undefined,
      message: 'waiting for review',
      severity: 'warn',
      pct: undefined,
      signal: 'waiting',
      nextAction: 'review',
    },
    {
      runId: 'attempt-1',
      genTime: 2n,
      phase: 'implement',
      message: 'building',
      severity: 'info',
      pct: undefined,
      signal: 'progress',
      nextAction: undefined,
    },
  ]);
  assert.equal(rewind.refreshes, 1);
});
