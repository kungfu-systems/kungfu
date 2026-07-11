// Atlas-domain capability handle: call the existing read-only
// `kungfu atlas` CLI surface and expose its JSON projection to GUI/kfx views.
// Atlas remains the authority; this handle only imports and reads Kungfu's
// local projection.

export type AtlasMission = {
  mission_id: string;
  title?: string;
  status?: string;
  active_lens?: string;
  stage_name?: string;
  next_review?: string;
  next_action?: string;
};

export type AtlasGoal = {
  goal_id: string;
  status?: string;
  title?: string;
  owner_agent?: string;
  mission_id?: string;
  lens?: string;
  mission_stage?: string;
  source_branch?: string;
  worktree_path?: string;
  external_repo_path?: string;
  external_branch?: string;
  external_head?: string;
  external_ready_ref?: string;
  latest_marker?: string;
  summary?: string;
  next_action?: string;
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
  assessment: {
    state: string;
    reused?: boolean;
    report?: { purpose?: string; residual_risks?: string[] };
  };
  state: {
    mission_subject: string;
    canonical_state: boolean;
    cut: { declared?: unknown; resolved?: unknown };
    mission?: { payload?: { record?: AtlasMission } } | null;
    goals: Array<{ payload?: { record?: AtlasGoal } }>;
  };
};

export type AtlasGoalFilter = {
  status?: string;
  missionId?: string;
};

export type Atlas = {
  runtimeDir: string;
  defaultRepoRoot: string;
  importRepo: (repoRoot: string) => AtlasImportResult;
  importInfo: () => AtlasImportInfo | null;
  missions: () => AtlasMission[];
  mission: (missionId: string) => AtlasMissionDetail | null;
  assessMission: (
    missionId: string,
    options?: { source?: string; purpose?: string },
  ) => AtlasMissionControlReport;
  goals: (filter?: AtlasGoalFilter) => AtlasGoal[];
  goal: (goalId: string) => AtlasGoal | null;
  markers: () => AtlasMarker[];
};

export type AtlasExecFileSync = (
  file: string,
  args: string[],
  options: { encoding: 'utf8'; env: Record<string, string | undefined> },
) => string;

export type OpenAtlasOptions = {
  runtimeDir: string;
  execFileSync: AtlasExecFileSync;
  env?: Record<string, string | undefined>;
  bin?: string;
};

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

function cliEnv(
  base: Record<string, string | undefined>,
  runtimeDir: string,
): Record<string, string | undefined> {
  return {
    ...base,
    KF_RUNTIME_DIR: runtimeDir,
  };
}

function isNoCompletedImport(error: unknown): boolean {
  const stderr = String(
    (error as { stderr?: unknown; message?: unknown }).stderr ??
      (error as { message?: unknown }).message ??
      '',
  );
  return stderr.includes('no completed import');
}

export function openAtlas(options: OpenAtlasOptions): Atlas {
  const env = options.env ?? {};
  const runtimeDir = options.runtimeDir;
  const bin = options.bin || env.KUNGFU_CLI_BIN || env.KUNGFU_BIN || 'kungfu';
  const defaultRepoRoot = env.KUNGFU_ATLAS_REPO || env.ATLAS_REPO || '';

  const runJson = <T>(args: string[]): T => {
    const out = options.execFileSync(bin, args, {
      encoding: 'utf8',
      env: cliEnv(env, runtimeDir),
    });
    return parseJson<T>(out);
  };

  return {
    runtimeDir,
    defaultRepoRoot,
    importRepo: (repoRoot) =>
      runJson<AtlasImportResult>([
        'atlas',
        'import',
        '--repo',
        repoRoot,
        '--json',
      ]),
    importInfo: () => {
      try {
        return runJson<AtlasImportInfo>(['atlas', 'show', 'import', '--json']);
      } catch (e) {
        if (isNoCompletedImport(e)) return null;
        throw e;
      }
    },
    missions: () => {
      try {
        return runJson<AtlasMission[]>(['atlas', 'show', 'missions', '--json']);
      } catch (e) {
        if (isNoCompletedImport(e)) return [];
        throw e;
      }
    },
    mission: (missionId) => {
      try {
        return runJson<AtlasMissionDetail>([
          'atlas',
          'show',
          'mission',
          missionId,
          '--json',
        ]);
      } catch {
        return null;
      }
    },
    assessMission: (missionId, assessment = {}) => {
      const args = ['atlas', 'assess-mission', missionId, '--json'];
      if (assessment.source) args.push('--source', assessment.source);
      if (assessment.purpose) args.push('--purpose', assessment.purpose);
      return runJson<AtlasMissionControlReport>(args);
    },
    goals: (filter = {}) => {
      const args = ['atlas', 'show', 'goals', '--json'];
      if (filter.status) args.push('--status', filter.status);
      if (filter.missionId) args.push('--mission', filter.missionId);
      try {
        return runJson<AtlasGoal[]>(args);
      } catch (e) {
        if (isNoCompletedImport(e)) return [];
        throw e;
      }
    },
    goal: (goalId) => {
      try {
        return runJson<AtlasGoal>(['atlas', 'show', 'goal', goalId, '--json']);
      } catch {
        return null;
      }
    },
    markers: () => {
      try {
        return runJson<AtlasMarker[]>(['atlas', 'show', 'markers', '--json']);
      } catch (e) {
        if (isNoCompletedImport(e)) return [];
        throw e;
      }
    },
  };
}
