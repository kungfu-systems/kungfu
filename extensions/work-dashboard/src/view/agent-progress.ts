import type { Rewind, RewindEvent } from '@kungfu-tech/api/capability';

export type AgentProgressRow = {
  runId: string;
  genTime: bigint;
  phase?: string;
  message: string;
  severity: string;
  pct?: number;
  signal: string;
  nextAction?: string;
};

function isAssignmentProgress(
  event: RewindEvent,
  assignmentId: string,
): boolean {
  return (
    event.kind === 'RunProgress' &&
    event.entityType === 'assignment' &&
    event.entityId === assignmentId &&
    Boolean(event.message)
  );
}

export function loadAssignmentProgress(
  rewind: Rewind,
  assignmentId: string,
  limit = 50,
): AgentProgressRow[] {
  rewind.refresh();
  const rows = rewind
    .runs()
    .flatMap((run) => rewind.loadRun(run.runId)?.events ?? [])
    .filter((event) => isAssignmentProgress(event, assignmentId))
    .map((event) => ({
      runId: event.runId,
      genTime: event.genTime,
      phase: event.phase,
      message: event.message ?? '',
      severity: event.severity || 'info',
      pct: event.pct && event.pct > 0 ? event.pct : undefined,
      signal: event.signal || 'progress',
      nextAction: event.nextAction,
    }))
    .sort((left, right) =>
      left.genTime === right.genTime
        ? 0
        : left.genTime > right.genTime
          ? -1
          : 1,
    );
  return rows.slice(0, Math.max(0, limit));
}
