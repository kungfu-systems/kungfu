// SPDX-License-Identifier: Apache-2.0

// Shared adapter over the Core Agent Work Lab. Hosts inject process
// execution; GUI and TUI receive the same startup route, plans, receipts,
// assessments and reports and own no private semantic state.
import type { AgentRuntimeCatalog } from './agent-runtime.js';

export type AgentWorkLabStartupRoute = {
  schema: 'kungfu.agent-work-lab.startup-route/v1';
  state: 'verified-empty' | 'existing-work' | 'diagnostic';
  route: 'agent-work-lab' | 'work-graph' | 'diagnostic';
  reasonCode: string;
  message: string;
  runtimeDir: string;
  workGraphPresent: boolean | null;
  evidence: string[];
  writeOccurred: false;
};

export type AgentWorkLabStartupSurface = 'work-graph' | 'agent-work-lab';

export function agentWorkLabStartupSurface(
  startup: AgentWorkLabStartupRoute,
): AgentWorkLabStartupSurface {
  return startup.state === 'existing-work' &&
    startup.route === 'work-graph' &&
    startup.workGraphPresent === true
    ? 'work-graph'
    : 'agent-work-lab';
}

export function agentWorkLabRunProgressLabel({
  elapsedMs,
  quietMs,
  eventCount,
  phase = 'running',
}: {
  elapsedMs: number;
  quietMs: number;
  eventCount: number;
  phase?: 'running' | 'assessing';
}): string {
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const quietSeconds = Math.max(0, Math.floor(quietMs / 1000));
  if (phase === 'assessing') {
    return `Canonical run complete · emphasizing verdicts · ${eventCount} admitted events shown`;
  }
  if (eventCount === 0) {
    return `Still running · ${elapsedSeconds}s elapsed · waiting for first admitted event`;
  }
  return `Still running · ${elapsedSeconds}s elapsed · ${eventCount} admitted events shown · last update ${quietSeconds}s ago`;
}

export type AgentWorkLabCatalog = {
  schema: 'kungfu.agent-work-lab.catalog/v1';
  startup: AgentWorkLabStartupRoute;
  suite: {
    schema: 'kungfu.agent-work-lab.suite-catalog/v1';
    id: 'kungfu.agent-work-lab';
    version: string;
    title: string;
    collection: {
      id: 'work-continuity';
      title: string;
      description: string;
    };
    cases: Array<{
      id: 'offline-demo' | 'same-agent' | 'cross-agent';
      title: string;
      shortTitle: string;
      description: string;
      sourceRequirement: 'bundled' | 'configured';
      targetRequirement: 'fresh-demo' | 'same' | 'different';
      runLabel: string;
    }>;
    checks: Record<string, { title: string; meaning: string }>;
    recommendations: Record<
      'offline-demo' | 'same-agent' | 'cross-agent',
      {
        title: string;
        instruction: string;
        nextCase?: 'offline-demo' | 'same-agent' | 'cross-agent';
      }
    >;
    recoveryGuidance: Record<
      'agent-unavailable' | 'run-failed' | 'existing-work' | 'demo-retry',
      string
    >;
    timing: {
      autoplayIntroDurationMs: number;
      eventIntervalMs: number;
      verdictIntervalMs: number;
      recommendationDurationMs: number;
      quietProgressIntervalMs: number;
      reducedMotionIntervalMs: number;
    };
    capabilityDeclarations: ['agentRuntime', 'work'];
    claims: string[];
    nonClaims: string[];
    fixture: string;
    oracle: string;
    catalogRoot: string;
    catalogPath: string;
  };
  actions: Array<{
    id: string;
    mutation: string;
    resultSchema: string;
  }>;
  authority: {
    startup: string;
    actions: string;
    surfaces: ['cli', 'gui', 'tui'];
    uiPrivateWrites: false;
  };
};

export type AgentWorkLabEvent = {
  schema: 'kungfu.agent-work-lab.event/v1';
  step: string;
  status: string;
  root: string;
  publicActivity?: {
    schema: 'kungfu.agent-work-lab.public-activity/v1';
    source: 'provider-jsonl';
    kind: 'agent' | 'tool';
    phase: 'progress' | 'started' | 'completed';
    text: string;
    rawOutputRedacted: true;
  };
  publicOutput?: {
    schema: 'kungfu.agent-work-lab.public-output/v1';
    source: 'provider-stdout';
    admission: 'exact-agent-work-lab-marker';
    lines: string[];
    rawOutputRedacted: true;
  };
};

export type AgentWorkLabReport = {
  schema:
    | 'kungfu.agent-work-lab.report/v1'
    | 'kungfu.agent-work-lab.agent-report/v1';
  status: 'qualified' | 'qualified-with-residuals' | 'failed';
  suite: string;
  fixture: string;
  planRoot: string;
  reportRoot: string;
  identityRoot: string;
  workRef: Record<string, unknown>;
  sessionAttempts: Array<Record<string, unknown>>;
  assessment: Record<string, unknown>;
  events: AgentWorkLabEvent[];
  meaning: string;
  nonClaims: string[];
  receiptDependencies: string[];
  recoveryGuidance: Record<string, string>;
  evidenceDirectory: string;
  writeOccurred: true;
};

export type AgentWorkLabAgentPlan = {
  schema: 'kungfu.agent-work-lab.agent-plan/v1';
  suite: string;
  fixture: string;
  identity: Record<string, unknown>;
  identityRoot: string;
  planRoot: string;
  commandPreview: string[];
  verification: Record<string, unknown>;
  credentialContentsRead: false;
  writeOccurred: false;
};

export type ProjectTemplatePlan = {
  schema: 'kungfu.project-template.plan/v1';
  templateId: string;
  templateVersion: string;
  templateRoot: string;
  templateSource: string;
  destination: string;
  files: Array<{ path: string; contentRoot: string }>;
  initialWork: {
    state: 'capture-pending';
    initiativeId: string;
    assignmentId: string;
    title: string;
    acceptanceChecks: string[];
  };
  effects: string[];
  skippedEffects: string[];
  confirmationRequired: true;
  writeOccurred: false;
  planRoot: string;
};

export type ProjectTemplateCreationReceipt = {
  schema: 'kungfu.project-template.creation-receipt/v1';
  status: 'created';
  templateId: string;
  templateRoot: string;
  planRoot: string;
  destination: string;
  actor: string;
  files: Array<{ path: string; contentRoot: string }>;
  verification: {
    ok: boolean;
    checks: Array<{
      path: string;
      expectedRoot: string;
      observedRoot: string | null;
      passed: boolean;
    }>;
  };
  initialWork: {
    state: 'captured-pending-admission';
    initiativeId: string;
    assignmentId: string;
    requestRoot: string;
    receiptRoot: string;
    requestPath: string;
  };
  openAction: {
    kind: 'select-project-workspace';
    label: string;
  };
  nonClaims: string[];
  writeOccurred: true;
  receiptRoot: string;
};

export type AgentWorkLab = {
  inspect: () => Promise<AgentWorkLabStartupRoute>;
  inspectSync: () => AgentWorkLabStartupRoute;
  catalog: () => Promise<AgentWorkLabCatalog>;
  catalogSync: () => AgentWorkLabCatalog;
  discoverAgents: () => Promise<AgentRuntimeCatalog>;
  runDemo: (
    onEvent?: (event: AgentWorkLabEvent) => void,
  ) => Promise<AgentWorkLabReport>;
  planAgent: (profileId: string) => Promise<AgentWorkLabAgentPlan>;
  runAgent: (
    profileId: string,
    onEvent?: (event: AgentWorkLabEvent) => void,
  ) => Promise<AgentWorkLabReport>;
  runMigration: (
    sourceProfileId: string,
    targetProfileId: string,
    onEvent?: (event: AgentWorkLabEvent) => void,
  ) => Promise<AgentWorkLabReport>;
  planStarterProject: (destination?: string) => Promise<ProjectTemplatePlan>;
  createStarterProject: (
    plan: ProjectTemplatePlan,
    actor: string,
  ) => Promise<ProjectTemplateCreationReceipt>;
};

type ExecOptions = {
  encoding: 'utf8';
  env: Record<string, string | undefined>;
  maxBuffer: number;
};

export type AgentWorkLabExecFile = (
  file: string,
  args: string[],
  options: ExecOptions,
) => Promise<string>;

export type AgentWorkLabExecFileSync = (
  file: string,
  args: string[],
  options: ExecOptions,
) => string;

export type AgentWorkLabExecFileEvents = (
  file: string,
  args: string[],
  options: ExecOptions,
  onLine: (line: string) => void,
) => Promise<void>;

export type OpenAgentWorkLabOptions = {
  runtimeDir: string;
  execFile: AgentWorkLabExecFile;
  execFileSync: AgentWorkLabExecFileSync;
  execFileEvents?: AgentWorkLabExecFileEvents;
  env?: Record<string, string | undefined>;
  bin?: string;
};

export function openAgentWorkLab(
  options: OpenAgentWorkLabOptions,
): AgentWorkLab {
  const env: Record<string, string | undefined> = {
    ...(options.env ?? {}),
    KF_RUNTIME_DIR: options.runtimeDir,
  };
  const bin = options.bin || env.KUNGFU_CLI_BIN || env.KUNGFU_BIN || 'kungfu';
  const args = (command: string, extra: string[] = []) => [
    'agent-work-lab',
    command,
    ...extra,
    '--json',
  ];
  const parse = <T>(text: string): T => JSON.parse(text) as T;
  const run = async <T>(command: string, extra: string[] = []): Promise<T> =>
    parse<T>(
      await options.execFile(bin, args(command, extra), {
        encoding: 'utf8',
        env,
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  const runSync = <T>(command: string): T =>
    parse<T>(
      options.execFileSync(bin, args(command), {
        encoding: 'utf8',
        env,
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  const runWithEvents = async (
    command: string,
    extra: string[],
    onEvent?: (event: AgentWorkLabEvent) => void,
  ): Promise<AgentWorkLabReport> => {
    if (!onEvent) {
      return run<AgentWorkLabReport>(command, extra);
    }
    if (!options.execFileEvents) {
      const report = await run<AgentWorkLabReport>(command, extra);
      report.events.forEach(onEvent);
      return report;
    }
    let report: AgentWorkLabReport | null = null;
    await options.execFileEvents(
      bin,
      args(command, [...extra, '--events-json']),
      {
        encoding: 'utf8',
        env,
        maxBuffer: 64 * 1024 * 1024,
      },
      (line) => {
        const payload = parse<AgentWorkLabEvent | AgentWorkLabReport>(line);
        if (payload.schema === 'kungfu.agent-work-lab.event/v1') {
          onEvent(payload);
        } else {
          report = payload;
        }
      },
    );
    if (!report) {
      throw new Error(
        'Agent Work Lab event stream ended without a canonical report',
      );
    }
    return report;
  };
  return {
    inspect: () => run<AgentWorkLabStartupRoute>('inspect'),
    inspectSync: () => runSync<AgentWorkLabStartupRoute>('inspect'),
    catalog: () => run<AgentWorkLabCatalog>('catalog'),
    catalogSync: () => runSync<AgentWorkLabCatalog>('catalog'),
    discoverAgents: () => run<AgentRuntimeCatalog>('agents'),
    runDemo: (onEvent) => runWithEvents('demo', [], onEvent),
    planAgent: (profileId) =>
      run<AgentWorkLabAgentPlan>('agent-plan', [profileId]),
    runAgent: (profileId, onEvent) =>
      runWithEvents('agent-run', [profileId, '--execute'], onEvent),
    runMigration: (sourceProfileId, targetProfileId, onEvent) =>
      runWithEvents(
        'agent-run',
        [sourceProfileId, '--execute', '--target-profile', targetProfileId],
        onEvent,
      ),
    planStarterProject: (destination) =>
      run<ProjectTemplatePlan>(
        'starter-plan',
        destination ? ['--destination', destination] : [],
      ),
    createStarterProject: (plan, actor) =>
      run<ProjectTemplateCreationReceipt>('starter-create', [
        '--destination',
        plan.destination,
        '--expected-plan-root',
        plan.planRoot,
        '--actor',
        actor,
        '--execute',
      ]),
  };
}
