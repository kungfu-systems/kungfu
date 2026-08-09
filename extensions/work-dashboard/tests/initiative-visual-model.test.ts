import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WORK_CONTROL_VISUAL_SPEC,
  buildAssignmentClusters,
  deriveTrustVisual,
  queryAssignmentClusters,
  responsibilityActions,
} from '../src/view/initiative-visual-model.ts';
import type {
  WorkControlAssignment,
  WorkControlAuthorityReport,
} from '../src/view/work-control-profile.ts';
import { DEFAULT_ASSIGNMENT_CARD_QUERY } from '../src/view/work-control-query.ts';

const assignment = (
  assignmentId: string,
  fields: Partial<WorkControlAssignment> = {},
): WorkControlAssignment => ({
  assignment_id: assignmentId,
  initiative_id: 'initiative-a',
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
      initiative_subject: 'kungfu:initiative-a',
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
        assignment_subjects: [],
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
      initiative_subject: 'kungfu:initiative-a',
      canonical_state: true,
      cut: {},
      initiative: null,
      assignments: [],
    },
    ...fields,
  }) as WorkControlAuthorityReport;

test('visual spec keeps the five questions internal and forbids synthetic truth', () => {
  assert.equal(
    WORK_CONTROL_VISUAL_SPEC.schema,
    'kungfu.work-control.visual-spec/v1',
  );
  assert.equal(WORK_CONTROL_VISUAL_SPEC.disclosure.questions, 'internal-only');
  assert.equal(WORK_CONTROL_VISUAL_SPEC.trust.scalarScore, 'forbidden');
  assert.equal(
    WORK_CONTROL_VISUAL_SPEC.trajectory.syntheticMilestones,
    'forbidden',
  );
});

test('parent and descendants occupy one cluster and a blocked child propagates attention', () => {
  const clusters = buildAssignmentClusters([
    assignment('parent'),
    assignment('child-a', {
      parent_assignment_id: 'parent',
      status: 'completed',
    }),
    assignment('child-b', {
      parent_assignment_id: 'parent',
      status: 'blocked',
    }),
    assignment('grandchild', {
      parent_assignment_id: 'child-b',
      status: 'active',
    }),
  ]);

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].parent.assignment_id, 'parent');
  assert.deepEqual(
    clusters[0].members.map(({ assignment: row, depth }) => [
      row.assignment_id,
      depth,
    ]),
    [
      ['parent', 0],
      ['child-a', 1],
      ['child-b', 1],
      ['grandchild', 2],
    ],
  );
  assert.equal(clusters[0].section, 'attention');
});

test('assignment-card query retains the parent for a matching child and hides closed siblings', () => {
  const clusters = queryAssignmentClusters(
    [
      assignment('parent', {
        title: 'Parent delivery',
        initiative_importance: 'medium',
      }),
      assignment('closed-child', {
        title: 'Old work',
        parent_assignment_id: 'parent',
        status: 'completed',
      }),
      assignment('risk-child', {
        title: 'Release evidence gap',
        parent_assignment_id: 'parent',
        status: 'blocked',
        initiative_importance: 'high',
      }),
    ],
    {
      ...DEFAULT_ASSIGNMENT_CARD_QUERY,
      text: 'evidence gap',
      hideClosedChildren: true,
    },
  );

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].section, 'attention');
  assert.equal(clusters[0].matchCount, 1);
  assert.deepEqual(
    clusters[0].members.map(({ assignment: row }) => row.assignment_id),
    ['parent', 'risk-child'],
  );
});

test('decision priority sorts propagated trust risk before ordinary active work', () => {
  const clusters = queryAssignmentClusters(
    [
      assignment('ordinary', {
        title: 'Ordinary active work',
        updated_at: '2026-07-12T08:00:00Z',
      }),
      assignment('risk-parent', {
        title: 'Risk cluster',
        updated_at: '2026-07-11T08:00:00Z',
      }),
      assignment('risk-child', {
        parent_assignment_id: 'risk-parent',
        status: 'paused',
      }),
    ],
    DEFAULT_ASSIGNMENT_CARD_QUERY,
    { 'risk-child': 'stale' },
    Date.parse('2026-07-12T10:00:00Z'),
  );

  assert.deepEqual(
    clusters.map((cluster) => cluster.key),
    ['risk-parent', 'ordinary'],
  );
});

test('structured filters combine actor, status, hierarchy, and cut-relative time', () => {
  const clusters = queryAssignmentClusters(
    [
      assignment('parent', {
        owner_agent: 'codex',
        updated_at: '2026-07-12T08:00:00Z',
      }),
      assignment('child', {
        owner_agent: 'codex',
        parent_assignment_id: 'parent',
        updated_at: '2026-07-12T09:00:00Z',
      }),
      assignment('other', {
        owner_agent: 'claude',
        updated_at: '2026-07-01T09:00:00Z',
      }),
    ],
    {
      ...DEFAULT_ASSIGNMENT_CARD_QUERY,
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
        initiative_subject: 'kungfu:initiative-a',
        query_definition_root: 'sha256:definition',
        query_proof_root: 'sha256:proof',
        result_hash: 'sha256:result',
        query_receipt: {
          schema: 'kungfu.profile-query-receipt/v1',
          planId: 'sha256:plan',
          profileSuiteRoot: 'sha256:suite',
          catalogRoot: 'sha256:catalog',
          viewId: 'initiative-state-table',
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
                  subject: 'assignment-a',
                  action: 'Run the visual dogfood',
                  source: 'assignment.next_action',
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
      subject: 'assignment-a',
      action: 'Run the visual dogfood',
      source: 'assignment.next_action',
    },
  ]);
});
