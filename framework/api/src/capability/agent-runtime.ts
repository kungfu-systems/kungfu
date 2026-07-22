// Machine-global Agent Runtime Profile handle. The Python CLI owns discovery,
// config validation and mutation; this adapter gives GUI and KFX the same JSON
// plans/receipts without creating a renderer-private configuration path.

export type AgentProvider = 'codex' | 'claude';
export type AgentBackend = 'tmux' | 'direct';

export type AgentRuntimeProfile = {
  schema: 'kungfu.agent-runtime-profile/v1';
  id: string;
  label: string;
  provider: AgentProvider;
  launch: { executable: string; argv: string[]; shellMode: boolean };
  cwdPolicy: 'workspace-root' | 'home' | 'inherit';
  backendDefault: AgentBackend;
  bootstrap: {
    adapter: AgentProvider;
    envelope: 'required' | 'disabled';
  };
  source: 'discovered' | 'user';
  lastVerified?: string | null;
};

export type AgentRuntimeCatalog = {
  schema: 'kungfu.agent-runtime-catalog/v1';
  configPath: string;
  configured: AgentRuntimeProfile[];
  discovered: Array<{
    profile: AgentRuntimeProfile;
    pathClass: string;
    version: string | null;
    available: boolean;
    candidatesChecked: string[];
  }>;
  defaultProfileId: string | null;
  recommendedProfileId: string | null;
  backendDefault: AgentBackend;
  startupView: 'profile-home' | 'agent-console';
  diagnostics: Array<{
    provider: AgentProvider;
    available: boolean;
    message: string;
  }>;
  privacyBoundary: string[];
};

export type AgentRuntimeProfileInput = {
  id: string;
  label: string;
  provider: AgentProvider;
  executable: string;
  argv?: string[];
  shellMode?: boolean;
  cwdPolicy?: 'workspace-root' | 'home' | 'inherit';
  backend?: AgentBackend;
  envelope?: 'required' | 'disabled';
};

export type AgentRuntimeVerification = {
  schema: 'kungfu.agent-runtime-verification/v1';
  profileId: string;
  provider: AgentProvider;
  executable: string;
  argv: ['--version'];
  available: boolean;
  version: string | null;
  ok: boolean;
  error: string | null;
  observedAt: string;
  privacyBoundary: string;
};

export type AgentRuntime = {
  discover: () => Promise<AgentRuntimeCatalog>;
  list: () => Promise<AgentRuntimeCatalog>;
  upsert: (
    input: AgentRuntimeProfileInput,
    execute?: boolean,
  ) => Promise<Record<string, unknown>>;
  remove: (
    profileId: string,
    execute?: boolean,
  ) => Promise<Record<string, unknown>>;
  setDefault: (
    profileId: string,
    execute?: boolean,
  ) => Promise<Record<string, unknown>>;
  verify: (profileId: string) => Promise<AgentRuntimeVerification>;
};

export type AgentRuntimeExecFile = (
  file: string,
  args: string[],
  options: {
    encoding: 'utf8';
    env: Record<string, string | undefined>;
    maxBuffer?: number;
  },
) => Promise<string>;

export type OpenAgentRuntimeOptions = {
  execFile: AgentRuntimeExecFile;
  env?: Record<string, string | undefined>;
  bin?: string;
};

export function openAgentRuntime(
  options: OpenAgentRuntimeOptions,
): AgentRuntime {
  const env = { ...(options.env ?? {}) };
  const bin = options.bin || env.KUNGFU_CLI_BIN || env.KUNGFU_BIN || 'kungfu';
  const run = async <T>(args: string[]): Promise<T> => {
    const text = await options.execFile(
      bin,
      ['agent', 'runtime', ...args, '--json'],
      { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 },
    );
    return JSON.parse(text) as T;
  };
  const execute = (enabled: boolean | undefined) =>
    enabled ? ['--execute'] : [];
  return {
    discover: () => run<AgentRuntimeCatalog>(['discover']),
    list: () => run<AgentRuntimeCatalog>(['list']),
    upsert: (input, shouldExecute = false) =>
      run<Record<string, unknown>>([
        'upsert',
        '--id',
        input.id,
        '--label',
        input.label,
        '--provider',
        input.provider,
        '--executable',
        input.executable,
        ...(input.argv ?? []).flatMap((arg) => ['--arg', arg]),
        ...(input.shellMode ? ['--shell-mode'] : []),
        '--cwd-policy',
        input.cwdPolicy ?? 'workspace-root',
        '--backend',
        input.backend ?? 'tmux',
        '--envelope',
        input.envelope ?? 'required',
        ...execute(shouldExecute),
      ]),
    remove: (profileId, shouldExecute = false) =>
      run<Record<string, unknown>>([
        'remove',
        profileId,
        ...execute(shouldExecute),
      ]),
    setDefault: (profileId, shouldExecute = false) =>
      run<Record<string, unknown>>([
        'set-default',
        profileId,
        ...execute(shouldExecute),
      ]),
    verify: (profileId) => run<AgentRuntimeVerification>(['verify', profileId]),
  };
}
