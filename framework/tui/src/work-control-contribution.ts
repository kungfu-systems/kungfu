// SPDX-License-Identifier: Apache-2.0

import type { Profile } from '@kungfu-tech/api/capability';
import type { KfxLoadPlan } from '@kungfu-tech/kfx';

import type { ProfileShellModel } from './profile-shell.js';

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
