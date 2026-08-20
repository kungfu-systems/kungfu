import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MISSION_CONTROL_VISUAL_SPEC,
  buildGoalClusters,
  deriveTrustVisual,
  queryGoalClusters,
  responsibilityActions,
} from '../src/view/initiative-visual-model.ts';
import type {
  AtlasGoal,
  WorkControlAuthorityReport,
} from '../src/view/work-control-profile.ts';
import { DEFAULT_GOAL_CARD_QUERY } from '../src/view/work-control-query.ts';

const goal = (goalId: string, fields: Partial<AtlasGoal> = {}): AtlasGoal => ({
  goal_id: goalId,
  mission_id: 'mission-a',
  status: 'active',
  ...fields,
});

const report = (fields: Partial<WorkControlAuthorityReport> = {}) =>
  ({
    schema: 'kungfu.work-control.trust-report/v1',
    fitness: 'fit',
    findings: ['progress is supported'],
    known_limits: [],
    assessment_key: 'assessment-a',
    query_definition_root: 'sha256:definition',
    query_proof_root: 'sha256:proof',
    assessment: { state: 'completed' },
    profile: {
      schema: 'kungfu.profile.delegated-work-cost-state-proof/v1',
      profile_hash: 'sha256:profile',
      profile: { id: 'profile', version: '1' },
      mission_subject: 'atlas:mission-a',
      cost: {
        status: 'missing',
        observation_count: 0,
        linked_run_count: 0,
        tokens: {
          input_tokens: 0,
          output_tokens: 0,
          cached_input_tokens: 0,
          cache_creation_input_tokens: 0,
          reasoning_tokens: 0,
        },
        cost_usd_known: false,
        attribution: { best: 'unknown', worst: 'unknown', ambiguous: false },
        proof_episodes: [],
        missing: {
          unsealed_runs: [],
          unreadable_runs: [],
          no_linked_cost_fact: true,
        },
      },
      state: {
        value: 'active',
        source_statuses: ['active'],
        mapping_policy: 'work-control',
        go_subjects: [],
      },
      proof: {
        canonical_state: true,
        query_definition_root: 'sha256:definition',
        query_proof_root: 'sha256:proof',
        query_result_hash: 'sha256:result',
        verified_fact_episode_roots: ['sha256:episode'],
        cost_episode_roots: [],
        assessment_state: 'completed',
        conflicts: [],
        unverifiable_inputs: [],
      },
    },
    state: {
      mission_subject: 'atlas:mission-a',
      canonical_state: true,
      cut: {},
      mission: null,
      goals: [],
    },
    ...fields,
  }) as WorkControlAuthorityReport;

test('visual spec keeps the five questions internal and forbids synthetic truth', () => {
  assert.equal(
    MISSION_CONTROL_VISUAL_SPEC.schema,
    'kungfu.work-control.visual-spec/v1',
  );
  assert.equal(
    MISSION_CONTROL_VISUAL_SPEC.disclosure.questions,
    'internal-only',
  );
  assert.equal(MISSION_CONTROL_VISUAL_SPEC.trust.scalarScore, 'forbidden');
  assert.equal(
    MISSION_CONTROL_VISUAL_SPEC.trajectory.syntheticMilestones,
    'forbidden',
  );
});

test('parent and descendants occupy one cluster and a blocked child propagates attention', () => {
  const clusters = buildGoalClusters([
    goal('parent'),
    goal('child-a', { mission_parent_goal: 'parent', status: 'completed' }),
    goal('child-b', { mission_parent_goal: 'parent', status: 'blocked' }),
    goal('grandchild', { mission_parent_goal: 'child-b', status: 'active' }),
  ]);

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].parent.goal_id, 'parent');
  assert.deepEqual(
    clusters[0].members.map(({ goal: row, depth }) => [row.goal_id, depth]),
    [
      ['parent', 0],
      ['child-a', 1],
      ['child-b', 1],
      ['grandchild', 2],
    ],
  );
  assert.equal(clusters[0].section, 'attention');
});

test('goal-card query retains the parent for a matching child and hides closed siblings', () => {
  const clusters = queryGoalClusters(
    [
      goal('parent', {
        title: 'Parent delivery',
        mission_importance: 'medium',
      }),
      goal('closed-child', {
        title: 'Old work',
        mission_parent_goal: 'parent',
        status: 'completed',
      }),
      goal('risk-child', {
        title: 'Release evidence gap',
        mission_parent_goal: 'parent',
        status: 'blocked',
        mission_importance: 'high',
      }),
    ],
    {
      ...DEFAULT_GOAL_CARD_QUERY,
      text: 'evidence gap',
      hideClosedChildren: true,
    },
  );

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].section, 'attention');
  assert.equal(clusters[0].matchCount, 1);
  assert.deepEqual(
    clusters[0].members.map(({ goal: row }) => row.goal_id),
    ['parent', 'risk-child'],
  );
});

test('decision priority sorts propagated trust risk before ordinary active work', () => {
  const clusters = queryGoalClusters(
    [
      goal('ordinary', {
        title: 'Ordinary active work',
        updated_at: '2026-07-12T08:00:00Z',
      }),
      goal('risk-parent', {
        title: 'Risk cluster',
        updated_at: '2026-07-11T08:00:00Z',
      }),
      goal('risk-child', {
        mission_parent_goal: 'risk-parent',
        status: 'paused',
      }),
    ],
    DEFAULT_GOAL_CARD_QUERY,
    { 'risk-child': 'stale' },
    Date.parse('2026-07-12T10:00:00Z'),
  );

  assert.deepEqual(
    clusters.map((cluster) => cluster.key),
    ['risk-parent', 'ordinary'],
  );
});

test('structured filters combine actor, status, hierarchy, and cut-relative time', () => {
  const clusters = queryGoalClusters(
    [
      goal('parent', {
        owner_agent: 'codex',
        updated_at: '2026-07-12T08:00:00Z',
      }),
      goal('child', {
        owner_agent: 'codex',
        mission_parent_goal: 'parent',
        updated_at: '2026-07-12T09:00:00Z',
      }),
      goal('other', {
        owner_agent: 'claude',
        updated_at: '2026-07-01T09:00:00Z',
      }),
    ],
    {
      ...DEFAULT_GOAL_CARD_QUERY,
      statuses: ['active'],
      actors: ['codex'],
      updatedWithinDays: 1,
      hasChildren: 'yes',
    },
    {},
    Date.parse('2026-07-12T10:00:00Z'),
  );

  assert.deepEqual(
    clusters.map((cluster) => cluster.key),
    ['parent'],
  );
  assert.equal(clusters[0].matchCount, 2);
});

test('trust remains unknown without a purpose-bound report and maps explicit report state', () => {
  assert.equal(deriveTrustVisual(null).state, 'unknown');
  assert.equal(deriveTrustVisual(report()).state, 'established');
  assert.equal(
    deriveTrustVisual(
      report({
        fitness: 'warning',
        profile: {
          ...report().profile,
          proof: { ...report().profile.proof, canonical_state: false },
        },
      }),
    ).state,
    'attention',
  );
  assert.equal(
    deriveTrustVisual(report({ assessment: { state: 'invalidated' } })).state,
    'stale',
  );
});

test('next actor is projected from the query answer rather than component inference', () => {
  const actions = responsibilityActions(
    report({
      query_profile: {
        schema: 'kungfu.work-control.query-profile/v1',
        profile_hash: 'sha256:profile',
        profile: {
          id: 'kungfu.work-control',
          version: '3.0.0',
          reducer: 'kungfu.work-control.five-questions',
          profile_suite_root: 'sha256:suite',
          catalog_root: 'sha256:catalog',
          member_roots: {},
        },
        mission_subject: 'atlas:mission-a',
        query_definition_root: 'sha256:definition',
        query_proof_root: 'sha256:proof',
        result_hash: 'sha256:result',
        query_receipt: {
          schema: 'kungfu.profile-query-receipt/v1',
          planId: 'sha256:plan',
          profileSuiteRoot: 'sha256:suite',
          catalogRoot: 'sha256:catalog',
          viewId: 'mission-state-table',
          queryDefinitionRoot: 'sha256:definition',
          queryProofRoot: 'sha256:proof',
          result: {},
        },
        views: [],
        answers: [
          {
            question_id: 'next-responsibility',
            question: 'internal question',
            status: 'declared',
            summary: 'Agent A continues',
            data: {
              declared_actions: [
                {
                  actor: 'Agent A',
                  subject: 'goal-a',
                  action: 'Run the visual dogfood',
                  source: 'go.next_action',
                },
              ],
            },
          },
        ],
      },
    }),
  );

  assert.deepEqual(actions, [
    {
      actor: 'Agent A',
      subject: 'goal-a',
      action: 'Run the visual dogfood',
      source: 'go.next_action',
    },
  ]);
});
