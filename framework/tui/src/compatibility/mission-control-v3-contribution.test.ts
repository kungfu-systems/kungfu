// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Profile } from '@kungfu-tech/api/capability';
import type { KfxLoadPlan } from '@kungfu-tech/kfx';

import { loadMissionControlContribution } from './mission-control-v3-contribution.js';

function profileFixture(
  options: {
    proofRoot?: string;
    suiteRoot?: string;
    dashboardSuiteRoot?: string;
    questionIds?: string[];
    qualified?: boolean;
    memberCalls?: string[];
  } = {},
): Profile {
  const suiteRoot = options.suiteRoot ?? 'sha256:suite';
  const memberRoot = 'sha256:member';
  return {
    discoverAsync: async () => ({
      source: '/profile/mission-control',
      profileSuiteRoot: suiteRoot,
      memberRoots: { 'work-control-actions': memberRoot },
    }),
    applicationAsync: async () => ({ profileSuiteRoot: suiteRoot }),
    kfd3StatusAsync: async () => ({
      qualified: options.qualified ?? true,
      activeExactRoot: options.qualified ?? true,
      profileSuiteRoot: suiteRoot,
      reason:
        options.qualified === false
          ? 'Profile must be active at this exact root before KFD-3 qualification'
          : undefined,
    }),
    memberCallAsync: async <TResult>(
      _source: string,
      _member: string,
      operation: string,
    ) => {
      options.memberCalls?.push(operation);
      const result =
        operation === 'dashboard'
          ? {
              missions: [
                {
                  mission_id: 'mission-a',
                  title: 'Mission A',
                  status: 'active',
                  subject_key: 'atlas:mission-a',
                },
              ],
            }
          : {
              schema: 'kungfu.mission-control.mission-home/v1',
              mode: 'read-only',
              query_definition_root: 'sha256:definition',
              query_proof_root: options.proofRoot ?? 'sha256:proof',
              state: {
                mission: {
                  payload: {
                    record: { title: 'Mission A', intent: 'Intent A' },
                  },
                },
              },
              query_profile: {
                profile: {
                  id: 'kungfu.mission-control',
                  version: '3.0.0',
                  profile_suite_root: suiteRoot,
                  catalog_root: 'sha256:catalog',
                  member_roots: { 'work-control-actions': memberRoot },
                },
                mission_subject: 'atlas:mission-a',
                query_definition_root: 'sha256:definition',
                query_proof_root: 'sha256:proof',
                answers: [
                  'mission-intent',
                  'observed-progress',
                  'evidence-at-cut',
                  'fitness-for-purpose',
                  'next-responsibility',
                ].map((questionId, index) => ({
                  question_id: options.questionIds?.[index] ?? questionId,
                  question: `Question ${index}`,
                  status: 'established',
                  summary: `Answer ${index}`,
                })),
              },
            };
      return {
        result,
        profileSuiteRoot:
          operation === 'dashboard'
            ? (options.dashboardSuiteRoot ?? suiteRoot)
            : suiteRoot,
        memberRoot,
      } as unknown as { result: TResult };
    },
  } as unknown as Profile;
}

const kfxPlan = { entries: [], services: [] } as unknown as KfxLoadPlan;

test('loads five questions through public read-only Profile member calls', async () => {
  const model = await loadMissionControlContribution(profileFixture(), kfxPlan);
  assert.equal(model.subject.id, 'mission-a');
  assert.equal(model.cards.length, 5);
  assert.equal(model.profile.qualified, true);
  assert.equal(model.notice, 'read-only');
  assert.deepEqual(
    model.evidence.slice(2, 4).map((row) => row.value),
    ['sha256:definition', 'sha256:proof'],
  );
});

test('does not call Profile members before the installed exact root is active', async () => {
  const memberCalls: string[] = [];
  const model = await loadMissionControlContribution(
    profileFixture({ qualified: false, memberCalls }),
    kfxPlan,
  );
  assert.deepEqual(memberCalls, []);
  assert.equal(model.subject.title, 'Mission Control needs activation');
  assert.match(model.subject.subtitle, /active at this exact root/);
  assert.match(model.cards[1]?.summary ?? '', /did not read work/);
  assert.match(model.cards[2]?.summary ?? '', /Press a/);
  assert.equal(model.notice, 'activation required · no mutation attempted');
});

test('fails closed when public query roots drift', async () => {
  await assert.rejects(
    loadMissionControlContribution(
      profileFixture({ proofRoot: 'sha256:drift' }),
      kfxPlan,
    ),
    /Mission query proof root drifted/,
  );
});

test('fails closed on missing or mixed public exact roots', async () => {
  await assert.rejects(
    loadMissionControlContribution(
      profileFixture({ dashboardSuiteRoot: 'sha256:other-suite' }),
      kfxPlan,
    ),
    /Profile Suite root drifted/,
  );
});

test('fails closed when the canonical five-question identity drifts', async () => {
  await assert.rejects(
    loadMissionControlContribution(
      profileFixture({
        questionIds: [
          'mission-intent',
          'observed-progress',
          'evidence-at-cut',
          'fitness-for-purpose',
          'duplicate',
        ],
      }),
      kfxPlan,
    ),
    /canonical five questions/,
  );
});
