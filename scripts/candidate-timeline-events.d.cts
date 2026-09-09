// SPDX-License-Identifier: Apache-2.0
export interface DevChannelContract {
  branchPattern: string;
  admittedFamily: { minimumMajor: number };
  [key: string]: unknown;
}
export interface DevBranchOptions {
  env?: Record<string, string | undefined>;
  symbolicRemoteHead?: () => string;
  contract?: DevChannelContract;
}
export interface StageOptions {
  env?: Record<string, string | undefined>;
  category?: string;
  gateId?: string;
  platform?: string;
  parentId?: string;
  boundary?: string;
  criticalPathEligible?: boolean;
  language?: string;
}
export interface MergedPull {
  number: number;
  merged_at: string;
  updated_at: string;
}
export interface LatencyRecord {
  requiredWindow?: { startedAt?: string | null };
  mergeQueue?: { firstEnqueuedAt?: string | null };
  startedAt?: string | null;
  mergedAt?: string | null;
}
export interface MergeQueueEvidence {
  queueStatus?: string;
  status?: string;
  diagnostics?: string[];
  firstEnqueuedAt?: string;
  mergedAt?: string;
  rounds?: Array<{
    reason: string;
    removedAt: string;
    index: number;
    mergeGroupRuns?: Array<{
      id: number;
      headSha: string;
      jobs?: Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        startedAt?: string;
        completedAt: string;
      }>;
    }>;
  }>;
}
export interface RequiredWindow {
  status: 'incomplete' | 'observed';
  authority: string;
  startAuthority: string;
  endAuthority: string;
  reason: string;
  diagnostics: string[];
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  queueRoundIndex: number | null;
  workflowRunId: number | null;
  workflowHeadSha: string | null;
  workflowRunIds?: number[];
  priorQueueRoundCount?: number;
  contexts: Array<{
    context: string;
    jobId: number;
    workflowRunId: number;
    workflowHeadSha: string;
    startedAt: string | null;
    completedAt: string;
    conclusion: string;
  }>;
}
export function readDevChannelContract(root?: string): DevChannelContract;
export function isAdmittedDevBranch(
  branch: string,
  contract?: DevChannelContract,
): boolean;
export function resolveDevBranch(options?: DevBranchOptions): string;
export function devMergeBaseCandidates(options?: DevBranchOptions): string[];
export function findOperationalExactBindings(
  root?: string,
): Array<{ path: string; branch: string }>;
export function checkDevChannelAuthority(root?: string): {
  schema: 'kungfu.dev-channel-authority-check/v1';
  verdict: 'fail' | 'pass';
  issues: string[];
  rulesetId: number | null;
  rulesetName: string | null;
  target: Readonly<Record<string, unknown>> | null;
};
export function measureCandidateStageSync<T>(
  id: string,
  phase: string,
  callback: () => T,
  options?: StageOptions,
): T;
export function measureCandidateStage<T>(
  id: string,
  phase: string,
  callback: () => T | PromiseLike<T>,
  options?: StageOptions,
): Promise<T>;
export function requiredMergeQueueWindow(
  requiredContexts: string[] | null | undefined,
  mergeQueue: MergeQueueEvidence | null | undefined,
): RequiredWindow;
export function latestMergedPulls<T extends MergedPull>(
  pulls: T[],
  limit: number,
): T[];
export function collectLatestMergedPullWindow<T extends MergedPull>(
  fetchPage: (page: number, pageSize: number) => Promise<T[]>,
  limit: number,
  pageSize?: number,
): Promise<{ pulls: T[]; merged: T[] }>;
export function selectLatencyCohort<
  T extends LatencyRecord,
  U extends LatencyRecord,
>(
  records: T[],
  mergeQueueRecords: U[],
  cohortStart?: string | null,
): {
  records: Array<T & { excluded?: boolean; exclusionReason?: string }>;
  mergeQueueRecords: U[];
  collection: { cohortStart: string | null; cohortStartAuthority: string };
};
export function parseDevRequiredLatencyArgs(argv: string[]): {
  repository: string;
  branch: string;
  limit: number;
  output: string;
  pulls: number[];
  timelineOutput: string;
  latencyOnly: boolean;
  cohortStart: string;
};
export function latencyOnlyEvidence(
  classification: { kind: string },
  workflowRunId?: number | null,
): {
  cache: {
    outcome: 'not-applicable' | 'unknown';
    authority: 'source-planner' | 'latency-only';
    reason?: string;
    warm: false;
    cold: false;
    layers: never[];
    compilerStats: null;
    workflowRunId?: number | null;
  };
  native: {
    outcome: 'not-applicable' | 'unknown';
    authority: 'source-planner' | 'latency-only';
    reason?: string;
    steps: never[];
    candidateEvents: never[];
    workflowRunId?: number | null;
  };
};
