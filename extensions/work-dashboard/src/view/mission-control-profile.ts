import type {
  Profile,
  ProfileIntentReceipt,
  QueryDefinition,
} from '@kungfu-tech/api/capability';

// Mission Control domain client over the public, exact-root Profile surface.
// Domain types live with this Profile KFX rather than in the generic API.

export type AtlasMission = {
  mission_id: string;
  title?: string;
  intent?: string;
  north_star?: string;
  why_it_matters?: string;
  status?: string;
  horizon?: string;
  owner?: string;
  subject_key?: string;
  source_authority?: string;
  authority_mode?: string;
  active_lens?: string;
  stage_name?: string;
  stage_summary?: string;
  next_review?: string;
  next_action?: string;
  updated_at?: string;
};

export type AtlasGoal = {
  goal_id: string;
  status?: string;
  title?: string;
  owner_agent?: string;
  mission_id?: string;
  lens?: string;
  mission_stage?: string;
  mission_role?: string;
  mission_importance?: string;
  mission_track?: string;
  mission_parent_goal?: string;
  mission_why_matters?: string;
  source_branch?: string;
  worktree_path?: string;
  external_repo_path?: string;
  external_branch?: string;
  external_head?: string;
  external_ready_ref?: string;
  latest_marker?: string;
  summary?: string;
  next_action?: string;
  updated_at?: string;
  archived?: boolean;
};

export type AtlasMarker = {
  branch: string;
  status?: string;
  ready?: boolean;
  ready_scope?: string;
  keep_source_worktree?: boolean;
  worktree_path?: string;
  summary?: string;
  risk?: string;
  marker_path?: string;
};

export type AtlasImportResult = {
  import_id: string;
  repo_root: string;
  missions: number;
  goals: number;
  markers: number;
  mission_control?: {
    status: string;
    authority_mode: string;
    admitted?: number;
    already_present?: number;
    import_episode_id?: number;
    import_episode_root?: string;
  };
  warnings: string[];
};

export type AtlasImportInfo = {
  import_id: string;
  repo_root: string;
  repo_head?: string;
  missions: number;
  goals: number;
  markers: number;
};

export type AtlasAuthorityState = {
  schema: 'kungfu.mission-control.authority-status/v1';
  state: 'native-only' | 'pre-cutover' | 'native-active' | 'rolled-back';
  write_authority: 'atlas-adapter' | 'kungfu-native';
  legacy_mutation_path: string;
  migration_id: string;
  parity_root: string;
  transition_count: number;
};

export type AtlasAuthorityInspection = {
  authority: AtlasAuthorityState;
  parity: {
    schema: 'kungfu.mission-control.authority-parity/v1';
    status: 'matched' | 'degraded';
    parity_root: string;
    counts: Record<string, number>;
  };
};

export type AtlasAuthorityTransition = {
  status: 'cutover' | 'already-active' | 'rolled-back';
  migration: {
    migration_id: string;
    migration_status: 'native-active' | 'rolled-back';
    write_authority: 'atlas-adapter' | 'kungfu-native';
    parity_root: string;
    previous_migration_id?: string | null;
  };
};

export type AtlasDashboardSnapshot = {
  schema: 'kungfu.mission-control.dashboard-snapshot/v1';
  cut: {
    kind: 'system_time';
    system_time: string;
  };
  freshness: {
    status: 'fresh' | 'degraded';
    basis: 'request-cut';
  };
  projection_authority: {
    mode: 'adapter-projection';
    source: 'atlas-and-kungfu-facts';
    profileSuiteRoot: string;
    memberRoot: string;
    cutSystemTime: string;
    writableAuthority: false;
  };
  import_info: AtlasImportInfo | null;
  authority: AtlasAuthorityState;
  missions: AtlasMission[];
  goals: AtlasGoal[];
};

export type AtlasMissionDetail = {
  mission: AtlasMission;
  goals: AtlasGoal[];
};

export type AtlasMissionControlReport = {
  schema: 'kungfu.mission-control.trust-report/v1';
  fitness: string;
  findings: string[];
  known_limits: string[];
  assessment_key: string;
  report_hash?: string;
  query_definition_root: string;
  query_proof_root: string;
  query_profile?: {
    schema: 'kungfu.mission-control.query-profile/v1';
    profile_hash: string;
    profile: {
      id: 'kungfu.mission-control';
      version: '3.0.0' | '3.1.0';
      reducer: 'kungfu.mission-control.five-questions';
      profile_suite_root: string;
      catalog_root: string;
      member_roots: Record<string, string>;
    };
    mission_subject: string;
    query_definition_root: string;
    query_proof_root: string;
    result_hash: string;
    query_receipt: {
      schema: 'kungfu.profile-query-receipt/v1';
      planId: string;
      profileSuiteRoot: string;
      catalogRoot: string;
      viewId: string;
      queryDefinitionRoot: string;
      queryProofRoot: string;
      result: Record<string, unknown>;
    };
    views: Array<{
      view_id: string;
      title: string;
      fact_surfaces: string[];
      query_family?: Record<string, unknown>;
      view: {
        kind: 'table' | 'timeline' | 'diff' | 'causal-graph' | 'attention';
      };
    }>;
    answers: Array<{
      question_id: string;
      question: string;
      status: string;
      summary: string;
      data: Record<string, unknown>;
    }>;
  };
  assessment: {
    state: string;
    reused?: boolean;
    report?: { purpose?: string; residual_risks?: string[] };
  };
  assessment_plan?: {
    schema: 'kungfu.profile-assessment-plan/v1';
    planId: string;
    profileSuiteRoot: string;
    catalogRoot: string;
  } | null;
  assessment_receipt?: {
    schema: 'kungfu.profile-assessment-receipt/v1';
    planId: string;
    authorizationId: string;
    profileSuiteRoot: string;
    catalogRoot: string;
  } | null;
  profile: {
    schema: 'kungfu.profile.delegated-work-cost-state-proof/v1';
    profile_hash: string;
    profile: { id: string; version: string };
    mission_subject: string;
    go_subject?: string | null;
    cost: {
      status: 'missing' | 'ambiguous' | 'partial' | 'attributed';
      observation_count: number;
      linked_run_count: number;
      tokens: {
        input_tokens: number;
        output_tokens: number;
        cached_input_tokens: number;
        cache_creation_input_tokens: number;
        reasoning_tokens: number;
      };
      cost_usd?: number | null;
      cost_usd_known: boolean;
      attribution: {
        best: string;
        worst: string;
        ambiguous: boolean;
      };
      proof_episodes: Array<{
        run_id: string;
        episode_id: string;
        episode_root: string;
      }>;
      missing: {
        unsealed_runs: string[];
        unreadable_runs: Array<{ run_id: string; error: string }>;
        no_linked_cost_fact: boolean;
      };
    };
    state: {
      value: string;
      source_statuses: string[];
      mapping_policy: string;
      go_subjects: string[];
    };
    proof: {
      canonical_state: boolean;
      query_definition_root: string;
      query_proof_root: string;
      query_result_hash: string;
      verified_fact_episode_roots?: string[];
      cost_episode_roots: Array<{
        run_id: string;
        episode_id: string;
        episode_root: string;
      }>;
      assessment_state: string;
      assessment_report_hash?: string | null;
      conflicts: unknown[];
      unverifiable_inputs: unknown[];
    };
  };
  state: {
    mission_subject: string;
    canonical_state: boolean;
    definition: QueryDefinition;
    profile_suite_root: string;
    catalog_root: string;
    cut: { declared?: unknown; resolved?: unknown };
    mission?: { payload?: { record?: AtlasMission } } | null;
    goals: Array<{ payload?: { record?: AtlasGoal } }>;
    claims?: Array<{
      payload?: {
        record?: {
          claim_id?: string;
          claim_type?: string;
          statement?: string;
          evidence_episodes?: Array<{
            episode_id: string;
            episode_root: string;
          }>;
        };
      };
    }>;
  };
};

export type AtlasMissionHome = Pick<
  AtlasMissionControlReport,
  | 'fitness'
  | 'findings'
  | 'known_limits'
  | 'state'
  | 'query_definition_root'
  | 'query_proof_root'
  | 'query_profile'
> & {
  schema: 'kungfu.mission-control.mission-home/v1';
  mode: 'read-only';
};

export type AtlasGoWrite = {
  schema: 'kungfu.mission-control.go-write/v1';
  authority_mode: 'kungfu-native';
  mission_subject: string;
  go_subject: string;
  receipt: {
    status: string;
    reused: boolean;
    observation_id: string;
    episode_id?: string;
  };
};

export type AtlasMissionWrite = {
  schema: 'kungfu.mission-control.mission-write/v1';
  authority_mode: 'kungfu-native';
  mission_subject: string;
  receipt: {
    status: string;
    reused: boolean;
    observation_id: string;
    episode_id?: string;
  };
};

export type InitiativeWrite = {
  schema: 'kungfu.initiative-assignment.initiative-write/v1';
  authority_mode: 'kungfu-native';
  initiative_subject: string;
  receipt: AtlasMissionWrite['receipt'];
};

export type AssignmentWrite = {
  schema: 'kungfu.initiative-assignment.assignment-write/v1';
  authority_mode: 'kungfu-native';
  initiative_subject: string;
  assignment_subject: string;
  receipt: AtlasGoWrite['receipt'];
};

export type AtlasMissionBundleExport = {
  schema: 'kungfu.mission-control.bundle-export/v1';
  status: 'portable' | 'degraded';
  mode: 'full' | 'thin';
  mission_subject: string;
  bundle_id: string;
  bundle_root: string;
  episode_count: number;
  out: string;
};

export type AtlasMissionBundleImport = {
  schema: 'kungfu.mission-control.bundle-import/v1';
  status: 'validated' | 'imported' | 'degraded';
  accepted: boolean;
  materialized: boolean;
  mode: 'full' | 'thin';
  mission_subject: string;
  bundle_id: string;
  bundle_root: string;
  episode_count: number;
  missing_material_count: number;
  diagnosis: string;
  state_verification?: {
    ok: boolean;
    query_definition_root_match: boolean;
    query_proof_root_match: boolean;
    result_hash_match: boolean;
    canonical_state: boolean;
  } | null;
};

export type AtlasCompletionClaimWrite = {
  schema: 'kungfu.mission-control.completion-claim-write/v1';
  authority_mode: 'kungfu-native';
  mission_subject: string;
  go_subject: string;
  claim: {
    claim_id: string;
    claim_type: 'task-completed';
    statement: string;
    evidence_episodes: Array<{ episode_id: string; episode_root: string }>;
  };
  receipt: {
    status: string;
    reused: boolean;
    observation_id: string;
    episode_id?: string;
  };
};

export type AtlasIndependentReview = {
  schema: 'kungfu.mission-control.independent-review/v1';
  review_root: string;
  continuation_plan_root: string;
  review: {
    review_id: string;
    claim_id: string;
    claimant: string;
    reviewer: string;
    reviewer_source: string;
    verdict:
      | 'fit'
      | 'partial'
      | 'insufficient'
      | 'conflicted'
      | 'stale'
      | 'unverifiable';
    findings: string[];
    continuation_plan: {
      allowed_actions: string[];
      evidence_requests: Array<Record<string, string>>;
      followups: Array<Record<string, unknown>>;
    };
  };
  trust_report: AtlasMissionControlReport;
};

export type AtlasContinuationDecision = {
  schema: 'kungfu.mission-control.continuation-decision/v1';
  decision: {
    decision_id: string;
    review_id: string;
    action: string;
  };
  created_followups: AtlasGoWrite[];
};

export type AtlasGoalFilter = {
  status?: string;
  missionId?: string;
};

export type Atlas = {
  runtimeDir: string;
  defaultRepoRoot: string;
  dashboard: () => Promise<AtlasDashboardSnapshot>;
  currentDashboard: () => AtlasDashboardSnapshot | null;
  importRepo: (repoRoot: string) => Promise<AtlasImportResult>;
  authorityStatus: () => Promise<AtlasAuthorityInspection>;
  cutoverAuthority: (input: {
    expectedParityRoot: string;
    projectCutRoot: string;
    atlasRoot: string;
    actor: string;
    actorType?: 'user' | 'agent';
    reason: string;
  }) => Promise<AtlasAuthorityTransition>;
  rollbackAuthority: (input: {
    expectedMigrationId: string;
    actor: string;
    actorType?: 'user' | 'agent';
    reason: string;
  }) => Promise<AtlasAuthorityTransition>;
  importInfo: () => AtlasImportInfo | null;
  missions: () => AtlasMission[];
  mission: (missionId: string) => AtlasMissionDetail | null;
  missionHome: (
    missionId: string,
    options?: { source?: string; cutSystemTime?: number },
  ) => Promise<AtlasMissionHome>;
  assessMission: (
    missionId: string,
    options?: { source?: string; purpose?: string; authorizedBy?: string },
  ) => Promise<AtlasMissionControlReport>;
  assessMissionAsync: (
    missionId: string,
    options?: { source?: string; purpose?: string; authorizedBy?: string },
  ) => Promise<AtlasMissionControlReport>;
  createInitiative: (
    initiativeId: string,
    input: {
      title: string;
      intent: string;
      actor: string;
      actorType?: 'user' | 'agent';
      status?: 'proposed' | 'active' | 'paused';
      horizon?: string;
    },
  ) => Promise<InitiativeWrite>;
  createMission: (
    missionId: string,
    input: {
      title: string;
      intent: string;
      actor: string;
      actorType?: 'user' | 'agent';
      status?: 'proposed' | 'active' | 'paused';
      horizon?: string;
    },
  ) => Promise<AtlasMissionWrite>;
  exportMission: (
    missionId: string,
    outPath: string,
    options?: { mode?: 'full' | 'thin'; source?: string; purpose?: string },
  ) => Promise<AtlasMissionBundleExport>;
  importMission: (
    fromPath: string,
    options?: { execute?: boolean },
  ) => Promise<AtlasMissionBundleImport>;
  createAssignment: (
    initiativeId: string,
    input: {
      assignmentId: string;
      title: string;
      objective: string;
      actor: string;
      actorType?: 'user' | 'agent';
      status?: 'proposed' | 'active' | 'blocked' | 'waiting-for-decision';
      parentAssignmentId?: string;
      dependsOn?: string[];
      responsibility?: string;
      acceptanceRoot?: string;
      atlasRoot?: string;
      projectCutRoot?: string;
      evidenceEpisodeRoots?: string[];
    },
  ) => Promise<AssignmentWrite>;
  createGo: (
    missionId: string,
    input: {
      goalId: string;
      title: string;
      objective: string;
      actor: string;
      actorType?: 'user' | 'agent';
      status?: 'proposed' | 'active' | 'blocked' | 'waiting-for-decision';
      parentGoalId?: string;
      dependsOn?: string[];
      responsibility?: string;
      acceptanceRoot?: string;
      atlasRoot?: string;
      projectCutRoot?: string;
      evidenceEpisodeRoots?: string[];
    },
  ) => Promise<AtlasGoWrite>;
  claimCompletion: (
    missionId: string,
    goalId: string,
    input: {
      statement: string;
      actor: string;
      actorType?: 'user' | 'agent';
      evidenceEpisodeIds?: string[];
      goSet?: string[];
      acceptanceRoot?: string;
      inputAtlasRoot?: string;
      resultAtlasRoot?: string;
      projectCutRoot?: string;
      projectCutReceiptRoot?: string;
      gitCommit?: string;
      gitTreeRoot?: string;
      proofRoots?: string[];
      knownGaps?: string[];
      evidenceAvailability?: Array<{
        acceptance: string;
        level: 'thin' | 'full';
        state: 'available' | 'unavailable' | 'missing';
      }>;
    },
  ) => Promise<AtlasCompletionClaimWrite>;
  assessCompletion: (
    missionId: string,
    goalId: string,
    options?: { source?: string; purpose?: string; authorizedBy?: string },
  ) => Promise<AtlasMissionControlReport>;
  assessCompletionAsync: (
    missionId: string,
    goalId: string,
    options?: { source?: string; purpose?: string; authorizedBy?: string },
  ) => Promise<AtlasMissionControlReport>;
  reviewCompletion: (
    missionId: string,
    goalId: string,
    input: {
      reviewer: string;
      reviewerSource: string;
      checkoutPath?: string;
      source?: string;
      purpose?: string;
      proposedFollowups?: Array<Record<string, unknown>>;
    },
  ) => Promise<AtlasIndependentReview>;
  decideContinuation: (
    missionId: string,
    goalId: string,
    input: {
      reviewId: string;
      expectedReviewRoot: string;
      expectedPlanRoot: string;
      action: string;
      actor: string;
      actorType?: 'user' | 'agent';
      changeClass?: string;
      source?: string;
      reason: string;
    },
  ) => Promise<AtlasContinuationDecision>;
  goals: (filter?: AtlasGoalFilter) => AtlasGoal[];
  goal: (goalId: string) => AtlasGoal | null;
  markers: () => AtlasMarker[];
};

type IntentExecutionReceipt<TResult> = ProfileIntentReceipt & {
  actionReceipt: {
    verified: boolean;
    coreReceipt: TResult;
  };
};

const PROFILE_ID = 'kungfu.mission-control';
const ADAPTER_MEMBER = 'mission-control-actions';

export function openMissionControlProfile(
  profile: Profile,
  defaultRepoRoot = '',
): Atlas {
  let dashboardSnapshot: AtlasDashboardSnapshot | null = null;
  const source = () => profile.discover(PROFILE_ID).source;
  const member = <TResult>(operation: string, input: unknown = {}) =>
    profile.memberCall<TResult>(source(), ADAPTER_MEMBER, operation, input)
      .result;
  const memberAsync = async <TResult>(operation: string, input: unknown = {}) =>
    (
      await profile.memberCallAsync<TResult>(
        source(),
        ADAPTER_MEMBER,
        operation,
        input,
      )
    ).result;
  const authorize = async <TResult>(
    intentId: string,
    input: unknown,
    authorizedBy: string,
  ) => {
    const profileSource = source();
    const plan = profile.intentPlan(profileSource, intentId, input);
    const receipt = (await profile.authorizeIntentAsync(
      profileSource,
      intentId,
      plan.planId,
      'approve',
      authorizedBy,
      input,
    )) as IntentExecutionReceipt<TResult>;
    if (!receipt.executionReceiptVerified || !receipt.actionReceipt.verified) {
      throw new Error(`Profile intent execution was not verified: ${intentId}`);
    }
    return receipt.actionReceipt.coreReceipt;
  };

  return {
    runtimeDir: profile.runtimeDir,
    defaultRepoRoot,
    dashboard: async () => {
      dashboardSnapshot =
        await memberAsync<AtlasDashboardSnapshot>('dashboard');
      return dashboardSnapshot;
    },
    currentDashboard: () => dashboardSnapshot,
    importRepo: (repoRoot) =>
      authorize<AtlasImportResult>(
        'import-atlas',
        { repo: repoRoot, source: 'atlas' },
        'work-dashboard',
      ),
    authorityStatus: () =>
      memberAsync<AtlasAuthorityInspection>('authority-status', {
        source: 'atlas',
      }),
    cutoverAuthority: (input) =>
      authorize<AtlasAuthorityTransition>(
        'cutover-authority',
        { source: 'atlas', ...input },
        input.actor,
      ),
    rollbackAuthority: (input) =>
      authorize<AtlasAuthorityTransition>(
        'rollback-authority',
        input,
        input.actor,
      ),
    importInfo: () => member<AtlasDashboardSnapshot>('dashboard').import_info,
    missions: () => member<AtlasDashboardSnapshot>('dashboard').missions,
    mission: (missionId) =>
      member<AtlasMissionDetail>('mission', { missionId }),
    missionHome: (missionId, options = {}) =>
      memberAsync<AtlasMissionHome>('mission-home', {
        missionId,
        source: options.source,
        cutSystemTime: options.cutSystemTime,
      }),
    assessMission: (missionId, assessment = {}) =>
      authorize<AtlasMissionControlReport>(
        'assess-progress',
        {
          missionId,
          source: assessment.source,
          purpose: assessment.purpose,
          authorizedBy: assessment.authorizedBy,
        },
        assessment.authorizedBy ?? 'work-dashboard',
      ),
    assessMissionAsync: (missionId, assessment = {}) =>
      authorize<AtlasMissionControlReport>(
        'assess-progress',
        {
          missionId,
          source: assessment.source,
          purpose: assessment.purpose,
          authorizedBy: assessment.authorizedBy,
        },
        assessment.authorizedBy ?? 'work-dashboard',
      ),
    createInitiative: (initiativeId, input) =>
      authorize<InitiativeWrite>(
        'create-initiative',
        { initiativeId, ...input },
        input.actor,
      ),
    createMission: (missionId, input) =>
      authorize<AtlasMissionWrite>(
        'create-mission',
        { missionId, ...input },
        input.actor,
      ),
    exportMission: (missionId, outPath, transfer = {}) =>
      authorize<AtlasMissionBundleExport>(
        'export-mission',
        { missionId, out: outPath, ...transfer },
        'work-dashboard',
      ),
    importMission: (fromPath, transfer = {}) =>
      authorize<AtlasMissionBundleImport>(
        'import-mission',
        { from: fromPath, ...transfer },
        'work-dashboard',
      ),
    createAssignment: (initiativeId, input) =>
      authorize<AssignmentWrite>(
        'create-assignment',
        { initiativeId, ...input },
        input.actor,
      ),
    createGo: (missionId, input) =>
      authorize<AtlasGoWrite>(
        'create-go',
        { missionId, ...input },
        input.actor,
      ),
    claimCompletion: (missionId, goalId, input) =>
      authorize<AtlasCompletionClaimWrite>(
        'claim-completion',
        { missionId, goalId, ...input },
        input.actor,
      ),
    assessCompletion: (missionId, goalId, assessment = {}) =>
      authorize<AtlasMissionControlReport>(
        'assess-progress',
        {
          missionId,
          goalId,
          source: assessment.source,
          purpose: assessment.purpose ?? 'handoff',
          authorizedBy: assessment.authorizedBy,
        },
        assessment.authorizedBy ?? 'work-dashboard',
      ),
    assessCompletionAsync: (missionId, goalId, assessment = {}) =>
      authorize<AtlasMissionControlReport>(
        'assess-progress',
        {
          missionId,
          goalId,
          source: assessment.source,
          purpose: assessment.purpose ?? 'handoff',
          authorizedBy: assessment.authorizedBy,
        },
        assessment.authorizedBy ?? 'work-dashboard',
      ),
    reviewCompletion: (missionId, goalId, input) =>
      authorize<AtlasIndependentReview>(
        'review-completion',
        { missionId, goalId, ...input },
        input.reviewer,
      ),
    decideContinuation: (missionId, goalId, input) =>
      authorize<AtlasContinuationDecision>(
        'decide-continuation',
        { missionId, goalId, ...input },
        input.actor,
      ),
    goals: (filter = {}) => member<AtlasGoal[]>('goals', filter),
    goal: (goalId) =>
      member<AtlasGoal[]>('goals').find((goal) => goal.goal_id === goalId) ??
      null,
    markers: () => member<AtlasMarker[]>('markers'),
  };
}
