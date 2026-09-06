// SPDX-License-Identifier: Apache-2.0
// Public checkout tooling contract. Versioned evidence bodies remain opaque.
export interface QualifiedCoreCheckout {
  repository: string;
  commit: string;
  tree: string;
  clean: boolean;
}
export interface HostOptions {
  platform?: string;
  architecture?: string;
}
export interface Transport {
  provider: string;
  artifactId?: number;
  artifactName?: string;
  runId?: number;
  workflowPath?: string;
  event?: string;
  protectedRef?: string;
  headSha?: string;
  platformRow?: string;
}
export interface DiscoveredBundle {
  bundleRoot: string;
  transport: Transport;
  transferRoot?: string;
  phaseDurations?: { discovery: number; transfer: number };
}
export interface MaterializedBundle extends DiscoveredBundle {
  status: 'materialized' | 'already-materialized';
  objectRoot: string;
  receipt: Readonly<Record<string, unknown>>;
  verified: {
    candidate: Readonly<Record<string, unknown>>;
    qualification: Readonly<Record<string, unknown>>;
    verification: Readonly<Record<string, unknown>>;
    expectation: Readonly<Record<string, unknown>>;
  };
}
export interface UsageStatus {
  schema: 'shifu.qualified-assignment-core-usage-summary/v1';
  ok: boolean;
  authority: 'optimization-evidence-only';
  currentCheckout: {
    repository: string;
    sourceCommit: string;
    platform: string;
    architecture: string;
    pythonAbi: 'cp313';
    eligible: boolean;
  };
  totals: {
    observations: number;
    invalidRecords: number;
    scannedRecords: number;
    scanTruncated: boolean;
  };
  counts: {
    results: Record<string, number>;
    reasons: Record<string, number>;
    platforms: Record<string, number>;
  };
  recent: Array<{
    observationRoot: string;
    recordedAt: string;
    result: string;
    reason: string;
    repository: string;
    sourceCommit: string;
    platform: string;
    architecture: string;
    pythonAbi: string;
    artifactRoot: string | null;
  }>;
}
export interface GithubDownloadOptions {
  repository: string;
  artifactId: number;
  destination: string;
  expectedBytes?: number | null;
  attempts?: number;
  runAttempt?: (
    command: string,
    args: string[],
    destination: string,
    options: { maxBytes: number; reason: string },
  ) => Promise<unknown>;
}
export interface HttpDownloadOptions {
  url: string;
  destination: string;
  expectedBytes: number;
  attempts?: number;
  fetchImpl?: typeof globalThis.fetch;
}
export interface DiscoveryOptions {
  cacheRoot?: string;
  clock?: () => number;
  httpBaseUrl?: string;
  githubJson?: (endpoint: string) => unknown;
  downloadHttp?: typeof downloadHttpArtifact;
  downloadGithub?: typeof downloadGithubArtifact;
  platformRowId?: string;
}
export function resolveShifuCachedTool(
  options: HostOptions & {
    tool: string;
    repositoryRoot?: string;
    env?: Record<string, string | undefined>;
  },
): string;
export function observeQualifiedCoreCheckout(
  repositoryRoot: string,
): QualifiedCoreCheckout;
export function downloadGithubArtifact(
  options: GithubDownloadOptions,
): Promise<string>;
export function downloadHttpArtifact(
  options: HttpDownloadOptions,
): Promise<string>;
export function discoverGithubBundle(
  checkout: QualifiedCoreCheckout,
  temporary: string,
  options?: DiscoveryOptions,
): Promise<DiscoveredBundle>;
export function materializeQualifiedCoreBundle(options: {
  bundleRoot: string;
  repositoryRoot: string;
  publicationRoot?: string;
  checkout: QualifiedCoreCheckout;
  cacheRoot: string;
  now?: string;
  transport?: Transport;
}): Promise<MaterializedBundle>;
export function consumeQualifiedCoreForCheckout(
  options: HostOptions & {
    repositoryRoot: string;
    publicationRoot?: string;
    cacheRoot?: string;
    now?: string;
    checkout?: QualifiedCoreCheckout | null;
    clock?: () => number;
    discoverRemote?: typeof discoverGithubBundle;
  },
): Promise<MaterializedBundle>;
export function qualifiedCoreUsageStatus(
  options: HostOptions & {
    repositoryRoot: string;
    cacheRoot?: string;
  },
): UsageStatus;
export function runQualifiedCoreUsageStatusCommand(
  args: string[],
  options?: { defaultRepositoryRoot?: string },
): UsageStatus;
