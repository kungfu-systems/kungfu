// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Profile } from '@kungfu-tech/api/capability';
import type { KfxLoadPlan } from '@kungfu-tech/kfx';

import { loadWorkControlContribution } from './work-control-contribution.js';

function profileFixture(authoritativePortfolio = false): Profile {
  const suiteRoot = 'sha256:suite';
  const memberRoot = 'sha256:member';
  return {
    discoverAsync: async (profileId: string) => {
      assert.equal(profileId, 'kungfu.work-control');
      return {
        source: '/profile/work-control',
        profileSuiteRoot: suiteRoot,
        memberRoots: { 'work-control-actions': memberRoot },
      };
    },
    applicationAsync: async () => ({ profileSuiteRoot: suiteRoot }),
    kfd3StatusAsync: async () => ({
      qualified: true,
      activeExactRoot: true,
      profileSuiteRoot: suiteRoot,
    }),
    memberCallAsync: async <TResult>(
      _source: string,
      member: string,
      operation: string,
    ) => {
      assert.equal(member, 'work-control-actions');
      assert.equal(operation, 'portfolio');
      return {
        result: {
          schema: 'kungfu.work-control.portfolio-snapshot/v1',
          cut: { kind: 'system_time', system_time: '42' },
          projection_authority: {
            mode: 'read-only',
            writableAuthority: authoritativePortfolio,
            atomicGlobalCut: false,
            completionAuthority: false,
          },
          initiatives: [
            {
              initiative_id: 'initiative-a',
              title: 'Initiative A',
              intent: 'Intent A',
              status: 'active',
            },
          ],
          assignments: [
            {
              assignment_id: 'assignment-a',
              initiative_id: 'initiative-a',
              title: 'Assignment A',
              objective: 'Objective A',
              phase: 'executing',
            },
          ],
        },
        profileSuiteRoot: suiteRoot,
        memberRoot,
      } as unknown as { result: TResult };
    },
  } as unknown as Profile;
}

const kfxPlan = { entries: [], services: [] } as unknown as KfxLoadPlan;

test('renders native Initiative and Assignment vocabulary from Portfolio', async () => {
  const model = await loadWorkControlContribution(profileFixture(), kfxPlan);
  assert.equal(model.profile.id, 'kungfu.work-control');
  assert.equal(model.profile.title, 'Work Control');
  assert.equal(model.subject.id, 'initiative-a');
  assert.equal(model.cards[0]?.id, 'assignment-a');
  assert.equal(model.notice, 'read-only Portfolio projection');
});

test('rejects a Portfolio that claims write authority', async () => {
  await assert.rejects(
    loadWorkControlContribution(profileFixture(true), kfxPlan),
    /claimed authority/,
  );
});
