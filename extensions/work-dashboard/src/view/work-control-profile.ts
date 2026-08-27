import type {
  Profile,
  ProfileIntentReceipt,
  QueryDefinition,
} from '@kungfu-tech/api/capability';

// Work Control domain client over the public, exact-root Profile surface.
// Domain types live with this Profile KFX rather than in the generic API.

export type WorkControlInitiative = {
  initiative_id: string;
  title?: string;
  intent?: string;
  status?: string;
  horizon?: string;
  subject_key?: string;
  source_authority?: string;
  authority_mode?: string;
};

export type WorkControlAssignment = {
  assignment_id: string;
  status?: string;
  title?: string;
  owner_agent?: string;
  initiative_id?: string;
  responsibility?: string;
  summary?: string;
  next_action?: string;
};

export type WorkControlAuthorityState = {
  schema: 'kungfu.work-control.authority-status/v1';
  state: 'native-only';
  write_authority: 'kungfu-native';
  transition_count: number;
};

export type WorkControlAuthorityInspection = {
  authority: WorkControlAuthorityState;
};

export type WorkControlInitiativeDetail = {
  initiative: WorkControlInitiative;
  assignments: WorkControlAssignment[];
};

export type WorkControlAuthorityReport = {
  schema: 'kungfu.work-control.trust-report/v1';
  fitness: string;
  findings: string[];
  known_limits: string[];
  assessment_key: string;
  report_hash?: string;
  query_definition_root: string;
  query_proof_root: string;
  query_profile?: {
    schema: 'kungfu.work-control.query-profile/v1';
    profile_hash: string;
    profile: {
      id: 'kungfu.work-control';
      version: '3.0.0' | '3.1.0';
      reducer: 'kungfu.work-control.five-questions';
      profile_suite_root: string;
      catalog_root: string;
      member_roots: Record<string, string>;
    };
    initiative_subject: string;
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
    initiative_subject: string;
    assignment_subject?: string | null;
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
      assignment_subjects: string[];
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
    initiative_subject: string;
    canonical_state: boolean;
    definition: QueryDefinition;
    profile_suite_root: string;
    catalog_root: string;
    cut: { declared?: unknown; resolved?: unknown };
    initiative?: { payload?: { record?: WorkControlInitiative } } | null;
    assignments: Array<{ payload?: { record?: WorkControlAssignment } }>;
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

export type WorkControlInitiativeHome = Pick<
  WorkControlAuthorityReport,
  | 'fitness'
  | 'findings'
  | 'known_limits'
  | 'state'
  | 'query_definition_root'
  | 'query_proof_root'
  | 'query_profile'
> & {
  schema: 'kungfu.work-control.initiative-home/v1';
  mode: 'read-only';
};

export type WorkControlAssignmentWrite = {
  schema: 'kungfu.work-control.go-write/v1';
  authority_mode: 'kungfu-native';
  initiative_subject: string;
  assignment_subject: string;
  receipt: {
    status: string;
    reused: boolean;
    observation_id: string;
    episode_id?: string;
  };
};

export type WorkControlInitiativeWrite = {
  schema: 'kungfu.work-control.initiative-write/v1';
  authority_mode: 'kungfu-native';
  initiative_subject: string;
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
  receipt: WorkControlInitiativeWrite['receipt'];
};

export type AssignmentWrite = {
  schema: 'kungfu.initiative-assignment.assignment-write/v1';
  authority_mode: 'kungfu-native';
  initiative_subject: string;
  assignment_subject: string;
  receipt: WorkControlAssignmentWrite['receipt'];
};

export type AssignmentWorkRef = {
  schema: 'kungfu.assignment-graph.work-ref/v1';
  workspace_identity_root: string;
  object_kind: 'initiative' | 'assignment';
  subject: string;
  version_root: string;
  cut_root: string;
};

export type AssignmentRelation = {
  schema: 'kungfu.assignment-graph.relation/v1';
  relation_type: string;
  source: AssignmentWorkRef;
  target: AssignmentWorkRef;
  state: 'proposed' | 'accepted' | 'revoked';
  evidence_roots: string[];
  semantics: Record<string, boolean>;
  relation_root: string;
};

export type AssignmentRelationEventWrite = {
  schema: 'kungfu.assignment-graph.event-write/v1';
  event: Record<string, unknown>;
  receipt: Record<string, unknown>;
  next_action: string | null;
};

export type AssignmentExecutionClaim = {
  schema: 'kungfu.assignment-orchestration.execution-claim/v1';
  claim: {
    claim_id: string;
    assignment_id: string;
    lease_id: string;
    lease_expires_at: string;
  };
  receipt: Record<string, unknown>;
};

export type AssignmentPhaseTransition = {
  schema: 'kungfu.assignment-orchestration.phase-transition/v1';
  transition: {
    claim_id: string;
    assignment_subject: string;
    from_phase: string;
    to_phase: string;
    lease_id: string;
  };
  receipt: Record<string, unknown>;
};

export type WorkControlInitiativeBundleExport = {
  schema: 'kungfu.work-control.bundle-export/v1';
  status: 'portable' | 'degraded';
  mode: 'full' | 'thin';
  initiative_subject: string;
  bundle_id: string;
  bundle_root: string;
  episode_count: number;
  out: string;
};

export type WorkControlInitiativeBundleImport = {
  schema: 'kungfu.work-control.bundle-import/v1';
  status: 'validated' | 'imported' | 'degraded';
  accepted: boolean;
  materialized: boolean;
  mode: 'full' | 'thin';
  initiative_subject: string;
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

export type WorkControlCompletionClaimWrite = {
  schema: 'kungfu.work-control.completion-claim-write/v1';
  authority_mode: 'kungfu-native';
  initiative_subject: string;
  assignment_subject: string;
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

export type WorkControlIndependentReview = {
  schema: 'kungfu.work-control.independent-review/v1';
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
  trust_report: WorkControlAuthorityReport;
};

export type WorkControlContinuationDecision = {
  schema: 'kungfu.work-control.continuation-decision/v1';
  decision: {
    decision_id: string;
    review_id: string;
    action: string;
  };
  created_followups: WorkControlAssignmentWrite[];
};

export type WorkControlAssignmentFilter = {
  status?: string;
  initiativeId?: string;
};

export type WorkSemanticsWriteReceipt = {
  schema: 'kungfu.work-semantics.write-receipt/v1';
  record: Record<string, unknown> & { record_root: string };
  receipt: Record<string, unknown>;
};

type WorkSemanticsExecutionInput = {
  attemptId: string;
  leaseId: string;
  actor: string;
  actorType?: 'user' | 'agent';
  source?: string;
};

export type WorkControl = {
  runtimeDir: string;
  defaultRepoRoot: string;
  authorityStatus: () => Promise<WorkControlAuthorityInspection>;
  initiatives: () => WorkControlInitiative[];
  initiative: (initiativeId: string) => WorkControlInitiativeDetail | null;
  initiativeHome: (
    initiativeId: string,
    options?: { source?: string; cutSystemTime?: number },
  ) => Promise<WorkControlInitiativeHome>;
  assessInitiative: (
    initiativeId: string,
    options?: { source?: string; purpose?: string; authorizedBy?: string },
  ) => Promise<WorkControlAuthorityReport>;
  assessInitiativeAsync: (
    initiativeId: string,
    options?: { source?: string; purpose?: string; authorizedBy?: string },
  ) => Promise<WorkControlAuthorityReport>;
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
  exportInitiative: (
    initiativeId: string,
    outPath: string,
    options?: { mode?: 'full' | 'thin'; source?: string; purpose?: string },
  ) => Promise<WorkControlInitiativeBundleExport>;
  importInitiative: (
    fromPath: string,
    options?: { execute?: boolean },
  ) => Promise<WorkControlInitiativeBundleImport>;
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
      owningWorkspaceIdentityRoot?: string;
      initiativeRef?: AssignmentWorkRef;
      parentAssignmentRef?: AssignmentWorkRef;
      dependencyRefs?: AssignmentWorkRef[];
      responsibility?: string;
      acceptanceRoot?: string;
      contextRoot?: string;
      projectCutRoot?: string;
      evidenceEpisodeRoots?: string[];
    },
  ) => Promise<AssignmentWrite>;
  appendAssignmentRelationEvent: (input: {
    workspaceIdentityRoot: string;
    relation: AssignmentRelation;
    eventType:
      | 'delegation-offer'
      | 'destination-acceptance'
      | 'source-observation'
      | 'child-contribution'
      | 'parent-admission'
      | 'parent-assessment'
      | 'parent-decision';
    actor: string;
    actorType?: 'user' | 'agent';
    predecessorEventRoots?: string[];
    evidenceRoots?: string[];
    knownRelations?: AssignmentRelation[];
  }) => Promise<AssignmentRelationEventWrite>;
  claimAssignment: (
    initiativeId: string,
    assignmentId: string,
    input: {
      owner: string;
      agent: string;
      slot: string;
      leaseId: string;
      leaseExpiresAt: string;
      authorizedBy: string;
      grantScope?: string;
      actorType?: 'user' | 'agent';
      source?: string;
    },
  ) => Promise<AssignmentExecutionClaim>;
  advanceAssignment: (
    initiativeId: string,
    assignmentId: string,
    input: {
      toPhase: string;
      expectedPhase?: string;
      actor: string;
      actorType?: 'user' | 'agent';
      reason: string;
      source?: string;
    },
  ) => Promise<AssignmentPhaseTransition>;
  claimCompletion: (
    initiativeId: string,
    assignmentId: string,
    input: {
      statement: string;
      actor: string;
      actorType?: 'user' | 'agent';
      evidenceEpisodeIds?: string[];
      assignmentSet?: string[];
      acceptanceRoot?: string;
      inputContextRoot?: string;
      resultContextRoot?: string;
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
  ) => Promise<WorkControlCompletionClaimWrite>;
  assessCompletion: (
    initiativeId: string,
    assignmentId: string,
    options?: { source?: string; purpose?: string; authorizedBy?: string },
  ) => Promise<WorkControlAuthorityReport>;
  assessCompletionAsync: (
    initiativeId: string,
    assignmentId: string,
    options?: { source?: string; purpose?: string; authorizedBy?: string },
  ) => Promise<WorkControlAuthorityReport>;
  reviewCompletion: (
    initiativeId: string,
    assignmentId: string,
    input: {
      reviewer: string;
      reviewerSource: string;
      checkoutPath?: string;
      source?: string;
      purpose?: string;
      proposedFollowups?: Array<Record<string, unknown>>;
    },
  ) => Promise<WorkControlIndependentReview>;
  decideContinuation: (
    initiativeId: string,
    assignmentId: string,
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
  ) => Promise<WorkControlContinuationDecision>;
  recordWorkInputSnapshot: (
    initiativeId: string,
    assignmentId: string,
    input: WorkSemanticsExecutionInput & {
      snapshotId: string;
      inputRoot: string;
      evidenceRoots?: string[];
    },
  ) => Promise<WorkSemanticsWriteReceipt>;
  recordWorkManagedRun: (
    initiativeId: string,
    assignmentId: string,
    input: WorkSemanticsExecutionInput & {
      runId: string;
      inputSnapshotRoot: string;
      role: string;
      resultState: 'succeeded' | 'failed' | 'cancelled';
      resultRoot: string;
      evidenceRoots?: string[];
    },
  ) => Promise<WorkSemanticsWriteReceipt>;
  authorizeWorkEffect: (
    initiativeId: string,
    assignmentId: string,
    input: WorkSemanticsExecutionInput & {
      authorizationId: string;
      effectId: string;
      effectKind: string;
      inputSnapshotRoot: string;
      scopeRoot: string;
      evidenceRoots?: string[];
    },
  ) => Promise<WorkSemanticsWriteReceipt>;
  recordWorkEffectAttempt: (
    initiativeId: string,
    assignmentId: string,
    input: WorkSemanticsExecutionInput & {
      effectAttemptId: string;
      authorizationRoot: string;
      transportRequestRoot: string;
    },
  ) => Promise<WorkSemanticsWriteReceipt>;
  recordWorkEffectOutcome: (
    initiativeId: string,
    assignmentId: string,
    input: WorkSemanticsExecutionInput & {
      effectAttemptRoot: string;
      transportState: 'unknown' | 'rejected' | 'accepted';
      businessState: 'unknown' | 'rejected' | 'accepted' | 'not-applicable';
      outcomeRoot: string;
      evidenceRoots?: string[];
    },
  ) => Promise<WorkSemanticsWriteReceipt>;
  assignments: (
    filter?: WorkControlAssignmentFilter,
  ) => WorkControlAssignment[];
  assignment: (assignmentId: string) => WorkControlAssignment | null;
};

const PROFILE_ID = 'kungfu.work-control';
const ADAPTER_MEMBER = 'work-control-actions';

type IntentExecutionReceipt<TResult> = ProfileIntentReceipt & {
  actionReceipt: {
    verified: boolean;
    coreReceipt: TResult;
  };
};

type WorkControlProfileOptions = {
  mutationAuthority?: 'reject' | 'kfd3-application';
};

function directMutationRejected(intentId: string): Error {
  const error = new Error(
    `Direct GUI Profile mutation is read-only native client: ${intentId}; use kungfu.assignment-runtime/v1`,
  ) as Error & { code?: string };
  error.code = 'authority-bypass';
  return error;
}

export function openWorkControlProfile(
  profile: Profile,
  defaultRepoRoot = '',
  options: WorkControlProfileOptions = {},
): WorkControl {
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
  ): Promise<TResult> => {
    if (options.mutationAuthority !== 'kfd3-application') {
      throw directMutationRejected(intentId);
    }
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
    authorityStatus: () =>
      memberAsync<WorkControlAuthorityInspection>('authority-status'),
    initiatives: () => member<WorkControlInitiative[]>('initiatives'),
    initiative: (initiativeId) =>
      member<WorkControlInitiativeDetail>('initiative-state', { initiativeId }),
    initiativeHome: (initiativeId, options = {}) =>
      memberAsync<WorkControlInitiativeHome>('initiative-home', {
        initiativeId,
        source: options.source,
        cutSystemTime: options.cutSystemTime,
      }),
    assessInitiative: (initiativeId, assessment = {}) =>
      authorize<WorkControlAuthorityReport>(
        'assess-progress',
        {
          initiativeId: initiativeId,
          source: assessment.source,
          purpose: assessment.purpose,
          authorizedBy: assessment.authorizedBy,
        },
        assessment.authorizedBy ?? 'work-dashboard',
      ),
    assessInitiativeAsync: (initiativeId, assessment = {}) =>
      authorize<WorkControlAuthorityReport>(
        'assess-progress',
        {
          initiativeId: initiativeId,
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
    exportInitiative: (initiativeId, outPath, transfer = {}) =>
      authorize<WorkControlInitiativeBundleExport>(
        'export-initiative',
        { initiativeId: initiativeId, out: outPath, ...transfer },
        'work-dashboard',
      ),
    importInitiative: (fromPath, transfer = {}) =>
      authorize<WorkControlInitiativeBundleImport>(
        'import-initiative',
        { from: fromPath, ...transfer },
        'work-dashboard',
      ),
    createAssignment: (initiativeId, input) =>
      authorize<AssignmentWrite>(
        'create-assignment',
        { initiativeId, ...input },
        input.actor,
      ),
    appendAssignmentRelationEvent: (input) =>
      authorize<AssignmentRelationEventWrite>(
        'append-assignment-relation-event',
        input,
        input.actor,
      ),
    claimAssignment: (initiativeId, assignmentId, input) =>
      authorize<AssignmentExecutionClaim>(
        'claim-assignment',
        { initiativeId, assignmentId, ...input },
        input.authorizedBy,
      ),
    advanceAssignment: (initiativeId, assignmentId, input) =>
      authorize<AssignmentPhaseTransition>(
        'advance-assignment',
        { initiativeId, assignmentId, ...input },
        input.actor,
      ),
    claimCompletion: (initiativeId, assignmentId, input) =>
      authorize<WorkControlCompletionClaimWrite>(
        'claim-completion',
        { initiativeId: initiativeId, assignmentId: assignmentId, ...input },
        input.actor,
      ),
    assessCompletion: (initiativeId, assignmentId, assessment = {}) =>
      authorize<WorkControlAuthorityReport>(
        'assess-progress',
        {
          initiativeId: initiativeId,
          assignmentId: assignmentId,
          source: assessment.source,
          purpose: assessment.purpose ?? 'handoff',
          authorizedBy: assessment.authorizedBy,
        },
        assessment.authorizedBy ?? 'work-dashboard',
      ),
    assessCompletionAsync: (initiativeId, assignmentId, assessment = {}) =>
      authorize<WorkControlAuthorityReport>(
        'assess-progress',
        {
          initiativeId: initiativeId,
          assignmentId: assignmentId,
          source: assessment.source,
          purpose: assessment.purpose ?? 'handoff',
          authorizedBy: assessment.authorizedBy,
        },
        assessment.authorizedBy ?? 'work-dashboard',
      ),
    reviewCompletion: (initiativeId, assignmentId, input) =>
      authorize<WorkControlIndependentReview>(
        'review-completion',
        { initiativeId: initiativeId, assignmentId: assignmentId, ...input },
        input.reviewer,
      ),
    decideContinuation: (initiativeId, assignmentId, input) =>
      authorize<WorkControlContinuationDecision>(
        'decide-continuation',
        { initiativeId: initiativeId, assignmentId: assignmentId, ...input },
        input.actor,
      ),
    recordWorkInputSnapshot: (initiativeId, assignmentId, input) =>
      authorize<WorkSemanticsWriteReceipt>(
        'work-input-snapshot',
        { initiativeId, assignmentId, ...input },
        input.actor,
      ),
    recordWorkManagedRun: (initiativeId, assignmentId, input) =>
      authorize<WorkSemanticsWriteReceipt>(
        'work-managed-run',
        { initiativeId, assignmentId, ...input },
        input.actor,
      ),
    authorizeWorkEffect: (initiativeId, assignmentId, input) =>
      authorize<WorkSemanticsWriteReceipt>(
        'work-effect-authorize',
        { initiativeId, assignmentId, ...input },
        input.actor,
      ),
    recordWorkEffectAttempt: (initiativeId, assignmentId, input) =>
      authorize<WorkSemanticsWriteReceipt>(
        'work-effect-attempt',
        { initiativeId, assignmentId, ...input },
        input.actor,
      ),
    recordWorkEffectOutcome: (initiativeId, assignmentId, input) =>
      authorize<WorkSemanticsWriteReceipt>(
        'work-effect-outcome',
        { initiativeId, assignmentId, ...input },
        input.actor,
      ),
    assignments: (filter = {}) =>
      member<WorkControlAssignment[]>('assignments', filter),
    assignment: (assignmentId) =>
      member<WorkControlAssignment[]>('assignments').find(
        (assignment) => assignment.assignment_id === assignmentId,
      ) ?? null,
  };
}

// KFD-3 factory qualification owns this separate, explicitly injected Profile
// application surface. It is never selected as a fallback by the production
// Work Dashboard, whose only Assignment authority is openProfileApplication().
export function openKfd3ProfileApplication(
  profile: Profile,
  defaultRepoRoot = '',
) {
  const application = openWorkControlProfile(profile, defaultRepoRoot, {
    mutationAuthority: 'kfd3-application',
  });
  return {
    createInitiative: (
      ...args: Parameters<typeof application.createInitiative>
    ) => application.createInitiative(...args),
    createAssignment: (
      ...args: Parameters<typeof application.createAssignment>
    ) => application.createAssignment(...args),
    appendAssignmentRelationEvent: (
      ...args: Parameters<typeof application.appendAssignmentRelationEvent>
    ) => application.appendAssignmentRelationEvent(...args),
    claimAssignment: (
      ...args: Parameters<typeof application.claimAssignment>
    ) => application.claimAssignment(...args),
    advanceAssignment: (
      ...args: Parameters<typeof application.advanceAssignment>
    ) => application.advanceAssignment(...args),
    claimCompletion: (
      ...args: Parameters<typeof application.claimCompletion>
    ) => application.claimCompletion(...args),
    assessInitiativeAsync: (
      ...args: Parameters<typeof application.assessInitiativeAsync>
    ) => application.assessInitiativeAsync(...args),
    reviewCompletion: (
      ...args: Parameters<typeof application.reviewCompletion>
    ) => application.reviewCompletion(...args),
    decideContinuation: (
      ...args: Parameters<typeof application.decideContinuation>
    ) => application.decideContinuation(...args),
    recordWorkInputSnapshot: (
      ...args: Parameters<typeof application.recordWorkInputSnapshot>
    ) => application.recordWorkInputSnapshot(...args),
    recordWorkManagedRun: (
      ...args: Parameters<typeof application.recordWorkManagedRun>
    ) => application.recordWorkManagedRun(...args),
    authorizeWorkEffect: (
      ...args: Parameters<typeof application.authorizeWorkEffect>
    ) => application.authorizeWorkEffect(...args),
    recordWorkEffectAttempt: (
      ...args: Parameters<typeof application.recordWorkEffectAttempt>
    ) => application.recordWorkEffectAttempt(...args),
    recordWorkEffectOutcome: (
      ...args: Parameters<typeof application.recordWorkEffectOutcome>
    ) => application.recordWorkEffectOutcome(...args),
    exportInitiative: (
      ...args: Parameters<typeof application.exportInitiative>
    ) => application.exportInitiative(...args),
    importInitiative: (
      ...args: Parameters<typeof application.importInitiative>
    ) => application.importInitiative(...args),
    intentPlan: (...args: Parameters<typeof profile.intentPlan>) =>
      profile.intentPlan(...args),
  };
}
