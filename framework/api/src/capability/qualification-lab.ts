// SPDX-License-Identifier: Apache-2.0

// Shared adapter over the Core Agent Qualification Lab. Hosts inject process
// execution; GUI and TUI receive the same startup route, plans, receipts,
// assessments and reports and own no private semantic state.
import type { AgentRuntimeCatalog } from './agent-runtime.js';

export type QualificationLabStartupRoute = {
  schema: 'kungfu.qualification-lab.startup-route/v1';
  state: 'verified-empty' | 'existing-work' | 'diagnostic';
  route: 'qualification-lab' | 'work-graph' | 'diagnostic';
  reasonCode: string;
  message: string;
  runtimeDir: string;
  workGraphPresent: boolean | null;
  evidence: string[];
  writeOccurred: false;
};

export type QualificationLabCatalog = {
  schema: 'kungfu.qualification-lab.catalog/v1';
  startup: QualificationLabStartupRoute;
  suite: {
    id: string;
    fixture: string;
    oracle: string;
    claims: string[];
    nonClaims: string[];
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

export type QualificationLabEvent = {
  schema: 'kungfu.qualification-lab.event/v1';
  step: string;
  status: string;
  root: string;
};

export type QualificationLabReport = {
  schema:
    | 'kungfu.qualification-lab.report/v1'
    | 'kungfu.qualification-lab.agent-report/v1';
  status: 'qualified' | 'qualified-with-residuals' | 'failed';
  suite: string;
  fixture: string;
  planRoot: string;
  reportRoot: string;
  identityRoot: string;
  workRef: Record<string, unknown>;
  sessionAttempts: Array<Record<string, unknown>>;
  assessment: Record<string, unknown>;
  events: QualificationLabEvent[];
  meaning: string;
  nonClaims: string[];
  evidenceDirectory: string;
  writeOccurred: true;
};

export type QualificationLabAgentPlan = {
  schema: 'kungfu.qualification-lab.agent-plan/v1';
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

export type QualificationLab = {
  inspect: () => Promise<QualificationLabStartupRoute>;
  inspectSync: () => QualificationLabStartupRoute;
  catalog: () => Promise<QualificationLabCatalog>;
  catalogSync: () => QualificationLabCatalog;
  discoverAgents: () => Promise<AgentRuntimeCatalog>;
  runDemo: (
    onEvent?: (event: QualificationLabEvent) => void,
  ) => Promise<QualificationLabReport>;
  planAgent: (profileId: string) => Promise<QualificationLabAgentPlan>;
  runAgent: (
    profileId: string,
    onEvent?: (event: QualificationLabEvent) => void,
  ) => Promise<QualificationLabReport>;
  runMigration: (
    sourceProfileId: string,
    targetProfileId: string,
    onEvent?: (event: QualificationLabEvent) => void,
  ) => Promise<QualificationLabReport>;
};

type ExecOptions = {
  encoding: 'utf8';
  env: Record<string, string | undefined>;
  maxBuffer: number;
};

export type QualificationLabExecFile = (
  file: string,
  args: string[],
  options: ExecOptions,
) => Promise<string>;

export type QualificationLabExecFileSync = (
  file: string,
  args: string[],
  options: ExecOptions,
) => string;

export type QualificationLabExecFileEvents = (
  file: string,
  args: string[],
  options: ExecOptions,
  onLine: (line: string) => void,
) => Promise<void>;

export type OpenQualificationLabOptions = {
  runtimeDir: string;
  execFile: QualificationLabExecFile;
  execFileSync: QualificationLabExecFileSync;
  execFileEvents?: QualificationLabExecFileEvents;
  env?: Record<string, string | undefined>;
  bin?: string;
};

export function openQualificationLab(
  options: OpenQualificationLabOptions,
): QualificationLab {
  const env: Record<string, string | undefined> = {
    ...(options.env ?? {}),
    KF_RUNTIME_DIR: options.runtimeDir,
  };
  const bin = options.bin || env.KUNGFU_CLI_BIN || env.KUNGFU_BIN || 'kungfu';
  const args = (command: string, extra: string[] = []) => [
    'qualification-lab',
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
    onEvent?: (event: QualificationLabEvent) => void,
  ): Promise<QualificationLabReport> => {
    if (!onEvent) {
      return run<QualificationLabReport>(command, extra);
    }
    if (!options.execFileEvents) {
      const report = await run<QualificationLabReport>(command, extra);
      report.events.forEach(onEvent);
      return report;
    }
    let report: QualificationLabReport | null = null;
    await options.execFileEvents(
      bin,
      args(command, [...extra, '--events-json']),
      {
        encoding: 'utf8',
        env,
        maxBuffer: 64 * 1024 * 1024,
      },
      (line) => {
        const payload = parse<QualificationLabEvent | QualificationLabReport>(
          line,
        );
        if (payload.schema === 'kungfu.qualification-lab.event/v1') {
          onEvent(payload);
        } else {
          report = payload;
        }
      },
    );
    if (!report) {
      throw new Error(
        'qualification event stream ended without a canonical report',
      );
    }
    return report;
  };
  return {
    inspect: () => run<QualificationLabStartupRoute>('inspect'),
    inspectSync: () => runSync<QualificationLabStartupRoute>('inspect'),
    catalog: () => run<QualificationLabCatalog>('catalog'),
    catalogSync: () => runSync<QualificationLabCatalog>('catalog'),
    discoverAgents: () => run<AgentRuntimeCatalog>('agents'),
    runDemo: (onEvent) => runWithEvents('demo', [], onEvent),
    planAgent: (profileId) =>
      run<QualificationLabAgentPlan>('agent-plan', [profileId]),
    runAgent: (profileId, onEvent) =>
      runWithEvents('agent-run', [profileId, '--execute'], onEvent),
    runMigration: (sourceProfileId, targetProfileId, onEvent) =>
      runWithEvents(
        'agent-run',
        [sourceProfileId, '--execute', '--target-profile', targetProfileId],
        onEvent,
      ),
  };
}
