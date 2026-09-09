// SPDX-License-Identifier: Apache-2.0
// @ts-check

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DEV_CHANNEL_CONTRACT = path.join(
  ROOT,
  'docs',
  'qualification',
  'gates',
  'dev-queue-admission.contract.json',
);
const EXACT_DEV_BRANCH = /dev\/v\d+\/v\d+\.\d+/gu;
const DEV_CHANNEL_GOVERNED_ROOTS = [
  '.github/workflows',
  'scripts',
  'crates/shifu/src',
  'framework/core/src/python/kungfu',
];
const DEV_CHANNEL_GOVERNED_FILES = [
  '.github/alpha-attention-operations.json',
  'docs/qualification/gates/README.md',
  'docs/shifu/artifact-contract.json',
  'developer/maintainability/code-complexity-policy.json',
];

/** @param {string} value */
function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
}

/** @param {string} pattern */
function branchPatternRegex(pattern) {
  return new RegExp(
    `^${pattern
      .split('*')
      .map((part) => escapeRegex(part))
      .join('[^/]*')}$`,
    'u',
  );
}

/** @param {string} [root] */
function readDevChannelContract(root = ROOT) {
  const contractPath =
    root === ROOT
      ? DEV_CHANNEL_CONTRACT
      : path.join(
          root,
          'docs',
          'qualification',
          'gates',
          'dev-queue-admission.contract.json',
        );
  return JSON.parse(fs.readFileSync(contractPath, 'utf8'));
}

/**
 * @param {string} branch
 * @param {ReturnType<typeof readDevChannelContract>} [contract]
 */
function isAdmittedDevBranch(branch, contract = readDevChannelContract()) {
  const normalized = branch
    .replace(/^refs\/heads\//u, '')
    .replace(/^refs\/remotes\/origin\//u, '')
    .replace(/^origin\//u, '');
  const match = normalized.match(/^dev\/v(\d+)\/v(\d+)\.(\d+)$/u);
  return Boolean(
    match &&
      branchPatternRegex(contract.branchPattern).test(normalized) &&
      Number(match[1]) >= Number(contract.admittedFamily?.minimumMajor),
  );
}

/** @param {string[]} args */
function gitMaybe(args) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

/** @param {NodeJS.ProcessEnv} env */
function eventBranches(env) {
  if (!env.GITHUB_EVENT_PATH) return [];
  try {
    const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    return [
      event.pull_request?.base?.ref,
      event.merge_group?.base_ref,
      event.repository?.default_branch,
    ].filter((value) => typeof value === 'string' && value);
  } catch {
    return [];
  }
}

/**
 * Resolve the active development line without naming a version in source.
 * CI event authority wins, followed by the repository's remote default branch.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   symbolicRemoteHead?: () => string,
 *   contract?: ReturnType<typeof readDevChannelContract>
 * }} [options]
 */
function resolveDevBranch(options = {}) {
  const env = options.env ?? process.env;
  const contract = options.contract ?? readDevChannelContract();
  const symbolicRemoteHead =
    options.symbolicRemoteHead ??
    (() => gitMaybe(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']));
  const candidates = [
    env.KUNGFU_DEV_BRANCH,
    env.GITHUB_BASE_REF,
    ...eventBranches(env),
    symbolicRemoteHead(),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const branch = candidate
      .replace(/^refs\/heads\//u, '')
      .replace(/^refs\/remotes\/origin\//u, '')
      .replace(/^origin\//u, '');
    if (isAdmittedDevBranch(branch, contract)) return branch;
  }
  throw new Error(
    'cannot resolve the admitted dev branch; set KUNGFU_DEV_BRANCH or fetch origin/HEAD',
  );
}

/** @param {Parameters<typeof resolveDevBranch>[0]} [options] */
function devMergeBaseCandidates(options = {}) {
  const branch = resolveDevBranch(options);
  return [`origin/${branch}`, branch, 'origin/HEAD'];
}

/** @param {string} pathname */
function isDevChannelGovernedSource(pathname) {
  const basename = path.basename(pathname);
  const segments = pathname.split(path.sep);
  return (
    !basename.includes('.test.') &&
    !basename.includes('.spec.') &&
    !segments.includes('tests') &&
    !segments.includes('fixtures') &&
    /\.(?:cjs|js|json|mjs|py|rs|ya?ml|md)$/u.test(pathname)
  );
}

/** @param {string} root @param {string} relative */
function filesBelow(root, relative) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return [];
  const pending = [absolute];
  const files = [];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const pathname = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(pathname);
      else if (entry.isFile() && isDevChannelGovernedSource(pathname))
        files.push(pathname);
    }
  }
  return files;
}

/** @param {string} [root] */
function findOperationalExactBindings(root = ROOT) {
  const files = [
    ...DEV_CHANNEL_GOVERNED_ROOTS.flatMap((relative) =>
      filesBelow(root, relative),
    ),
    ...DEV_CHANNEL_GOVERNED_FILES.map((relative) =>
      path.join(root, relative),
    ).filter((pathname) => fs.existsSync(pathname)),
  ];
  return [...new Set(files)].flatMap((pathname) => {
    const relative = path.relative(root, pathname).split(path.sep).join('/');
    return [
      ...fs.readFileSync(pathname, 'utf8').matchAll(EXACT_DEV_BRANCH),
    ].map((match) => ({ path: relative, branch: match[0] }));
  });
}

/** @param {string} [root] */
function checkDevChannelAuthority(root = ROOT) {
  const issues = [];
  const contract = readDevChannelContract(root);
  const activation = contract.rulesetActivation;
  const operations = JSON.parse(
    fs.readFileSync(
      path.join(root, '.github', 'alpha-attention-operations.json'),
      'utf8',
    ),
  );
  const expectedFamilyInclude = ['refs/heads/dev/v*/v*'];
  const expectedFamilyExclude = [
    'refs/heads/dev/v1/v*',
    'refs/heads/dev/v2/v*',
    'refs/heads/dev/v3/v*',
  ];
  const expectedRulesetInclude = ['~DEFAULT_BRANCH'];
  const expectedRulesetExclude = [];
  if (
    contract.branchPattern !== 'dev/v*/v*' ||
    contract.admittedFamily?.minimumMajor !== 4 ||
    JSON.stringify(contract.admittedFamily?.include) !==
      JSON.stringify(expectedFamilyInclude) ||
    JSON.stringify(contract.admittedFamily?.exclude) !==
      JSON.stringify(expectedFamilyExclude) ||
    JSON.stringify(activation?.target?.include) !==
      JSON.stringify(expectedRulesetInclude) ||
    JSON.stringify(activation?.target?.exclude) !==
      JSON.stringify(expectedRulesetExclude)
  )
    issues.push('admitted dev family or default-branch ruleset target drifted');
  if (
    activation?.rulesetId !== 19057118 ||
    activation?.rulesetName !==
      'Buildchain dev merge queue: admitted default dev channel' ||
    !operations.activation?.requiredActiveRulesets?.includes(
      activation?.rulesetName,
    )
  )
    issues.push('default dev ruleset identity drifted');
  if (
    !isAdmittedDevBranch(`dev/v${4}/v${4}.0`, contract) ||
    !isAdmittedDevBranch(`dev/v${10}/v${10}.2`, contract) ||
    isAdmittedDevBranch(`dev/v${3}/v${3}.2`, contract)
  )
    issues.push('dev family admission examples do not match the contract');
  for (const binding of findOperationalExactBindings(root))
    issues.push(
      `${binding.path} binds operational behavior to ${binding.branch}`,
    );
  return {
    schema: 'kungfu.dev-channel-authority-check/v1',
    verdict: issues.length ? 'fail' : 'pass',
    issues,
    rulesetId: activation?.rulesetId ?? null,
    rulesetName: activation?.rulesetName ?? null,
    target: activation?.target ?? null,
  };
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, entry]) => entry !== undefined && entry !== '',
    ),
  );
}

function attempt(env = process.env) {
  const runId = env.GITHUB_RUN_ID || 'local';
  const eventName = env.GITHUB_EVENT_NAME || 'local';
  return compact({
    id: env.KUNGFU_CANDIDATE_ATTEMPT_ID || `${eventName}-${runId}`,
    index: /^\d+$/.test(env.KUNGFU_CANDIDATE_ATTEMPT_INDEX || '')
      ? Number(env.KUNGFU_CANDIDATE_ATTEMPT_INDEX)
      : undefined,
    kind:
      eventName === 'merge_group'
        ? 'merge-queue'
        : eventName === 'pull_request'
          ? 'pull-request'
          : 'local',
    mergeGroupSha: eventName === 'merge_group' ? env.GITHUB_SHA : undefined,
    workflowRunId: env.GITHUB_RUN_ID,
  });
}

function eventId(id, env = process.env) {
  const partition = env.KUNGFU_AFFECTED_NATIVE_PARTITION_INDEX || 'none';
  return `${attempt(env).id}:${process.platform}:${partition}:${id}`;
}

function appendEvent(event, env = process.env) {
  const output = env.KUNGFU_CANDIDATE_TIMELINE_EVENTS || '';
  if (!output) return;
  const target = path.resolve(output);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${JSON.stringify(event)}\n`);
}

function buildEvent(id, phase, startedAt, started, status, options = {}) {
  const env = options.env || process.env;
  const completedAt = new Date().toISOString();
  return compact({
    id: eventId(id, env),
    attempt: attempt(env),
    phase,
    category: options.category || 'stage',
    status,
    gate: compact({
      id: options.gateId || env.KUNGFU_CANDIDATE_GATE_ID || undefined,
      platform: options.platform || `${process.platform}-${process.arch}`,
      partition: env.KUNGFU_AFFECTED_NATIVE_PARTITION_INDEX,
    }),
    span: options.parentId
      ? { id: eventId(id, env), parentId: eventId(options.parentId, env) }
      : { id: eventId(id, env) },
    execution: compact({
      boundary: options.boundary || 'process',
      runner: env.RUNNER_NAME,
    }),
    timing: {
      startedAt,
      completedAt,
      durationMs: Math.round((performance.now() - started) * 1000) / 1000,
      clock: 'monotonic-duration+wall-envelope',
      precisionMs: 1,
      authority: 'kungfu-process-stage',
    },
    criticalPathEligible: options.criticalPathEligible !== false,
    attributes: compact({
      sourceSha: env.GITHUB_SHA,
      language: options.language,
      laneId:
        env.KUNGFU_AFFECTED_NATIVE_PARTITION_INDEX === undefined
          ? undefined
          : `affected-native/partition-${env.KUNGFU_AFFECTED_NATIVE_PARTITION_INDEX}`,
      stage: id,
    }),
  });
}

function measureCandidateStageSync(id, phase, callback, options = {}) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const result = callback();
    appendEvent(
      buildEvent(id, phase, startedAt, started, 'success', options),
      options.env,
    );
    return result;
  } catch (error) {
    appendEvent(
      buildEvent(id, phase, startedAt, started, 'failure', options),
      options.env,
    );
    throw error;
  }
}

async function measureCandidateStage(id, phase, callback, options = {}) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const result = await callback();
    appendEvent(
      buildEvent(id, phase, startedAt, started, 'success', options),
      options.env,
    );
    return result;
  } catch (error) {
    appendEvent(
      buildEvent(id, phase, startedAt, started, 'failure', options),
      options.env,
    );
    throw error;
  }
}

function incompleteRequiredWindow(reason, diagnostics = []) {
  return {
    status: 'incomplete',
    authority:
      'github-graphql-first-added-to-merge-queue+github-actions-merged-round-required-jobs',
    startAuthority: 'github-graphql-first-added-to-merge-queue',
    endAuthority: 'first-successful-merged-round-required-context-set',
    reason,
    diagnostics,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    queueRoundIndex: null,
    workflowRunId: null,
    workflowHeadSha: null,
    contexts: [],
  };
}

function requiredMergeQueueWindow(requiredContexts, mergeQueue) {
  const contexts = [...new Set(requiredContexts || [])].filter(Boolean).sort();
  if (!contexts.length) {
    return incompleteRequiredWindow('required context set is empty');
  }
  if (
    mergeQueue?.queueStatus !== 'observed' ||
    mergeQueue?.status !== 'observed'
  ) {
    return incompleteRequiredWindow(
      'authoritative merge queue delivery evidence is incomplete',
      mergeQueue?.diagnostics || [],
    );
  }
  const startedAt = mergeQueue.firstEnqueuedAt;
  const startedAtMs = Date.parse(startedAt);
  const mergedAtMs = Date.parse(mergeQueue.mergedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(mergedAtMs)) {
    return incompleteRequiredWindow(
      'first enqueue or merge timestamp is missing or invalid',
    );
  }
  const mergedRounds = (mergeQueue.rounds || []).filter(
    ({ reason }) => reason === 'merged',
  );
  if (
    mergedRounds.length !== 1 ||
    mergeQueue.rounds.at(-1) !== mergedRounds[0]
  ) {
    return incompleteRequiredWindow(
      'eventual merged queue round is missing or ambiguous',
    );
  }
  const mergedRound = mergedRounds[0];
  const roundEndMs = Date.parse(mergedRound.removedAt);
  if (
    !Number.isFinite(roundEndMs) ||
    roundEndMs < startedAtMs ||
    mergedAtMs < startedAtMs
  ) {
    return incompleteRequiredWindow(
      'merged queue or pull request timestamps have invalid chronology',
    );
  }

  const diagnostics = [];
  const selectedContexts = [];
  for (const context of contexts) {
    const candidates = [];
    for (const run of mergedRound.mergeGroupRuns || []) {
      const matches = (run.jobs || []).filter(({ name }) => name === context);
      if (matches.length > 1) {
        return incompleteRequiredWindow(
          `required context is ambiguous in merged queue run: ${context}`,
          [`workflow-run-${run.id}-duplicate-${context}`],
        );
      }
      const job = matches[0];
      if (!job || job.status !== 'completed' || job.conclusion !== 'success') {
        diagnostics.push(`workflow-run-${run.id}-missing-success-${context}`);
        continue;
      }
      const completedAtMs = Date.parse(job.completedAt);
      if (
        !Number.isFinite(completedAtMs) ||
        completedAtMs < startedAtMs ||
        completedAtMs > roundEndMs ||
        completedAtMs > mergedAtMs
      ) {
        return incompleteRequiredWindow(
          `required context has invalid queue chronology: ${context}`,
          [`workflow-run-${run.id}-invalid-completion-${context}`],
        );
      }
      candidates.push({
        context,
        jobId: job.id,
        workflowRunId: run.id,
        workflowHeadSha: run.headSha,
        startedAt: job.startedAt || null,
        completedAt: job.completedAt,
        completedAtMs,
        conclusion: job.conclusion,
      });
    }
    if (!candidates.length) {
      return incompleteRequiredWindow(
        'eventual merged queue round has no complete successful required-context set',
        diagnostics,
      );
    }
    candidates.sort(
      (left, right) =>
        left.completedAtMs - right.completedAtMs ||
        Number(left.workflowRunId) - Number(right.workflowRunId),
    );
    selectedContexts.push(candidates[0]);
  }
  const selectedHeadShas = [
    ...new Set(selectedContexts.map(({ workflowHeadSha }) => workflowHeadSha)),
  ];
  if (selectedHeadShas.length !== 1 || !selectedHeadShas[0]) {
    return incompleteRequiredWindow(
      'successful required contexts disagree on merge-group source',
      selectedHeadShas.map(
        (sha) => `required-context-source-${sha || 'missing'}`,
      ),
    );
  }
  selectedContexts.sort(
    (left, right) =>
      left.completedAtMs - right.completedAtMs ||
      Number(left.workflowRunId) - Number(right.workflowRunId),
  );
  const finalContext = selectedContexts.at(-1);
  return {
    status: 'observed',
    authority:
      'github-graphql-first-added-to-merge-queue+github-actions-merged-round-required-jobs',
    startAuthority: 'github-graphql-first-added-to-merge-queue',
    endAuthority: 'first-successful-merged-round-required-context-set',
    reason: 'complete successful required-context set observed',
    diagnostics,
    startedAt,
    completedAt: finalContext.completedAt,
    durationMs:
      new Date(finalContext.completedAt).getTime() -
      new Date(startedAt).getTime(),
    queueRoundIndex: mergedRound.index,
    workflowRunId: finalContext.workflowRunId,
    workflowHeadSha: finalContext.workflowHeadSha,
    workflowRunIds: [
      ...new Set(selectedContexts.map(({ workflowRunId }) => workflowRunId)),
    ],
    contexts: selectedContexts.map(({ completedAtMs, ...context }) => context),
    priorQueueRoundCount: Math.max(0, (mergeQueue.rounds || []).length - 1),
  };
}

function latestMergedPulls(pulls, limit) {
  return pulls
    .filter(({ merged_at: mergedAt }) => Number.isFinite(Date.parse(mergedAt)))
    .sort((left, right) => {
      const mergedOrder =
        Date.parse(right.merged_at) - Date.parse(left.merged_at);
      return mergedOrder || right.number - left.number;
    })
    .slice(0, limit);
}

async function collectLatestMergedPullWindow(fetchPage, limit, pageSize = 100) {
  const pulls = [];
  for (let page = 1; ; page += 1) {
    const batch = await fetchPage(page, pageSize);
    if (!Array.isArray(batch)) throw new Error('expected pull request page');
    pulls.push(...batch);
    const merged = latestMergedPulls(pulls, limit);
    if (!batch.length || batch.length < pageSize) return { pulls, merged };
    if (merged.length < limit) continue;
    const cutoffMs = Date.parse(merged.at(-1).merged_at);
    const lastUpdatedMs = Date.parse(batch.at(-1).updated_at);
    if (Number.isFinite(lastUpdatedMs) && lastUpdatedMs < cutoffMs) {
      return { pulls, merged };
    }
  }
}

function selectLatencyCohort(records, mergeQueueRecords, cohortStart) {
  const cohortStartMs = cohortStart ? Date.parse(cohortStart) : null;
  if (
    cohortStart &&
    (!/T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(cohortStart) ||
      !Number.isFinite(cohortStartMs))
  ) {
    throw new Error('cohortStart must be an RFC3339 timestamp with timezone');
  }
  const atOrAfterStart = (value) =>
    cohortStartMs === null ||
    (Boolean(value) && Date.parse(value) >= cohortStartMs);
  const recordStart = (record) =>
    record.requiredWindow?.startedAt ||
    record.mergeQueue?.firstEnqueuedAt ||
    record.startedAt ||
    record.mergedAt;
  return {
    records: records.map((record) => {
      const startedAt = recordStart(record);
      return atOrAfterStart(startedAt)
        ? record
        : {
            ...record,
            excluded: true,
            exclusionReason: startedAt
              ? 'before-cohort-start'
              : 'cohort-start-unprovable',
          };
    }),
    mergeQueueRecords: mergeQueueRecords.filter((record) =>
      atOrAfterStart(record.mergeQueue?.firstEnqueuedAt || record.mergedAt),
    ),
    collection: {
      cohortStart: cohortStart || null,
      cohortStartAuthority: cohortStart
        ? 'explicit-rfc3339-first-enqueue-boundary'
        : 'unbounded-latest-merged-window',
    },
  };
}

function parseDevRequiredLatencyArgs(argv) {
  const options = {
    repository: process.env.GITHUB_REPOSITORY || '',
    branch: process.env.KUNGFU_DEV_BRANCH || '',
    limit: 30,
    output: '',
    pulls: [],
    timelineOutput: '',
    latencyOnly: false,
    cohortStart: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--latency-only') options.latencyOnly = true;
    else if (arg === '--repository') options.repository = argv[++index];
    else if (arg === '--branch') options.branch = argv[++index];
    else if (arg === '--limit') options.limit = Number(argv[++index]);
    else if (arg === '--output') options.output = argv[++index];
    else if (arg === '--pull') options.pulls.push(Number(argv[++index]));
    else if (arg === '--cohort-start') {
      options.cohortStart = argv[++index];
      if (!options.cohortStart)
        throw new Error('--cohort-start requires a value');
    } else if (arg === '--timeline-output')
      options.timelineOutput = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  ) {
    throw new Error('--limit must be an integer from 1 to 100');
  }
  if (
    options.pulls.some(
      (pullNumber) => !Number.isInteger(pullNumber) || pullNumber < 1,
    )
  ) {
    throw new Error('--pull must be a positive integer');
  }
  if (options.timelineOutput && options.pulls.length !== 1) {
    throw new Error('--timeline-output requires exactly one --pull');
  }
  if (
    options.cohortStart &&
    (!/T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(options.cohortStart) ||
      !Number.isFinite(Date.parse(options.cohortStart)))
  ) {
    throw new Error(
      '--cohort-start must be an RFC3339 timestamp with timezone',
    );
  }
  return options;
}

function latencyOnlyEvidence(classification, workflowRunId = null) {
  if (classification.kind === 'non-native') {
    return {
      cache: {
        outcome: 'not-applicable',
        authority: 'source-planner',
        warm: false,
        cold: false,
        layers: [],
        compilerStats: null,
      },
      native: {
        outcome: 'not-applicable',
        authority: 'source-planner',
        steps: [],
        candidateEvents: [],
      },
    };
  }
  const reason = 'native artifact download skipped by explicit --latency-only';
  return {
    cache: {
      outcome: 'unknown',
      authority: 'latency-only',
      reason,
      warm: false,
      cold: false,
      layers: [],
      compilerStats: null,
      workflowRunId,
    },
    native: {
      outcome: 'unknown',
      authority: 'latency-only',
      reason,
      steps: [],
      candidateEvents: [],
      workflowRunId,
    },
  };
}

module.exports = {
  checkDevChannelAuthority,
  collectLatestMergedPullWindow,
  devMergeBaseCandidates,
  findOperationalExactBindings,
  isAdmittedDevBranch,
  latestMergedPulls,
  latencyOnlyEvidence,
  measureCandidateStage,
  measureCandidateStageSync,
  parseDevRequiredLatencyArgs,
  readDevChannelContract,
  requiredMergeQueueWindow,
  resolveDevBranch,
  selectLatencyCohort,
};
