#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check
// Exact-source, publish-none macOS candidate reconciliation for the Alpha preflight action.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAuthority } from '@kungfu-tech/product-kungfu/version-line/version-line-authority';

export const OVERFLOW_RECEIPT_SCHEMA = 'kungfu.alpha-macos-overflow-receipt/v1';
export const RUNNER_AVAILABILITY_SCHEMA = 'kungfu.runner-availability/v1';
export const DEFAULT_THRESHOLD_MINUTES = 25;
export const CANDIDATE_WORKFLOW = 'build.yml';
const MACOS_CAPABILITY =
  readAuthority().runnerRouting.compatibilityAliases.find(
    ({ capability }) => capability === 'macos-arm64-native',
  );
if (!MACOS_CAPABILITY)
  throw new Error('macos-arm64-native runner capability is not admitted');
export const REQUIRED_SELF_HOSTED_LABELS = Object.freeze([
  ...MACOS_CAPABILITY.labels,
]);
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TERMINAL_RUN_STATUSES = new Set(['completed']);
const RETAINED_MACOS_SIGNING_RESULT =
  '.buildchain/artifacts/signing/macos-arm64/kungfu-cli-macos-arm64/result.json';

function required(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function exactSha(value, label = 'source SHA') {
  const normalized = required(value, label).toLowerCase();
  if (!SHA_PATTERN.test(normalized))
    throw new Error(`${label} must be one exact lowercase 40-hex commit`);
  return normalized;
}

function boundedNumber(value, label, { min, max }) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max)
    throw new Error(`${label} must be between ${min} and ${max}`);
  return number;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!flag?.startsWith('--') || index + 1 >= rest.length)
      throw new Error(`invalid overflow option: ${flag || '<missing>'}`);
    options[flag.slice(2)] = rest[index + 1];
  }
  return { command, options };
}

export function normalizeRunnerAvailability(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('runner availability must be valid JSON');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('runner availability must be an object');
  if (parsed.schema !== RUNNER_AVAILABILITY_SCHEMA)
    throw new Error(
      `runner availability schema must be ${RUNNER_AVAILABILITY_SCHEMA}`,
    );
  if (parsed.status === 'unavailable') {
    return {
      schema: RUNNER_AVAILABILITY_SCHEMA,
      status: 'unavailable',
      reason: String(parsed.reason || 'unspecified'),
      observedAt: String(parsed.observedAt || ''),
    };
  }
  if (!['online', 'offline'].includes(parsed.status))
    throw new Error(
      'runner availability status must be online, offline, or unavailable',
    );
  const requiredLabels = Array.isArray(parsed.requiredLabels)
    ? parsed.requiredLabels.map(String)
    : [];
  if (
    requiredLabels.length !== REQUIRED_SELF_HOSTED_LABELS.length ||
    REQUIRED_SELF_HOSTED_LABELS.some((label) => !requiredLabels.includes(label))
  )
    throw new Error(
      'runner availability labels do not match the required self-hosted lane',
    );
  const matchingRunnerCount = boundedNumber(
    parsed.matchingRunnerCount,
    'matching runner count',
    { min: 0, max: 10_000 },
  );
  const onlineRunnerCount = boundedNumber(
    parsed.onlineRunnerCount,
    'online runner count',
    { min: 0, max: matchingRunnerCount },
  );
  const busyOnlineRunnerCount = boundedNumber(
    parsed.busyOnlineRunnerCount,
    'busy online runner count',
    { min: 0, max: onlineRunnerCount },
  );
  if (
    ![matchingRunnerCount, onlineRunnerCount, busyOnlineRunnerCount].every(
      Number.isInteger,
    )
  )
    throw new Error('runner availability counts must be integers');
  if (parsed.status === 'online' && onlineRunnerCount === 0)
    throw new Error('online runner availability requires an online runner');
  if (parsed.status === 'offline' && onlineRunnerCount !== 0)
    throw new Error(
      'offline runner availability cannot contain an online runner',
    );
  const observedAt = required(
    parsed.observedAt,
    'runner availability observedAt',
  );
  if (!Number.isFinite(Date.parse(observedAt)))
    throw new Error('runner availability observedAt must be an ISO timestamp');
  return {
    schema: RUNNER_AVAILABILITY_SCHEMA,
    status: parsed.status,
    requiredLabels: [...REQUIRED_SELF_HOSTED_LABELS],
    matchingRunnerCount,
    onlineRunnerCount,
    busyOnlineRunnerCount,
    observedAt,
    source: required(parsed.source, 'runner availability source'),
  };
}

function candidateTitle(requestId, route) {
  return `macOS candidate / ${requestId} / ${route}`;
}

export function checkWorkspaceHealth({
  route,
  healthMode = 'auto',
  root = process.cwd(),
}) {
  if (!['self-hosted', 'github-hosted'].includes(route))
    throw new Error('health route must be self-hosted or github-hosted');
  if (!['auto', 'unhealthy'].includes(healthMode))
    throw new Error('health mode must be auto or unhealthy');
  const stalePath =
    healthMode === 'unhealthy' ||
    (route === 'self-hosted' &&
      fs.existsSync(path.join(root, RETAINED_MACOS_SIGNING_RESULT)))
      ? RETAINED_MACOS_SIGNING_RESULT
      : '';
  if (stalePath)
    throw new Error(`retained signing result would conflict: ${stalePath}`);
  return {
    route,
    status: 'healthy',
    reason: 'clean-signing-import-destination',
  };
}

function terminal(run) {
  return TERMINAL_RUN_STATUSES.has(String(run?.status || ''));
}

function successfulPlatform(candidate) {
  return candidate?.platformJob?.conclusion === 'success';
}

function acquired(candidate) {
  return Boolean(candidate?.platformJob?.runner_name);
}

function queued(candidate) {
  const job = candidate?.platformJob || candidate?.healthJob;
  return Boolean(
    job &&
      !job.runner_name &&
      !['completed'].includes(String(job.status || '')),
  );
}

function milliseconds(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function completionTime(candidate) {
  return milliseconds(
    candidate?.platformJob?.completed_at || candidate?.run?.updated_at,
  );
}

export function summarizeCandidate({ route, run = null, jobs = [] }) {
  const platformJob =
    jobs.find(
      (job) =>
        String(job.name || '').startsWith('build / macOS ARM64') &&
        Array.isArray(job.labels) &&
        (job.labels.includes('macos-15') ||
          REQUIRED_SELF_HOSTED_LABELS.every((label) =>
            job.labels.includes(label),
          )),
    ) || null;
  const preflightJob =
    jobs.find((job) => job.name === 'Require exact-source Alpha preflight') ||
    null;
  const queueAnchor = platformJob?.started_at || run?.created_at || '';
  return {
    route,
    run,
    preflightJob,
    platformJob,
    queueAnchor,
    acquired: Boolean(platformJob?.runner_name),
    queued: Boolean(
      platformJob &&
        !platformJob.runner_name &&
        platformJob.status !== 'completed',
    ),
  };
}

function chooseWinner(self, hosted) {
  const candidates = [self, hosted].filter(successfulPlatform);
  candidates.sort((left, right) => {
    const delta = completionTime(left) - completionTime(right);
    if (delta !== 0) return delta;
    return left.route === 'self-hosted' ? -1 : 1;
  });
  return candidates[0]?.route || '';
}

export function decideOverflow({
  self,
  hosted = null,
  hostedDispatched = false,
  runnerAvailability = normalizeRunnerAvailability({
    schema: RUNNER_AVAILABILITY_SCHEMA,
    status: 'unavailable',
    reason: 'not-supplied',
  }),
  now = Date.now(),
  thresholdMinutes = DEFAULT_THRESHOLD_MINUTES,
  predictedRemainingQueueMinutes = null,
  predictionRoot = '',
}) {
  if (!self?.run) return { action: 'wait', reason: 'self-run-not-visible' };
  if (hostedDispatched && !hosted?.run)
    return { action: 'wait', reason: 'hosted-run-not-visible' };

  if (!hosted?.run && runnerAvailability.status === 'offline') {
    return {
      action: 'dispatch-hosted',
      reason: 'self-hosted-fleet-offline',
    };
  }

  if (
    predictedRemainingQueueMinutes !== null &&
    predictedRemainingQueueMinutes > thresholdMinutes &&
    ROOT_PATTERN.test(predictionRoot)
  ) {
    if (!hosted?.run)
      return {
        action: 'dispatch-hosted',
        reason: 'predicted-remaining-queue-exceeds-threshold',
      };
  }

  if (
    terminal(self.run) &&
    self.run.conclusion === 'failure' &&
    !self.platformJob
  ) {
    return {
      action: 'fail',
      reason: 'self-candidate-failed-before-health-preflight',
    };
  }

  if (!hosted?.run) {
    if (
      successfulPlatform(self) &&
      terminal(self.run) &&
      self.run.conclusion === 'success'
    )
      return { action: 'reconcile', reason: 'self-hosted-succeeded' };
    if (successfulPlatform(self) && !terminal(self.run))
      return { action: 'wait', reason: 'self-hosted-finalizing' };
    if (
      successfulPlatform(self) &&
      terminal(self.run) &&
      self.run.conclusion !== 'success'
    )
      return {
        action: 'dispatch-hosted',
        reason: 'self-hosted-candidate-finalization-failed',
      };
    if (
      self.platformJob?.status === 'completed' &&
      self.platformJob?.conclusion &&
      self.platformJob.conclusion !== 'success'
    ) {
      return {
        action: 'dispatch-hosted',
        reason: 'self-hosted-platform-failed',
      };
    }
    if (acquired(self))
      return { action: 'wait', reason: 'self-hosted-acquired-runner' };
    const queuedAt = milliseconds(self.queueAnchor);
    if (queuedAt && now - queuedAt >= Number(thresholdMinutes) * 60 * 1000) {
      return {
        action: 'dispatch-hosted',
        reason: 'observed-queue-exceeds-threshold',
      };
    }
    return { action: 'wait', reason: 'self-hosted-within-queue-budget' };
  }

  if (acquired(hosted) && queued(self) && !terminal(self.run))
    return {
      action: 'cancel-self',
      reason: 'hosted-acquired-while-self-still-queued',
    };

  const selfDone = terminal(self.run);
  const hostedDone = terminal(hosted.run);
  if (selfDone && hostedDone) {
    const winner = chooseWinner(self, hosted);
    if (winner)
      return {
        action: 'reconcile',
        reason: 'candidate-runs-terminal',
        winner,
      };
    return { action: 'fail', reason: 'no-successful-macos-candidate' };
  }

  return { action: 'wait', reason: 'candidate-runs-in-progress' };
}

function receiptCandidate(candidate) {
  if (!candidate?.run) return null;
  const job = candidate.platformJob;
  const queueStartedAt = candidate.queueAnchor || '';
  const acquiredAt = job?.runner_name ? job.started_at || '' : '';
  const queueSeconds =
    queueStartedAt && acquiredAt
      ? Math.max(
          0,
          (milliseconds(acquiredAt) - milliseconds(queueStartedAt)) / 1000,
        )
      : null;
  return {
    route: candidate.route,
    runId: String(candidate.run.id),
    runUrl: candidate.run.html_url || '',
    runStatus: candidate.run.status || '',
    runConclusion: candidate.run.conclusion || '',
    platformJobId: job?.id ? String(job.id) : '',
    platformJobName: job?.name || '',
    platformStatus: job?.status || '',
    platformConclusion: job?.conclusion || '',
    runnerName: job?.runner_name || '',
    runnerLabels: job?.labels || [],
    queueStartedAt,
    acquiredAt,
    completedAt: job?.completed_at || '',
    queueSeconds,
  };
}

class GitHubClient {
  constructor({ repository, token, apiUrl = 'https://api.github.com' }) {
    this.repository = required(repository, 'repository');
    this.token = required(token, 'GitHub token');
    this.apiUrl = apiUrl.replace(/\/+$/u, '');
  }

  async request(method, endpoint, body) {
    const response = await fetch(`${this.apiUrl}${endpoint}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `GitHub API ${method} ${endpoint} failed (${response.status}): ${text}`,
      );
    }
    if (response.status === 204) return {};
    return response.json();
  }

  async dispatch({
    ref,
    requestId,
    route,
    sourceSha,
    preflightRunId,
    healthMode,
  }) {
    await this.request(
      'POST',
      `/repos/${this.repository}/actions/workflows/${CANDIDATE_WORKFLOW}/dispatches`,
      {
        ref,
        inputs: {
          'macos-overflow-request-json': JSON.stringify({
            mode: route,
            requestId,
            sourceSha,
            preflightRunId,
            healthMode: route === 'self-hosted' ? healthMode : 'auto',
          }),
        },
      },
    );
  }

  async findRun({ requestId, route, sourceSha, notBefore }) {
    const payload = await this.request(
      'GET',
      `/repos/${this.repository}/actions/workflows/${CANDIDATE_WORKFLOW}/runs?event=workflow_dispatch&per_page=50`,
    );
    const title = candidateTitle(requestId, route);
    return (
      (payload.workflow_runs || [])
        .filter(
          (run) =>
            run.display_title === title &&
            run.head_sha === sourceSha &&
            milliseconds(run.created_at) >= milliseconds(notBefore) - 60_000,
        )
        .sort((left, right) => Number(right.id) - Number(left.id))[0] || null
    );
  }

  async jobs(runId) {
    const payload = await this.request(
      'GET',
      `/repos/${this.repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
    );
    return payload.jobs || [];
  }

  async cancel(runId) {
    await this.request(
      'POST',
      `/repos/${this.repository}/actions/runs/${runId}/cancel`,
    );
  }

  async runners() {
    const runners = [];
    for (let page = 1; ; page += 1) {
      const payload = await this.request(
        'GET',
        `/repos/${this.repository}/actions/runners?per_page=100&page=${page}`,
      );
      const rows = Array.isArray(payload.runners) ? payload.runners : [];
      runners.push(...rows);
      if (rows.length < 100) return runners;
    }
  }
}

async function sleep(millisecondsToWait) {
  await new Promise((resolve) => setTimeout(resolve, millisecondsToWait));
}

async function snapshot(client, { requestId, route, sourceSha, notBefore }) {
  const run = await client.findRun({ requestId, route, sourceSha, notBefore });
  const jobs = run ? await client.jobs(run.id) : [];
  return summarizeCandidate({ route, run, jobs });
}

export async function observeRunnerAvailability({
  repository,
  token = '',
  apiUrl,
  now = () => Date.now(),
  client = null,
}) {
  if (!client && !String(token || '').trim()) {
    return normalizeRunnerAvailability({
      schema: RUNNER_AVAILABILITY_SCHEMA,
      status: 'unavailable',
      reason: 'runner-inventory-token-not-projected',
    });
  }
  const inventory =
    client ||
    new GitHubClient({
      repository,
      token,
      apiUrl,
    });
  try {
    const runners = await inventory.runners();
    const matching = runners.filter((runner) => {
      const labels = new Set(
        (runner.labels || []).map((label) => String(label.name || label)),
      );
      return REQUIRED_SELF_HOSTED_LABELS.every((label) => labels.has(label));
    });
    const online = matching.filter((runner) => runner.status === 'online');
    return normalizeRunnerAvailability({
      schema: RUNNER_AVAILABILITY_SCHEMA,
      status: online.length > 0 ? 'online' : 'offline',
      requiredLabels: REQUIRED_SELF_HOSTED_LABELS,
      matchingRunnerCount: matching.length,
      onlineRunnerCount: online.length,
      busyOnlineRunnerCount: online.filter((runner) => runner.busy).length,
      observedAt: new Date(now()).toISOString(),
      source: 'github-actions-repository-runners-api',
    });
  } catch {
    process.stdout.write(
      '[alpha-macos-overflow] runner inventory unavailable; retaining queue threshold\n',
    );
    return normalizeRunnerAvailability({
      schema: RUNNER_AVAILABILITY_SCHEMA,
      status: 'unavailable',
      reason: 'repository-runner-inventory-unavailable',
      observedAt: new Date(now()).toISOString(),
    });
  }
}

export async function controlOverflow({
  repository,
  token,
  apiUrl,
  ref,
  sourceSha,
  preflightRunId,
  requestId,
  thresholdMinutes = DEFAULT_THRESHOLD_MINUTES,
  predictedRemainingQueueMinutes = null,
  predictionRoot = '',
  healthMode = 'auto',
  runnerAvailability = null,
  runnerInventoryToken = '',
  diagnosticMode = false,
  pollSeconds = 15,
  timeoutMinutes = 300,
  out,
  now = () => Date.now(),
  client = null,
  inventoryClient = null,
}) {
  const exactSourceSha = exactSha(sourceSha);
  const exactRequestId = required(requestId, 'request id');
  if (!/^[A-Za-z0-9._-]{1,80}$/u.test(exactRequestId))
    throw new Error('request id contains unsupported characters');
  const threshold = boundedNumber(thresholdMinutes, 'threshold minutes', {
    min: 1,
    max: 180,
  });
  if (threshold !== DEFAULT_THRESHOLD_MINUTES && !diagnosticMode)
    throw new Error(
      `threshold override requires diagnostic mode; production default is ${DEFAULT_THRESHOLD_MINUTES} minutes`,
    );
  if (!['auto', 'unhealthy'].includes(healthMode))
    throw new Error('health mode must be auto or unhealthy');
  if (healthMode !== 'auto' && !diagnosticMode)
    throw new Error('forced health mode requires diagnostic mode');
  let prediction = null;
  if (
    predictedRemainingQueueMinutes !== null &&
    String(predictedRemainingQueueMinutes) !== ''
  ) {
    prediction = boundedNumber(
      predictedRemainingQueueMinutes,
      'predicted remaining queue minutes',
      { min: 0, max: 1440 },
    );
    if (!ROOT_PATTERN.test(predictionRoot))
      throw new Error(
        'predicted remaining queue requires a source-proven sha256 root',
      );
  }

  const github =
    client ||
    new GitHubClient({
      repository,
      token,
      apiUrl,
    });
  const availability = runnerAvailability
    ? normalizeRunnerAvailability(runnerAvailability)
    : await observeRunnerAvailability({
        repository,
        token: runnerInventoryToken,
        apiUrl,
        now,
        client: inventoryClient,
      });
  const startedAt = new Date(now()).toISOString();
  const deadline = now() + Number(timeoutMinutes) * 60 * 1000;
  const events = [];
  let hostedDispatched = false;
  let selfCancelled = false;
  let fallbackReason = '';

  const record = (action, reason, details = {}) => {
    const event = {
      at: new Date(now()).toISOString(),
      action,
      reason,
      ...details,
    };
    events.push(event);
    process.stdout.write(`[alpha-macos-overflow] ${action}: ${reason}\n`);
  };

  await github.dispatch({
    ref,
    requestId: exactRequestId,
    route: 'self-hosted',
    sourceSha: exactSourceSha,
    preflightRunId,
    healthMode,
  });
  record('dispatch-self', 'self-hosted-primary');
  if (availability.status === 'offline') {
    await github.dispatch({
      ref,
      requestId: exactRequestId,
      route: 'github-hosted',
      sourceSha: exactSourceSha,
      preflightRunId,
      healthMode: 'auto',
    });
    hostedDispatched = true;
    fallbackReason = 'self-hosted-fleet-offline';
    record('dispatch-hosted', fallbackReason);
  }

  while (now() < deadline) {
    const self = await snapshot(github, {
      requestId: exactRequestId,
      route: 'self-hosted',
      sourceSha: exactSourceSha,
      notBefore: startedAt,
    });
    const hosted = hostedDispatched
      ? await snapshot(github, {
          requestId: exactRequestId,
          route: 'github-hosted',
          sourceSha: exactSourceSha,
          notBefore: startedAt,
        })
      : null;
    const decision = decideOverflow({
      self,
      hosted,
      hostedDispatched,
      runnerAvailability: availability,
      now: now(),
      thresholdMinutes: threshold,
      predictedRemainingQueueMinutes: prediction,
      predictionRoot,
    });

    if (decision.action === 'dispatch-hosted') {
      await github.dispatch({
        ref,
        requestId: exactRequestId,
        route: 'github-hosted',
        sourceSha: exactSourceSha,
        preflightRunId,
        healthMode: 'auto',
      });
      hostedDispatched = true;
      fallbackReason = decision.reason;
      record('dispatch-hosted', decision.reason);
      await sleep(Number(pollSeconds) * 1000);
      continue;
    }
    if (decision.action === 'cancel-self' && self.run && !selfCancelled) {
      if (!hosted?.platformJob?.runner_name || self.platformJob?.runner_name)
        throw new Error('candidate cancellation ordering drifted');
      await github.cancel(self.run.id);
      selfCancelled = true;
      record('cancel-self', decision.reason, {
        selfRunId: String(self.run.id),
        hostedRunId: String(hosted.run.id),
      });
      await sleep(Number(pollSeconds) * 1000);
      continue;
    }
    if (decision.action === 'reconcile') {
      const winner =
        decision.winner ||
        (successfulPlatform(self) ? 'self-hosted' : 'github-hosted');
      record('reconcile', decision.reason, { winner });
      const receipt = {
        schema: OVERFLOW_RECEIPT_SCHEMA,
        status: 'passed',
        requestId: exactRequestId,
        repository,
        source: {
          sha: exactSourceSha,
          ref,
          preflightRunId: String(preflightRunId || ''),
        },
        policy: {
          primary: 'self-hosted',
          thresholdMinutes: threshold,
          diagnosticMode: Boolean(diagnosticMode),
          healthMode,
          runnerAvailability: availability,
          predictedRemainingQueueMinutes: prediction,
          predictionRoot: prediction ? predictionRoot : '',
          cancellation:
            'queued-self-only-after-hosted-platform-runner-acquisition',
          publication: 'none',
          promotionAuthority: 'unchanged-existing-alpha-promotion',
          callerOwnedNotarizationTail:
            'not-run-build-and-verify-candidates-only',
        },
        decision: {
          overflowDispatched: hostedDispatched,
          fallbackReason,
          selfCancelled,
          winner,
        },
        candidates: {
          selfHosted: receiptCandidate(self),
          githubHosted: receiptCandidate(hosted),
        },
        events,
        startedAt,
        completedAt: new Date(now()).toISOString(),
      };
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(
        path.resolve(out),
        `${JSON.stringify(receipt, null, 2)}\n`,
      );
      return receipt;
    }
    if (decision.action === 'fail')
      throw new Error(`overflow controller failed: ${decision.reason}`);

    await sleep(Number(pollSeconds) * 1000);
  }
  throw new Error(
    `overflow controller timed out after ${timeoutMinutes} minutes`,
  );
}

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === 'health') {
    const health = checkWorkspaceHealth({
      route: options.route,
      healthMode: options['health-mode'] || 'auto',
    });
    process.stdout.write(
      `[alpha-macos-overflow] workspace health: ${JSON.stringify(health)}\n`,
    );
    return;
  }
  if (command !== 'control')
    throw new Error(`unknown overflow command: ${command || '<missing>'}`);
  const request = JSON.parse(options['request-json'] || '{}');
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new Error('request JSON must be an object');
  const invocation = {
    repository: options.repository || process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
    apiUrl: process.env.GITHUB_API_URL,
    ref: options.ref || process.env.GITHUB_REF_NAME,
    sourceSha: request.sourceSha || options['source-sha'],
    preflightRunId: request.preflightRunId || options['preflight-run-id'],
    requestId: request.requestId || options['request-id'],
    thresholdMinutes:
      request.thresholdMinutes ||
      options['threshold-minutes'] ||
      DEFAULT_THRESHOLD_MINUTES,
    predictedRemainingQueueMinutes:
      request.predictedRemainingQueueMinutes ??
      options['predicted-remaining-queue-minutes'] ??
      null,
    predictionRoot: request.predictionRoot || options['prediction-root'] || '',
    healthMode: request.healthMode || options['health-mode'] || 'auto',
    runnerAvailability:
      request.runnerAvailabilityFixture &&
      (request.diagnosticMode === true || options['diagnostic-mode'] === 'true')
        ? request.runnerAvailabilityFixture
        : null,
    runnerInventoryToken: process.env.RUNNER_INVENTORY_TOKEN || '',
    diagnosticMode:
      request.diagnosticMode === true || options['diagnostic-mode'] === 'true',
    pollSeconds: options['poll-seconds'] || 15,
    timeoutMinutes: options['timeout-minutes'] || 300,
    out: required(options.out, 'output path'),
  };
  if (!/^[1-9][0-9]*$/u.test(String(invocation.preflightRunId || '')))
    throw new Error('preflight run id must be a positive integer');
  try {
    await controlOverflow(invocation);
  } catch (error) {
    const failure = {
      schema: OVERFLOW_RECEIPT_SCHEMA,
      status: 'failed',
      requestId: String(invocation.requestId || ''),
      repository: String(invocation.repository || ''),
      source: {
        sha: String(invocation.sourceSha || ''),
        ref: String(invocation.ref || ''),
        preflightRunId: String(invocation.preflightRunId || ''),
      },
      decision: {
        winner: '',
        failure: String(error?.message || error),
      },
      policy: {
        publication: 'none',
        promotionAuthority: 'unchanged-existing-alpha-promotion',
        callerOwnedNotarizationTail: 'not-run-build-and-verify-candidates-only',
        runnerAvailability: invocation.runnerAvailability
          ? normalizeRunnerAvailability(invocation.runnerAvailability)
          : {
              schema: RUNNER_AVAILABILITY_SCHEMA,
              status: 'unavailable',
              reason: 'controller-failed-before-availability-receipt',
            },
      },
      completedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(path.resolve(invocation.out)), {
      recursive: true,
    });
    fs.writeFileSync(
      path.resolve(invocation.out),
      `${JSON.stringify(failure, null, 2)}\n`,
    );
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `[alpha-macos-overflow] ${String(error?.stack || error)}\n`,
    );
    process.exitCode = 1;
  });
}
