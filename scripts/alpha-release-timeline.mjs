#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyAlphaCacheEvidence } from './alpha-cache-evidence.mjs';
import { verifyAggregateReceipt } from './alpha-promotion-preflight.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = 'kungfu.alpha-release-timeline-receipt/v1';
const CONTRACT_SCHEMA = 'kungfu.alpha-release-latency-contract/v1';
const CONTROLLER_CONTRACT = 'buildchain.controller-evidence/v1';
const PROMOTION_OBSERVER_JOB = 'Alpha release timeline';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function digest(value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(JSON.stringify(canonical(value)));
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

export function alphaReleaseDigest(value) {
  return digest(value);
}

function required(value, label) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`${label} is required`);
  return value.trim();
}

function exactSha(value, label) {
  const normalized = required(value, label);
  if (!/^[a-f0-9]{40}$/u.test(normalized))
    throw new Error(`${label} must be an exact Git SHA`);
  return normalized;
}

function exactRoot(value, label) {
  const normalized = required(value, label);
  if (!/^sha256:[a-f0-9]{64}$/u.test(normalized))
    throw new Error(`${label} must be an exact SHA-256 root`);
  return normalized;
}

function timestamp(value, label) {
  const normalized = required(value, label);
  const epoch = Date.parse(normalized);
  if (!Number.isFinite(epoch)) throw new Error(`${label} is not a timestamp`);
  return { value: new Date(epoch).toISOString(), epoch };
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');
}

function runField(run, camel, snake) {
  return run?.[camel] ?? run?.[snake];
}

function sideEffectClass(name) {
  const value = name.toLowerCase();
  if (/precompute|tail plan/u.test(value)) return 'none';
  if (/read.?back/u.test(value)) return 'public-readback';
  if (/activation|publication commit|publish|github release/u.test(value))
    return 'publication';
  if (/notari/u.test(value)) return 'notarization';
  if (/sign|credential/u.test(value)) return 'signing';
  return 'none';
}

function normalizeRunWindow(label, run) {
  const created = timestamp(
    runField(run, 'createdAt', 'created_at'),
    `${label}.createdAt`,
  );
  const started = timestamp(
    runField(run, 'runStartedAt', 'run_started_at') || created.value,
    `${label}.runStartedAt`,
  );
  const updated = timestamp(
    runField(run, 'updatedAt', 'updated_at'),
    `${label}.updatedAt`,
  );
  if (updated.epoch < created.epoch)
    throw new Error(`${label} run ends before it starts`);
  return { created, started, updated };
}

function selectObservedJobs(label, run, observerJob) {
  const jobs = Array.isArray(run.jobs) ? run.jobs : [];
  const observers = observerJob
    ? jobs.filter((job) => job.name === observerJob)
    : [];
  if (observers.length > 1)
    throw new Error(`${label} contains duplicate observer jobs`);
  const observedConclusion = run.conclusion || run.status || 'unknown';
  const observerStatus = observers[0]?.conclusion || observers[0]?.status || '';
  if (observedConclusion === 'in_progress') {
    if (
      label !== 'alpha-promotion' ||
      observers.length !== 1 ||
      observerStatus !== 'in_progress'
    )
      throw new Error(
        `${label} in-progress snapshot is not owned by the timeline observer`,
      );
  } else if (observedConclusion !== 'success') {
    throw new Error(`${label} run is not successful`);
  }
  const observedJobs = observerJob
    ? jobs.filter((job) => job.name !== observerJob)
    : jobs;
  if (observedJobs.length === 0)
    throw new Error(`${label} snapshot has no completed producer jobs`);
  return { observedConclusion, observerStatus, observers, observedJobs };
}

function normalizeStepPhase(
  label,
  jobName,
  jobIndex,
  step,
  stepIndex,
  jobStarted,
) {
  const stepName = required(
    step.name || `step-${stepIndex}`,
    `${label} step name`,
  );
  const stepStarted = timestamp(
    runField(step, 'startedAt', 'started_at') || jobStarted.value,
    `${label}.${stepName}.startedAt`,
  );
  const stepCompleted = timestamp(
    runField(step, 'completedAt', 'completed_at') || stepStarted.value,
    `${label}.${stepName}.completedAt`,
  );
  return {
    id: `${label}/job/${slug(jobName) || jobIndex}/step/${slug(stepName) || stepIndex}`,
    kind: 'step',
    name: stepName,
    conclusion: step.conclusion || step.status || 'unknown',
    startedAt: stepStarted.value,
    completedAt: stepCompleted.value,
    durationMs: Math.max(0, stepCompleted.epoch - stepStarted.epoch),
    externalSideEffect: sideEffectClass(stepName),
  };
}

function normalizeJobPhases(label, job, jobIndex, started) {
  const jobName = required(job.name || `job-${jobIndex}`, `${label} job name`);
  if (!['success', 'skipped'].includes(job.conclusion || ''))
    throw new Error(`${label} producer job is not complete: ${jobName}`);
  const jobStarted = timestamp(
    runField(job, 'startedAt', 'started_at') || started.value,
    `${label}.${jobName}.startedAt`,
  );
  const jobCompleted = timestamp(
    runField(job, 'completedAt', 'completed_at'),
    `${label}.${jobName}.completedAt`,
  );
  const jobPhase = {
    id: `${label}/job/${slug(jobName) || jobIndex}`,
    kind: 'job',
    name: jobName,
    conclusion: job.conclusion || job.status || 'unknown',
    startedAt: jobStarted.value,
    completedAt: jobCompleted.value,
    durationMs: Math.max(0, jobCompleted.epoch - jobStarted.epoch),
    externalSideEffect: sideEffectClass(jobName),
  };
  const stepPhases = (job.steps || []).map((step, stepIndex) =>
    normalizeStepPhase(label, jobName, jobIndex, step, stepIndex, jobStarted),
  );
  return { jobCompleted, phases: [jobPhase, ...stepPhases] };
}

function normalizeRun(label, run, { observerJob = '' } = {}) {
  if (!run || typeof run !== 'object')
    throw new Error(`${label} run is required`);
  const { created, started, updated } = normalizeRunWindow(label, run);
  const { observedConclusion, observerStatus, observers, observedJobs } =
    selectObservedJobs(label, run, observerJob);
  const normalizedJobs = observedJobs.map((job, jobIndex) =>
    normalizeJobPhases(label, job, jobIndex, started),
  );
  const phases = normalizedJobs.flatMap((job) => job.phases);
  const producerCompletionEpochs = normalizedJobs.map(
    (job) => job.jobCompleted.epoch,
  );
  const attempt = Number(runField(run, 'runAttempt', 'run_attempt') || 1);
  const observerExcluded = observers.length === 1;
  const completedEpoch = observerExcluded
    ? Math.max(...producerCompletionEpochs)
    : updated.epoch;
  return {
    label,
    runId: String(run.id || runField(run, 'databaseId', 'database_id') || ''),
    runAttempt: attempt,
    conclusion: 'success',
    snapshot: {
      observedConclusion,
      observerJob: observerExcluded ? observerJob : '',
      observerStatus: observerExcluded ? observerStatus : '',
      observerExcluded,
    },
    createdAt: created.value,
    startedAt: started.value,
    completedAt: new Date(completedEpoch).toISOString(),
    queueMs: Math.max(0, started.epoch - created.epoch),
    elapsedMs: completedEpoch - created.epoch,
    retryCount: Math.max(0, attempt - 1),
    phases,
  };
}

function controllerStatus(controller) {
  return controller?.receipt?.status || controller?.status || '';
}

function verifyControllerReceipt(controller) {
  if ((controller?.contract || controller?.schema) !== CONTROLLER_CONTRACT)
    throw new Error('promotion controller receipt schema mismatch');
  if (controller.kind !== 'receipt')
    throw new Error('promotion controller evidence is not a receipt');
  if (controller.controller?.id !== 'release-candidate-promotion')
    throw new Error('promotion controller receipt owner mismatch');
  const { digest: receiptDigest, ...body } = controller;
  if (receiptDigest !== digest(body))
    throw new Error('promotion controller receipt digest mismatch');
  if (controller.qualifying !== true)
    throw new Error('promotion controller receipt is not qualifying');
}

function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

export function createAlphaReleaseTimeline({
  root = ROOT,
  contract,
  preflightReceipt,
  sourceCommit,
  sourceTree,
  promotionCommit,
  promotionTree,
  runs,
  controllerReceipt,
  candidateArtifact,
  cacheEvidence,
  publication = {},
  mode = 'rehearsal',
  generatedAt = new Date().toISOString(),
}) {
  if (contract?.schema !== CONTRACT_SCHEMA || contract.status !== 'active')
    throw new Error('Alpha latency contract is not active');
  if (!['rehearsal', 'release'].includes(mode))
    throw new Error(`unsupported Alpha timeline mode: ${mode}`);
  const candidateSource = exactSha(sourceCommit, 'sourceCommit');
  const candidateTree = exactSha(sourceTree, 'sourceTree');
  const channelCommit = exactSha(promotionCommit, 'promotionCommit');
  const channelTree = exactSha(promotionTree, 'promotionTree');
  verifyAggregateReceipt({
    root,
    receipt: preflightReceipt,
    expectedSourceCommit: candidateSource,
    now: Date.parse(generatedAt),
  });
  if (preflightReceipt.binding.sourceTree !== candidateTree)
    throw new Error('candidate source tree does not match preflight receipt');
  if (channelTree !== candidateTree)
    throw new Error('promotion tree does not match immutable candidate tree');
  verifyControllerReceipt(controllerReceipt);
  const controllerState = controllerStatus(controllerReceipt);
  if (!['passed', 'success'].includes(controllerState))
    throw new Error('promotion controller receipt is not qualifying');
  const normalizedRuns = [
    normalizeRun('dev-preflight', runs?.preflight),
    normalizeRun('candidate-build', runs?.candidate),
    normalizeRun('alpha-promotion', runs?.promotion, {
      observerJob: PROMOTION_OBSERVER_JOB,
    }),
  ];
  for (const run of normalizedRuns) {
    if (run.conclusion !== 'success')
      throw new Error(`${run.label} run is not successful`);
    const failedPhase = run.phases.find((phase) =>
      [
        'action_required',
        'cancelled',
        'failure',
        'startup_failure',
        'timed_out',
      ].includes(phase.conclusion),
    );
    if (failedPhase)
      throw new Error(`${run.label} phase failed: ${failedPhase.name}`);
  }
  const cutAt = Math.min(
    ...normalizedRuns.map(
      (run) => timestamp(run.createdAt, 'run.createdAt').epoch,
    ),
  );
  const completedAt = Math.max(
    ...normalizedRuns.map(
      (run) => timestamp(run.completedAt, 'run.completedAt').epoch,
    ),
  );
  const queueMs = normalizedRuns.reduce((total, run) => total + run.queueMs, 0);
  const controllableMs = normalizedRuns.reduce(
    (total, run) => total + Math.max(0, run.elapsedMs - run.queueMs),
    0,
  );
  const externalPhases = normalizedRuns
    .flatMap((run) => run.phases)
    .filter((phase) => phase.externalSideEffect !== 'none');
  const publicationEvidence = {
    evidenceDigest: publication.evidenceDigest || '',
    payloadRoot: publication.payloadRoot || '',
    publicUrl: publication.publicUrl || '',
  };
  if (
    mode === 'release' &&
    Object.values(publicationEvidence).some((value) => !value)
  )
    throw new Error('real Alpha timeline requires fresh publication readback');
  if (mode === 'release') {
    exactRoot(
      publicationEvidence.evidenceDigest,
      'publication evidence digest',
    );
    exactRoot(publicationEvidence.payloadRoot, 'publication payload root');
    const publicUrl = new URL(publicationEvidence.publicUrl);
    if (publicUrl.protocol !== 'https:')
      throw new Error('publication readback URL must use HTTPS');
  }
  const artifactName = required(
    candidateArtifact,
    'release candidate artifact',
  );
  if (!artifactName.includes(candidateSource))
    throw new Error('release candidate artifact is not source-addressed');
  verifyAlphaCacheEvidence({
    evidence: cacheEvidence,
    preflightReceipt,
  });
  const body = {
    schema: SCHEMA,
    status: mode === 'release' ? 'observed' : 'rehearsed',
    mode,
    generatedAt: timestamp(generatedAt, 'generatedAt').value,
    contract: {
      schema: contract.schema,
      digest: digest(contract),
    },
    candidate: {
      sourceCommit: candidateSource,
      sourceTree: candidateTree,
      promotionCommit: channelCommit,
      promotionTree: channelTree,
      promotionRule: contract.candidate.promotionRule,
      preflightReceiptRoot: preflightReceipt.receiptRoot,
      binding: preflightReceipt.binding,
    },
    artifactLineage: {
      rule: contract.candidate.artifactRule,
      releaseCandidateArtifact: artifactName,
      promotionControllerReceiptDigest: controllerReceipt.digest,
      publication: publicationEvidence,
    },
    cacheEvidence,
    timing: {
      candidateCutAt: new Date(cutAt).toISOString(),
      publicReadbackCompletedAt:
        mode === 'release' ? new Date(completedAt).toISOString() : '',
      rehearsalCompletedAt:
        mode === 'rehearsal' ? new Date(completedAt).toISOString() : '',
      fullPathMs: completedAt - cutAt,
      controllableMs,
      externalQueueMs: queueMs,
      retries: normalizedRuns.reduce((total, run) => total + run.retryCount, 0),
      runs: normalizedRuns,
      externalSideEffects: externalPhases,
    },
    budgets: contract.phaseBudgetsSeconds,
    slo: {
      eligibleRealSample: mode === 'release',
      controllableTargetMs: contract.slo.controllableP50Seconds * 1000,
      fullPathTargetMs: contract.slo.fullPathP90Seconds * 1000,
      controllableStatus:
        controllableMs <= contract.slo.controllableP50Seconds * 1000
          ? 'within-target'
          : 'over-target',
      fullPathStatus:
        completedAt - cutAt <= contract.slo.fullPathP90Seconds * 1000
          ? 'within-target'
          : 'over-target',
      sampleVerdict:
        mode === 'release'
          ? 'eligible-real-sample'
          : contract.slo.lowSampleVerdict,
    },
  };
  return { ...body, receiptRoot: digest(body) };
}

export function verifyAlphaReleaseTimeline({ receipt, contract }) {
  const { receiptRoot, ...body } = receipt || {};
  if (receiptRoot !== digest(body))
    throw new Error('timeline receipt root mismatch');
  if (receipt.schema !== SCHEMA)
    throw new Error('timeline receipt schema mismatch');
  if (receipt.contract?.digest !== digest(contract))
    throw new Error('timeline contract digest mismatch');
  const sourceCommit = exactSha(
    receipt.candidate?.sourceCommit,
    'timeline candidate sourceCommit',
  );
  const sourceTree = exactSha(
    receipt.candidate?.sourceTree,
    'timeline candidate sourceTree',
  );
  if (
    exactSha(
      receipt.candidate?.promotionTree,
      'timeline candidate promotionTree',
    ) !== sourceTree
  )
    throw new Error('timeline promotion tree does not match candidate tree');
  exactSha(
    receipt.candidate?.promotionCommit,
    'timeline candidate promotionCommit',
  );
  exactRoot(
    receipt.candidate?.preflightReceiptRoot,
    'timeline preflight receipt root',
  );
  const artifact = required(
    receipt.artifactLineage?.releaseCandidateArtifact,
    'timeline release candidate artifact',
  );
  if (!artifact.includes(sourceCommit))
    throw new Error(
      'timeline release candidate artifact is not source-addressed',
    );
  exactRoot(
    receipt.artifactLineage?.promotionControllerReceiptDigest,
    'timeline controller receipt digest',
  );
  for (const run of receipt.timing?.runs || []) {
    if (run.conclusion !== 'success')
      throw new Error(`timeline ${run.label} run is not successful`);
    if (run.snapshot?.observedConclusion === 'in_progress') {
      if (
        run.label !== 'alpha-promotion' ||
        run.snapshot.observerJob !== PROMOTION_OBSERVER_JOB ||
        run.snapshot.observerStatus !== 'in_progress' ||
        run.snapshot.observerExcluded !== true
      )
        throw new Error(
          'timeline in-progress promotion snapshot is not observer-owned',
        );
    } else if (run.snapshot?.observedConclusion !== 'success') {
      throw new Error(`timeline ${run.label} source run is not successful`);
    } else if (run.snapshot.observerExcluded === true) {
      if (
        run.label !== 'alpha-promotion' ||
        run.snapshot.observerJob !== PROMOTION_OBSERVER_JOB ||
        run.snapshot.observerStatus !== 'success'
      )
        throw new Error(
          'timeline completed promotion snapshot is not observer-owned',
        );
    } else if (
      run.snapshot.observerExcluded !== false ||
      run.snapshot.observerJob !== '' ||
      run.snapshot.observerStatus !== ''
    ) {
      throw new Error(`timeline ${run.label} observer snapshot is malformed`);
    }
    if (
      run.snapshot.observerExcluded === true &&
      (run.phases || []).some((phase) => phase.name === PROMOTION_OBSERVER_JOB)
    ) {
      throw new Error('timeline observer phase was not excluded');
    }
    const failedPhase = (run.phases || []).find((phase) =>
      [
        'action_required',
        'cancelled',
        'failure',
        'startup_failure',
        'timed_out',
      ].includes(phase.conclusion),
    );
    if (failedPhase)
      throw new Error(
        `timeline ${run.label} phase failed: ${failedPhase.name}`,
      );
  }
  if (
    receipt.mode === 'release' &&
    (!receipt.artifactLineage?.publication?.evidenceDigest ||
      !receipt.artifactLineage?.publication?.payloadRoot ||
      !receipt.artifactLineage?.publication?.publicUrl)
  )
    throw new Error('release timeline omitted publication readback');
  if (receipt.mode === 'release') {
    exactRoot(
      receipt.artifactLineage.publication.evidenceDigest,
      'timeline publication evidence digest',
    );
    exactRoot(
      receipt.artifactLineage.publication.payloadRoot,
      'timeline publication payload root',
    );
    if (
      new URL(receipt.artifactLineage.publication.publicUrl).protocol !==
      'https:'
    )
      throw new Error('timeline publication readback URL must use HTTPS');
  }
  if (
    receipt.candidate?.preflightReceiptRoot ===
    receipt.artifactLineage?.promotionControllerReceiptDigest
  )
    throw new Error('preflight and controller evidence are substitutable');
  verifyAlphaCacheEvidence({ evidence: receipt.cacheEvidence });
  if (
    receipt.cacheEvidence.preflightReceiptRoot !==
    receipt.candidate.preflightReceiptRoot
  )
    throw new Error('timeline cache evidence is not bound to the preflight');
  return receipt;
}

export function summarizeAlphaReleaseSlo({ receipts, contract }) {
  const contractDigest = digest(contract);
  const compatible = receipts.filter(
    (receipt) => receipt.contract?.digest === contractDigest,
  );
  for (const receipt of compatible)
    verifyAlphaReleaseTimeline({ receipt, contract });
  const identities = new Set();
  const uniqueReceipts = [];
  let replayCount = 0;
  for (const receipt of compatible) {
    const identity = `${receipt.candidate.sourceCommit}:${receipt.candidate.promotionCommit}`;
    if (identities.has(identity)) {
      replayCount += 1;
      continue;
    }
    identities.add(identity);
    uniqueReceipts.push(receipt);
  }
  const real = uniqueReceipts.filter(
    (receipt) => receipt.slo.eligibleRealSample,
  );
  const controllable = real.map((receipt) => receipt.timing.controllableMs);
  const fullPath = real.map((receipt) => receipt.timing.fullPathMs);
  const cacheSavedTime = real
    .map(
      (receipt) =>
        receipt.cacheEvidence?.summary?.metrics?.savedTime?.observedTotal,
    )
    .filter(Number.isFinite);
  const cacheOutcomes = Object.fromEntries(
    ['hit', 'miss', 'partial', 'bypassed', 'poisoned', 'unavailable'].map(
      (outcome) => [
        outcome,
        real.reduce(
          (sum, receipt) =>
            sum +
            Number(receipt.cacheEvidence?.summary?.outcomes?.[outcome] || 0),
          0,
        ),
      ],
    ),
  );
  const enough = real.length >= contract.slo.minimumRealSamples;
  const p50 = percentile(controllable, 50);
  const p90 = percentile(fullPath, 90);
  return {
    schema: 'kungfu.alpha-release-slo-report/v1',
    sampleCount: real.length,
    rehearsalCount: uniqueReceipts.length - real.length,
    replayCount,
    incompatibleReceiptCount: receipts.length - compatible.length,
    minimumRealSamples: contract.slo.minimumRealSamples,
    verdict: enough
      ? p50 <= contract.slo.controllableP50Seconds * 1000 &&
        p90 <= contract.slo.fullPathP90Seconds * 1000
        ? 'meeting-slo'
        : 'slo-regression'
      : contract.slo.lowSampleVerdict,
    controllableP50Ms: p50,
    fullPathP90Ms: p90,
    cacheOutcomes,
    cacheSavedTimeObservedMs:
      cacheSavedTime.length > 0
        ? cacheSavedTime.reduce((sum, value) => sum + value, 0)
        : null,
  };
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  } catch (error) {
    throw new Error(
      `failed to read ${label}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!flag?.startsWith('--') || index + 1 >= rest.length)
      throw new Error(`invalid timeline option: ${flag || '<missing>'}`);
    options[flag.slice(2)] = rest[index + 1];
  }
  return { command, options };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(path.resolve(file), `${JSON.stringify(value, null, 2)}\n`);
}

function main(argv = process.argv.slice(2)) {
  const { command, options } = parse(argv);
  const contract = readJson(
    options.contract ||
      path.join(ROOT, 'docs/qualification/alpha-release-latency.contract.json'),
    'Alpha latency contract',
  );
  if (command === 'write') {
    const publication = options.publication
      ? readJson(options.publication, 'publication reference')
      : {};
    writeJson(
      required(options.out, '--out'),
      createAlphaReleaseTimeline({
        contract,
        preflightReceipt: readJson(
          required(options.preflight, '--preflight'),
          'preflight receipt',
        ),
        sourceCommit: options['source-commit'],
        sourceTree: options['source-tree'],
        promotionCommit: options['promotion-commit'],
        promotionTree: options['promotion-tree'],
        runs: readJson(required(options.runs, '--runs'), 'workflow runs'),
        controllerReceipt: readJson(
          required(options.controller, '--controller'),
          'controller receipt',
        ),
        candidateArtifact: options['candidate-artifact'],
        cacheEvidence: readJson(
          required(options['cache-evidence'], '--cache-evidence'),
          'structured cache evidence',
        ),
        publication,
        mode: options.mode || 'rehearsal',
      }),
    );
    return;
  }
  if (command === 'verify') {
    verifyAlphaReleaseTimeline({
      receipt: readJson(
        required(options.receipt, '--receipt'),
        'timeline receipt',
      ),
      contract,
    });
    return;
  }
  if (command === 'slo') {
    const directory = path.resolve(required(options.inputs, '--inputs'));
    const receipts = fs
      .readdirSync(directory)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => readJson(path.join(directory, file), file));
    writeJson(
      required(options.out, '--out'),
      summarizeAlphaReleaseSlo({ receipts, contract }),
    );
    return;
  }
  throw new Error(`unknown Alpha timeline command: ${command || '<missing>'}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
