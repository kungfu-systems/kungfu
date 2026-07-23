// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Profile } from '@kungfu-tech/api/capability';
import type { KfxLoadPlan } from '@kungfu-tech/kfx';

import { loadMissionControlContribution } from './mission-control-contribution.js';

function profileFixture(
  options: {
    proofRoot?: string;
    suiteRoot?: string;
    dashboardSuiteRoot?: string;
    questionIds?: string[];
  } = {},
): Profile {
  const suiteRoot = options.suiteRoot ?? 'sha256:suite';
  const memberRoot = 'sha256:member';
  return {
    discoverAsync: async () => ({
      source: '/profile/mission-control',
      profileSuiteRoot: suiteRoot,
      memberRoots: { 'mission-control-actions': memberRoot },
    }),
    applicationAsync: async () => ({ profileSuiteRoot: suiteRoot }),
    kfd3StatusAsync: async () => ({
      qualified: true,
      activeExactRoot: true,
      profileSuiteRoot: suiteRoot,
    }),
    memberCallAsync: async <TResult>(
      _source: string,
      _member: string,
      operation: string,
    ) => {
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
                  member_roots: { 'mission-control-actions': memberRoot },
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
