// Read-only Project Cut / Work loop capability over the public `kungfu work`
// CLI. Hosts inject process execution; this adapter owns no runtime, Git, or
// settlement authority and only exposes the three admitted read operations.

export type WorkLoopAvailability =
  | 'available'
  | 'degraded'
  | 'plan-only'
  | 'unavailable';

export type WorkLoopOperation = {
  id: string;
  availability: WorkLoopAvailability;
  command: string | null;
  resultSchema: string | null;
  authority: string;
  reason?: string;
};

export type WorkLoopCapabilities = {
  schema: 'kungfu.work-loop-capabilities/v1';
  mentalModel: string[];
  operations: WorkLoopOperation[];
  surfaces: Record<
    'cli' | 'agent' | 'gui' | 'tui',
    {
      availability: WorkLoopAvailability;
      entrypoint?: string;
      projection?: string;
      reason?: string;
    }
  >;
  domainProfile: {
    availability: WorkLoopAvailability;
    reason?: string;
  };
  authority: {
    projection: 'non-authoritative';
    writesRequireDeclaredOperation: boolean;
    settlementRequiresIndependentReview: boolean;
  };
};

export type WorkLoopInspection = {
  schema: 'kungfu.work.inspect/v1';
  status: string;
  confidence: string;
  cut: Record<string, unknown> | null;
  cutStatus: string;
  work: Record<string, unknown> | null;
  openWork: Array<Record<string, unknown>>;
  gaps: string[];
  nextActions: string[];
  authority: Record<string, unknown>;
};

export type WorkLoopRecoveryPlan = {
  schema: 'kungfu.work.recovery-plan/v1';
  status: 'plan';
  code: string;
  workId: string | null;
  action: string;
  gaps: string[];
  writeOccurred: false;
};

export type WorkLoop = {
  runtimeDir: string;
  repoRoot: string;
  capabilities: () => Promise<WorkLoopCapabilities>;
  inspect: (repoRoot?: string) => Promise<WorkLoopInspection>;
  recover: (repoRoot?: string) => Promise<WorkLoopRecoveryPlan>;
};

export type WorkLoopExecFile = (
  file: string,
  args: string[],
  options: {
    encoding: 'utf8';
    env: Record<string, string | undefined>;
    maxBuffer: number;
  },
) => Promise<string>;

export type OpenWorkLoopOptions = {
  runtimeDir: string;
  repoRoot: string;
  execFile: WorkLoopExecFile;
  env?: Record<string, string | undefined>;
  bin?: string;
};

export function openWorkLoop(options: OpenWorkLoopOptions): WorkLoop {
  const env: Record<string, string | undefined> = {
    ...(options.env ?? {}),
    KF_RUNTIME_DIR: options.runtimeDir,
  };
  const bin = options.bin || env.KUNGFU_CLI_BIN || env.KUNGFU_BIN || 'kungfu';
  const run = async <T>(args: string[]): Promise<T> => {
    const text = await options.execFile(bin, ['work', ...args, '--json'], {
      encoding: 'utf8',
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(text) as T;
  };
  const repoArgs = (repoRoot?: string) => {
    const selected = repoRoot || options.repoRoot;
    if (!selected.trim()) {
      throw new Error('project workspace root is unavailable');
    }
    return ['--repo', selected];
  };
  return {
    runtimeDir: options.runtimeDir,
    repoRoot: options.repoRoot,
    capabilities: () => run<WorkLoopCapabilities>(['capabilities']),
    inspect: async (repoRoot) =>
      await run<WorkLoopInspection>(['inspect', ...repoArgs(repoRoot)]),
    recover: async (repoRoot) =>
      await run<WorkLoopRecoveryPlan>(['recover', ...repoArgs(repoRoot)]),
  };
}
