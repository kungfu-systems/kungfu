export function assignmentSelector(subject: string): string | undefined {
  return subject.split(':').filter(Boolean).at(-1);
}

export function shouldRestoreRetainedProjectRun(
  work:
    | {
        phase?: string;
        requestRoot: string;
      }
    | undefined,
  row: { canonical_root: string } | null,
): boolean {
  if (!work || !row) return false;
  return Boolean(work.phase) || row.canonical_root !== work.requestRoot;
}

export const RESTORING_RETAINED_AGENT_RESULT =
  'Restoring retained Agent result…';

export function settleRetainedProjectRunBusy(current: string): string {
  return current === RESTORING_RETAINED_AGENT_RESULT ? '' : current;
}

export function resolveWorkProject<
  T extends { id: string; path: string },
  O extends { workspace_id?: string },
>(observations: O[], projects: T[]): T | undefined {
  return projects.find((project) =>
    observations.some(
      (observation) =>
        observation.workspace_id === project.id ||
        observation.workspace_id === project.path,
    ),
  );
}
