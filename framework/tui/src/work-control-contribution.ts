// SPDX-License-Identifier: Apache-2.0

import type { ChildProcessByStdio } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Readable } from 'node:stream';

import type {
  GlobalWorkSnapshot,
  ProductSearchDocument,
  Profile,
} from '@kungfu-tech/api/capability';
import {
  globalWorkSearchDocuments,
  parseGlobalWorkSnapshot,
} from '@kungfu-tech/api/capability';
import type { KfxLoadPlan } from '@kungfu-tech/kfx';

import type { ProfileShellModel } from './profile-shell.js';
import { describeTuiSkillRuntimeAudit } from './skill-runtime-audit.js';

const PROFILE_ID = 'kungfu.work-control';
const MEMBER_ID = 'work-control-actions';

type Initiative = {
  initiative_id?: string;
  subject_key?: string;
  title?: string;
  intent?: string;
  status?: string;
};

type Assignment = {
  assignment_id?: string;
  subject_key?: string;
  initiative_id?: string;
  initiative_subject?: string;
  title?: string;
  objective?: string;
  status?: string;
  phase?: string;
};

type Portfolio = {
  schema: 'kungfu.work-control.portfolio-snapshot/v1';
  cut: { kind: 'system_time'; system_time: string };
  projection_authority: {
    mode: 'read-only';
    writableAuthority: false;
    atomicGlobalCut: false;
    completionAuthority: false;
  };
  initiatives: Initiative[];
  assignments: Assignment[];
};

function initiativeId(row: Initiative): string {
  return row.initiative_id ?? row.subject_key ?? '';
}

function assignmentId(row: Assignment): string {
  return row.assignment_id ?? row.subject_key ?? '';
}

function sameInitiative(row: Assignment, id: string): boolean {
  return (
    row.initiative_id === id ||
    row.initiative_subject === id ||
    row.initiative_subject?.endsWith(`:${id}`) === true
  );
}

function assertSameNonEmptyRoot(label: string, roots: string[]): void {
  if (roots.some((root) => !root)) {
    throw new Error(`${label} is missing from a public Profile receipt`);
  }
  if (new Set(roots).size !== 1) {
    throw new Error(`${label} drifted across public Profile receipts`);
  }
}

export async function loadWorkControlContribution(
  profile: Profile,
  kfxPlan: KfxLoadPlan,
  preferredInitiativeId = '',
): Promise<ProfileShellModel> {
  const discovery = await profile.discoverAsync(PROFILE_ID);
  const [application, kfd3, portfolioReceipt] = await Promise.all([
    profile.applicationAsync(discovery.source),
    profile.kfd3StatusAsync(discovery.source),
    profile.memberCallAsync<Portfolio>(
      discovery.source,
      MEMBER_ID,
      'portfolio',
      {},
    ),
  ]);
  if (!kfd3.qualified || !kfd3.activeExactRoot) {
    throw new Error('Work Control Profile is not KFD-3 exact-root qualified');
  }
  assertSameNonEmptyRoot('Profile Suite root', [
    discovery.profileSuiteRoot,
    application.profileSuiteRoot,
    kfd3.profileSuiteRoot,
    portfolioReceipt.profileSuiteRoot,
  ]);
  assertSameNonEmptyRoot('Work Control member root', [
    discovery.memberRoots[MEMBER_ID] ?? '',
    portfolioReceipt.memberRoot,
  ]);

  const portfolio = portfolioReceipt.result;
  if (
    portfolio.projection_authority.mode !== 'read-only' ||
    portfolio.projection_authority.writableAuthority ||
    portfolio.projection_authority.atomicGlobalCut ||
    portfolio.projection_authority.completionAuthority
  ) {
    throw new Error('Portfolio projection claimed authority it does not own');
  }
  const initiative =
    portfolio.initiatives.find(
      (row) => initiativeId(row) === preferredInitiativeId,
    ) ?? portfolio.initiatives[0];
  const id = initiative ? initiativeId(initiative) : '';
  const assignments = id
    ? portfolio.assignments.filter((row) => sameInitiative(row, id))
    : [];

  return {
    profile: {
      id: PROFILE_ID,
      title: 'Work Control',
      version: 'Profile/KFD-3',
      suiteRoot: application.profileSuiteRoot,
      qualified: true,
    },
    subject: initiative
      ? {
          id,
          title: initiative.title ?? id,
          subtitle: initiative.intent ?? 'Initiative intent is not declared.',
        }
      : {
          id: '',
          title: 'No Initiative selected',
          subtitle: 'No native Initiative facts are visible at this cut.',
        },
    navigation: portfolio.initiatives.map((row) => ({
      id: initiativeId(row),
      label: row.title ?? initiativeId(row),
      status: row.status ?? 'unknown',
    })),
    cards: assignments.map((row) => ({
      id: assignmentId(row),
      title: row.title ?? assignmentId(row),
      status: row.phase ?? row.status ?? 'unknown',
      summary: row.objective ?? 'Assignment objective is not declared.',
    })),
    evidence: [
      { label: 'profile suite', value: application.profileSuiteRoot },
      {
        label: 'member',
        value: discovery.memberRoots[MEMBER_ID] ?? '',
      },
      { label: 'portfolio cut', value: portfolio.cut.system_time },
      {
        label: 'KFX plan',
        value: `${kfxPlan.entries.length} views · ${kfxPlan.services.length} services`,
      },
    ],
    notice: 'read-only Portfolio projection',
  };
}

export function degradedWorkControlModel(error: unknown): ProfileShellModel {
  const message = error instanceof Error ? error.message : String(error);
  return {
    profile: {
      id: PROFILE_ID,
      title: 'Work Control',
      version: 'Profile/KFD-3',
      suiteRoot: '',
      qualified: false,
    },
    subject: {
      id: '',
      title: 'Work Control unavailable',
      subtitle: 'No mutation was attempted.',
    },
    navigation: [],
    cards: [],
    evidence: [],
    notice: message,
  };
}

type ObserverChild = ChildProcessByStdio<null, Readable, Readable>;

export type GlobalWorkContribution = {
  searchDocuments: ProductSearchDocument[];
};

export type GlobalWorkObserverDeps = {
  bin: string;
  argsPrefix?: string[];
  env: NodeJS.ProcessEnv;
  statePath: string;
  spawn: (
    file: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe'] },
  ) => ObserverChild;
  onSnapshot: (snapshot: GlobalWorkSnapshot) => void;
  onError: (error: Error) => void;
};

export function globalWorkObserverArgs(
  statePath: string,
  argsPrefix: string[] = [],
): string[] {
  return [
    ...argsPrefix,
    'workspace',
    'work',
    '--scope',
    'all',
    '--max-workers',
    '8',
    '--include-settled',
    '--observe',
    '--observer-state',
    statePath,
    '--json',
  ];
}

export function globalWorkContribution(
  snapshot: GlobalWorkSnapshot,
  options: {
    runtimeAuditFile?: string;
    readFile?: (path: string) => string;
  } = {},
): GlobalWorkContribution {
  const searchDocuments = globalWorkSearchDocuments(snapshot);
  const runtimeAuditFile =
    options.runtimeAuditFile ?? process.env.KF_SKILL_RUNTIME_AUDIT_FILE;
  if (runtimeAuditFile) {
    try {
      const [identity, detail] = describeTuiSkillRuntimeAudit(
        JSON.parse(
          (options.readFile ?? ((path) => readFileSync(path, 'utf8')))(
            runtimeAuditFile,
          ),
        ),
      );
      searchDocuments.unshift({
        id: 'help.skill-runtime-audit',
        kind: 'help',
        title: identity,
        summary: detail,
        section: 'Runtime evidence',
        keywords: [
          'skill',
          'audit',
          'work',
          'dependency',
          'trust',
          'receipt',
          'history',
          'recovery',
        ],
        priority: 0,
        action: { kind: 'show-help', topicId: 'skill-runtime-audit' },
      });
    } catch {
      // An absent or drifting audit remains unavailable; it is never reinterpreted.
    }
  }
  return {
    searchDocuments,
  };
}

export function loadLatestGlobalWorkCache(
  readFile: (path: string) => string,
  paths: string[],
): GlobalWorkSnapshot | null {
  const snapshots: GlobalWorkSnapshot[] = [];
  for (const candidate of paths) {
    try {
      snapshots.push(parseGlobalWorkSnapshot(JSON.parse(readFile(candidate))));
    } catch {
      // A missing, partial, or old cache never blocks the live observer.
    }
  }
  return (
    snapshots.sort((left, right) =>
      (right.observed_at ?? '').localeCompare(left.observed_at ?? ''),
    )[0] ?? null
  );
}

export function parseGlobalWorkObserverLine(
  line: string,
): GlobalWorkSnapshot | Error | null {
  try {
    const value = JSON.parse(line) as {
      schema?: string;
      kind?: string;
      error?: string;
    };
    if (
      value.schema !== 'kungfu.gui.global-work-observer-event/v1' ||
      (value.kind !== 'snapshot' && value.kind !== 'error')
    ) {
      return null;
    }
    if (value.kind === 'error') {
      return new Error(value.error || 'global Work observer failed');
    }
    return parseGlobalWorkSnapshot(value);
  } catch {
    return null;
  }
}

export function startGlobalWorkObserver(
  deps: GlobalWorkObserverDeps,
): () => void {
  let child: ObserverChild | null = null;
  let restartTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  const start = () => {
    if (stopped || child) return;
    let stdout = '';
    let stderr = '';
    const launched = deps.spawn(
      deps.bin,
      globalWorkObserverArgs(deps.statePath, deps.argsPrefix),
      {
        env: { ...deps.env, PYTHONDONTWRITEBYTECODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child = launched;
    launched.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        const value = parseGlobalWorkObserverLine(line);
        if (value instanceof Error) deps.onError(value);
        else if (value) deps.onSnapshot(value);
      }
    });
    launched.stderr.on('data', (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8192);
    });
    launched.on('error', deps.onError);
    launched.on('exit', (_code, signal) => {
      if (child !== launched) return;
      child = null;
      if (stopped) return;
      deps.onError(
        new Error(
          stderr.trim() ||
            `global Work observer exited${signal ? ` (${signal})` : ''}`,
        ),
      );
      restartTimer = setTimeout(() => {
        restartTimer = null;
        start();
      }, 1000);
    });
  };

  start();
  return () => {
    stopped = true;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    child?.kill('SIGTERM');
    child = null;
  };
}
