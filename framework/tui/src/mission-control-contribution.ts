// SPDX-License-Identifier: Apache-2.0

import type { Profile } from '@kungfu-tech/api/capability';
import type { KfxLoadPlan } from '@kungfu-tech/kfx';

import type { ProfileShellModel } from './profile-shell.js';

const PROFILE_ID = 'kungfu.mission-control';
const MEMBER_ID = 'mission-control-actions';
const MISSION_QUESTION_IDS = [
  'mission-intent',
  'observed-progress',
  'evidence-at-cut',
  'fitness-for-purpose',
  'next-responsibility',
] as const;

type Dashboard = {
  missions: Array<{
    mission_id: string;
    title?: string;
    status?: string;
    subject_key?: string;
  }>;
};

type MissionHome = {
  schema: 'kungfu.mission-control.mission-home/v1';
  mode: 'read-only';
  query_definition_root: string;
  query_proof_root: string;
  query_profile: {
    profile: {
      id: string;
      version: string;
      profile_suite_root: string;
      catalog_root: string;
      member_roots: Record<string, string>;
    };
    mission_subject: string;
    query_definition_root: string;
    query_proof_root: string;
    answers: Array<{
      question_id: string;
      question: string;
      status: string;
      summary: string;
    }>;
  };
  state: {
    mission?: { payload?: { record?: { title?: string; intent?: string } } };
  };
};

function sourceId(mission: Dashboard['missions'][number]): string | undefined {
  const suffix = `:${mission.mission_id}`;
  return mission.subject_key?.endsWith(suffix)
    ? mission.subject_key.slice(0, -suffix.length)
    : undefined;
}

function assertSameNonEmptyRoot(label: string, roots: string[]): void {
  if (roots.some((root) => !root)) {
    throw new Error(`${label} is missing from a public Profile receipt`);
  }
  if (new Set(roots).size !== 1) {
    throw new Error(`${label} drifted across public Profile receipts`);
  }
}

function assertMissionHome(
  home: MissionHome,
  suiteRoots: string[],
  memberRoots: string[],
): void {
  const profile = home.query_profile;
  assertSameNonEmptyRoot('Profile Suite root', [
    ...suiteRoots,
    profile.profile.profile_suite_root,
  ]);
  assertSameNonEmptyRoot('Mission Control member root', [
    ...memberRoots,
    profile.profile.member_roots[MEMBER_ID] ?? '',
  ]);
  assertSameNonEmptyRoot('Mission query definition root', [
    home.query_definition_root,
    profile.query_definition_root,
  ]);
  assertSameNonEmptyRoot('Mission query proof root', [
    home.query_proof_root,
    profile.query_proof_root,
  ]);
  if (
    profile.query_definition_root !== home.query_definition_root ||
    profile.query_proof_root !== home.query_proof_root
  ) {
    throw new Error(
      'Mission Home query roots do not match the public Profile receipt',
    );
  }
  const questionIds = profile.answers.map((answer) => answer.question_id);
  if (
    questionIds.length !== MISSION_QUESTION_IDS.length ||
    questionIds.some((id, index) => id !== MISSION_QUESTION_IDS[index])
  ) {
    throw new Error('Mission Home did not return the canonical five questions');
  }
}

export async function loadMissionControlContribution(
  profile: Profile,
  kfxPlan: KfxLoadPlan,
  preferredMissionId = '',
): Promise<ProfileShellModel> {
  const discovery = await profile.discoverAsync(PROFILE_ID);
  const [application, kfd3, dashboardReceipt] = await Promise.all([
    profile.applicationAsync(discovery.source),
    profile.kfd3StatusAsync(discovery.source),
    profile.memberCallAsync<Dashboard>(
      discovery.source,
      MEMBER_ID,
      'dashboard',
      {},
    ),
  ]);
  const dashboard = dashboardReceipt.result;
  if (!kfd3.qualified || !kfd3.activeExactRoot) {
    throw new Error(
      'Mission Control Profile is not KFD-3 exact-root qualified',
    );
  }
  assertSameNonEmptyRoot('Profile Suite root', [
    discovery.profileSuiteRoot,
    application.profileSuiteRoot,
    kfd3.profileSuiteRoot,
    dashboardReceipt.profileSuiteRoot,
  ]);
  assertSameNonEmptyRoot('Mission Control member root', [
    discovery.memberRoots[MEMBER_ID] ?? '',
    dashboardReceipt.memberRoot,
  ]);
  const mission =
    dashboard.missions.find((row) => row.mission_id === preferredMissionId) ??
    dashboard.missions[0];
  const base = {
    profile: {
      id: PROFILE_ID,
      title: 'Mission Control',
      version: 'Profile/KFD-3',
      suiteRoot: application.profileSuiteRoot,
      qualified: kfd3.qualified && kfd3.activeExactRoot,
    },
    navigation: dashboard.missions.map((row) => ({
      id: row.mission_id,
      label: row.title ?? row.mission_id,
      status: row.status ?? 'unknown',
    })),
  };
  if (!mission) {
    return {
      ...base,
      subject: {
        id: '',
        title: 'No Mission selected',
        subtitle: 'No admitted Mission facts are visible at this cut.',
      },
      cards: [],
      evidence: [
        { label: 'profile suite', value: application.profileSuiteRoot },
        {
          label: 'KFX plan',
          value: `${kfxPlan.entries.length} views · ${kfxPlan.services.length} services`,
        },
      ],
      notice: 'empty read-only projection',
    };
  }

  const homeReceipt = await profile.memberCallAsync<MissionHome>(
    discovery.source,
    MEMBER_ID,
    'mission-home',
    { missionId: mission.mission_id, source: sourceId(mission) },
  );
  const home = homeReceipt.result;
  assertMissionHome(
    home,
    [
      discovery.profileSuiteRoot,
      application.profileSuiteRoot,
      kfd3.profileSuiteRoot,
      dashboardReceipt.profileSuiteRoot,
      homeReceipt.profileSuiteRoot,
    ],
    [
      discovery.memberRoots[MEMBER_ID] ?? '',
      dashboardReceipt.memberRoot,
      homeReceipt.memberRoot,
    ],
  );
  const record = home.state.mission?.payload?.record;
  return {
    ...base,
    subject: {
      id: mission.mission_id,
      title: record?.title ?? mission.title ?? mission.mission_id,
      subtitle: record?.intent ?? 'Mission intent is not declared.',
    },
    cards: home.query_profile.answers.map((answer) => ({
      id: answer.question_id,
      title: answer.question,
      status: answer.status,
      summary: answer.summary,
    })),
    evidence: [
      {
        label: 'profile suite',
        value: home.query_profile.profile.profile_suite_root,
      },
      { label: 'catalog', value: home.query_profile.profile.catalog_root },
      { label: 'query definition', value: home.query_definition_root },
      { label: 'query proof', value: home.query_proof_root },
      {
        label: 'KFX plan',
        value: `${kfxPlan.entries.length} views · ${kfxPlan.services.length} services`,
      },
    ],
    notice: home.mode,
  };
}

export function degradedMissionControlModel(error: unknown): ProfileShellModel {
  return {
    profile: {
      id: PROFILE_ID,
      title: 'Mission Control',
      version: 'degraded',
      suiteRoot: '',
      qualified: false,
    },
    subject: {
      id: '',
      title: 'Profile unavailable',
      subtitle: error instanceof Error ? error.message : String(error),
    },
    navigation: [],
    cards: [],
    evidence: [],
    notice:
      'No mutation was attempted. Check Profile activation and runtime home.',
  };
}
