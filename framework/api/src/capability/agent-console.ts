import type { AgentBackend, AgentRuntimeProfile } from './agent-runtime.js';

export type WorkRef = {
  schema: 'kungfu.work-ref/v1';
  workspaceId: string;
  profileId: string;
  profileRoot: string;
  entityType: string;
  entityId: string;
  entityRoot: string;
  purpose: string;
  systemTimeCut: string;
};

export type AgentConsoleEnvelope = {
  schema: 'kungfu.agent-console-envelope/v1';
  workspaceId: string;
  consoleId: string;
  attemptId: string;
  runtimeProfileId: string;
  provider: 'codex' | 'claude';
  activeProfiles: Array<{ id: string; root: string }>;
  workRef: WorkRef | null;
  runtimeRouting: {
    controlRuntimeDir: string;
    workRuntimeDir: null;
    workRuntimeResolution: 'agent-project-cut';
  };
  entrypoints: {
    context: string[];
    capabilities: string[];
    profiles: string[];
  };
  knownLimits: string[];
  envelopeRoot: string;
};

export type AgentConsoleLaunch = {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  backend: AgentBackend;
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

export async function buildWorkRef(input: {
  workspaceId: string;
  profileId: string;
  profileRoot: string;
  entityType: string;
  entityId: string;
  entity: unknown;
  purpose: string;
  systemTimeCut: string;
}): Promise<WorkRef> {
  return {
    schema: 'kungfu.work-ref/v1',
    workspaceId: input.workspaceId,
    profileId: input.profileId,
    profileRoot: input.profileRoot,
    entityType: input.entityType,
    entityId: input.entityId,
    entityRoot: await sha256(input.entity),
    purpose: input.purpose,
    systemTimeCut: input.systemTimeCut,
  };
}

export async function buildAgentConsoleEnvelope(input: {
  workspaceId: string;
  consoleId: string;
  attemptId: string;
  runtimeProfile: AgentRuntimeProfile;
  workRef?: WorkRef | null;
  activeProfiles?: Array<{ id: string; root: string }>;
  controlRuntimeDir?: string;
}): Promise<AgentConsoleEnvelope> {
  const body = {
    schema: 'kungfu.agent-console-envelope/v1' as const,
    workspaceId: input.workspaceId,
    consoleId: input.consoleId,
    attemptId: input.attemptId,
    runtimeProfileId: input.runtimeProfile.id,
    provider: input.runtimeProfile.provider,
    activeProfiles: input.activeProfiles ?? [],
    workRef: input.workRef ?? null,
    runtimeRouting: {
      controlRuntimeDir: input.controlRuntimeDir ?? '',
      workRuntimeDir: null,
      workRuntimeResolution: 'agent-project-cut' as const,
    },
    entrypoints: {
      context: ['kungfu agent context --json'],
      capabilities: [
        'kungfu agent capabilities --json',
        'kungfu agent runtime list --json',
        'kungfu agent session capabilities --json',
      ],
      profiles: ['kungfu profile manager --json'],
    },
    knownLimits: [
      'The Console does not acquire authority over an external work source.',
      'Transcript and process exit are observations, not completion proof.',
      'Use public Profile plans, authorizations, actions, and receipts for mutations.',
    ],
  };
  return { ...body, envelopeRoot: await sha256(body) };
}

const bootstrapPrompt = [
  'You are running inside Kungfu Agent Console.',
  'Read the JSON envelope in KUNGFU_AGENT_CONSOLE_ENVELOPE.',
  'Before describing what you can do in Kungfu, query its context, capabilities, and Profile manager entrypoints from that envelope.',
  'Use the public KFD-3/Profile action interface for mutations and preserve receipts as proof.',
  'If workRef is present, keep this conversation bound to that work and purpose.',
  'A transcript or successful process exit is not completion proof.',
].join(' ');

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function prepareAgentConsoleLaunch(input: {
  profile: AgentRuntimeProfile;
  envelope: AgentConsoleEnvelope;
  workspaceRoot?: string;
  home?: string;
}): AgentConsoleLaunch {
  const profile = input.profile;
  const launchArgs = [...profile.launch.argv, bootstrapPrompt];
  let command = profile.launch.executable;
  let args = launchArgs;
  if (profile.launch.shellMode) {
    command = '/bin/zsh';
    args = [
      '-lc',
      `exec ${[profile.launch.executable, ...launchArgs]
        .map(shellQuote)
        .join(' ')}`,
    ];
  }
  const cwd =
    profile.cwdPolicy === 'workspace-root'
      ? input.workspaceRoot
      : profile.cwdPolicy === 'home'
        ? input.home
        : undefined;
  return {
    command,
    args,
    cwd,
    backend: profile.backendDefault,
    env: {
      KUNGFU_AGENT_CONSOLE_ENVELOPE: JSON.stringify(input.envelope),
      KUNGFU_AGENT_CONSOLE_ID: input.envelope.consoleId,
      KUNGFU_AGENT_ATTEMPT_ID: input.envelope.attemptId,
      ...(input.envelope.runtimeRouting.controlRuntimeDir
        ? {
            KUNGFU_CONTROL_RUNTIME_DIR:
              input.envelope.runtimeRouting.controlRuntimeDir,
          }
        : {}),
      ...(input.workspaceRoot
        ? { KUNGFU_WORKSPACE_ROOT: input.workspaceRoot }
        : {}),
      ...(input.envelope.workRef
        ? { KUNGFU_WORK_REF: JSON.stringify(input.envelope.workRef) }
        : {}),
    },
  };
}
