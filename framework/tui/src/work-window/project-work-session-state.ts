// SPDX-License-Identifier: Apache-2.0

import type { ProjectWorkRunSnapshot } from '@kungfu-tech/api/capability';

function runPriority(candidate: ProjectWorkRunSnapshot): number {
  if (candidate.session?.live) return 3;
  if (
    candidate.running ||
    (candidate.session?.backend === 'native-interactive' &&
      candidate.session.lifecycleState !== 'ended')
  ) {
    return 2;
  }
  return 1;
}

export function projectWorkSessionState({
  runs,
  workspace,
  allowNewWorkOverRetainedRun,
}: {
  runs: ProjectWorkRunSnapshot[];
  workspace: string;
  allowNewWorkOverRetainedRun: boolean;
}) {
  const projectRuns = runs.filter(
    (candidate) => candidate.workspace === workspace,
  );
  const visibleRun = allowNewWorkOverRetainedRun
    ? null
    : ([...projectRuns].sort(
        (left, right) =>
          runPriority(right) - runPriority(left) ||
          right.lastEventAt - left.lastEventAt,
      )[0] ?? null);
  const session = visibleRun?.session;
  const attention = session?.attention;
  const providerSessionActive = Boolean(
    visibleRun?.running ||
      session?.live ||
      (session?.backend === 'native-interactive' &&
        session.lifecycleState !== 'ended'),
  );
  const visibleWorkId =
    visibleRun?.work ?? session?.nativeObserver?.work?.assignmentId;
  const projectWorkCount = new Set(
    projectRuns
      .map(
        (candidate) =>
          candidate.work ??
          candidate.session?.nativeObserver?.work?.assignmentId,
      )
      .filter((work): work is string => Boolean(work)),
  ).size;
  const retainedAgentFinished =
    visibleRun?.receipt?.status === 'agent-finished';
  const retainedAgentReviewable = Boolean(
    visibleRun?.receipt &&
      (retainedAgentFinished ||
        attention?.kind === 'ready-for-review' ||
        attention?.kind === 'needs-answer'),
  );
  return {
    projectRuns,
    visibleRun,
    session,
    attention,
    nativeObserverDisplayState: session?.nativeObserver?.state,
    providerSessionActive,
    visibleWorkId,
    projectWorkCount,
    retainedAgentFinished,
    retainedAgentReviewable,
  };
}
