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
  initiativeId?: string;
};

export type AgentConsoleEnvelope = {
  schema: 'kungfu.agent-console-envelope/v1';
  workspaceId: string;
  consoleId: string;
  attemptId: string;
  runtimeProfileId: string;
  provider: string;
  activeProfiles: Array<{ id: string; root: string }>;
  workRef: WorkRef | null;
  entrypoints: {
    context: string[];
    capabilities: string[];
    profiles: string[];
    bindWork: string[];
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

export function canonicalAgentSessionJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalAgentSessionJson).join(',')}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, child]) =>
        `${JSON.stringify(key)}:${canonicalAgentSessionJson(child)}`,
    )
    .join(',')}}`;
}

export async function agentSessionSemanticRoot(
  value: unknown,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalAgentSessionJson(value));
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
  initiativeId?: string;
}): Promise<WorkRef> {
  if (input.entityType === 'assignment' && !input.initiativeId) {
    throw new Error('Assignment WorkRef requires initiativeId');
  }
  if (input.entityType !== 'assignment' && input.initiativeId) {
    throw new Error('WorkRef initiativeId is only valid for assignments');
  }
  return {
    schema: 'kungfu.work-ref/v1',
    workspaceId: input.workspaceId,
    profileId: input.profileId,
    profileRoot: input.profileRoot,
    entityType: input.entityType,
    entityId: input.entityId,
    entityRoot: await agentSessionSemanticRoot(input.entity),
    purpose: input.purpose,
    systemTimeCut: input.systemTimeCut,
    ...(input.initiativeId ? { initiativeId: input.initiativeId } : {}),
  };
}

export async function buildAgentConsoleEnvelope(input: {
  workspaceId: string;
  consoleId: string;
  attemptId: string;
  runtimeProfile: AgentRuntimeProfile;
  workRef?: WorkRef | null;
  activeProfiles?: Array<{ id: string; root: string }>;
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
    entrypoints: {
      context: ['kungfu', 'agent', 'context', '--json'],
      capabilities: ['kungfu', 'agent', 'capabilities', '--json'],
      profiles: ['kungfu', 'profile', 'manager', '--json'],
      bindWork: [
        'kungfu',
        'agent',
        'console',
        'bind-work',
        '--initiative-id',
        '<id>',
        '--assignment-id',
        '<id>',
        '--json',
      ],
    },
    knownLimits: [
      'The Console does not acquire authority over an external work source.',
      'Transcript and process exit are observations, not completion proof.',
      'Use public Profile plans, authorizations, actions, and receipts for mutations.',
    ],
  };
  return { ...body, envelopeRoot: await agentSessionSemanticRoot(body) };
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
  controlRuntimeDir?: string;
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
      ...(input.controlRuntimeDir
        ? {
            KUNGFU_CONTROL_RUNTIME_DIR: input.controlRuntimeDir,
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
