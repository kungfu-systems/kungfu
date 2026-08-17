#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPORT_SCHEMA = 'kungfu.dev-required-latency/v1';
const CLASSIFICATION_SCHEMA =
  'kungfu.dev-gate-latency-patrol.classification/v1';
const FINDING_INTENT_SCHEMA =
  'kungfu.dev-gate-latency-patrol.finding-intent/v1';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

export function jsonRoot(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;
}

const DETAILS = {
  'required-latency-slo': [
    'Dev required Gate latency exceeded its rolling SLO',
    'The latest merged pull-request window exceeded the required Gate latency target.',
  ],
  'merge-queue-delivery-slo': [
    'Dev merge queue delivery exceeded its rolling SLO',
    'The latest merged pull-request window exceeded the merge queue delivery target.',
  ],
  'merge-queue-dequeue': [
    'Dev merge queue observed a dequeue regression',
    'The latest merged pull-request window contains a non-merged queue exit.',
  ],
  'merge-queue-revalidation': [
    'Dev merge queue repeated validation work',
    'The latest merged pull-request window contains repeated merge-group validation.',
  ],
  'merge-queue-waste': [
    'Dev merge queue consumed runner time after failed delivery',
    'The latest merged pull-request window contains wasted or post-dequeue runner time.',
  ],
  'insufficient-evidence': [
    'Dev Gate latency window has insufficient evidence',
    'The rolling monitor could not assemble the minimum complete evidence window.',
  ],
  'unknown-attribution': [
    'Dev Gate latency window contains unknown attribution',
    'The rolling monitor found samples whose native or cache attribution is incomplete.',
  ],
  'monitor-infrastructure': [
    'Dev Gate latency monitor infrastructure failed',
    'The rolling monitor could not produce a valid bounded report.',
  ],
};

function findingIntent({ repository, branch, category, reportRoot }) {
  const fingerprintRoot = jsonRoot({
    schema: 'kungfu.dev-gate-latency-patrol.fingerprint/v1',
    repository,
    branch,
    category,
  });
  const findingId = `dev-gate-latency-${fingerprintRoot.slice(7, 39)}`;
  const [title, summary] = DETAILS[category];
  return {
    schema: FINDING_INTENT_SCHEMA,
    fingerprintRoot,
    findingId,
    category,
    capture: {
      findingId,
      title,
      summary,
      episodeRoot: reportRoot,
      evidenceRoots: [reportRoot],
      dimensions: {
        repository: ['kungfu'],
        component: ['dev-gate', 'merge-queue'],
        capability: ['rolling-latency-monitor'],
        command: ['gate:latency:measure'],
        error: [category],
        build: [`branch:${branch}`],
        platform: ['github-actions', 'agent-121'],
        tag: ['non-blocking-patrol', 'window:30'],
        evidence: ['queue-inclusive-report'],
      },
      privacy: 'internal',
      impact: category.includes('slo') ? 'high_friction' : 'medium',
      recurrence: 1,
    },
  };
}

function classification(repository, branch, reportRoot, categories) {
  const unique = [...new Set(categories)].sort();
  return {
    schema: CLASSIFICATION_SCHEMA,
    outcome: unique.length ? 'attention-required' : 'healthy',
    captureRequired: unique.length > 0,
    requiredGate: false,
    issueAdmission: 'prohibited',
    repository,
    branch,
    reportRoot,
    categories: unique,
    findingIntents: unique.map((category) =>
      findingIntent({ repository, branch, category, reportRoot }),
    ),
  };
}

export function classifyLatencyReport(report, { repository, branch }) {
  if (report?.schema !== REPORT_SCHEMA)
    return classifyMonitorFailure({
      repository,
      branch,
      failureClass: 'invalid-report',
    });
  if (report.repository !== repository || report.branch !== branch)
    return classifyMonitorFailure({
      repository,
      branch,
      failureClass: 'identity-mismatch',
    });
  const categories = [];
  const all = report.statistics?.all || {};
  const native = report.statistics?.native || {};
  const unknown = report.statistics?.unknown || {};
  const queue = report.mergeQueueDelivery || {};
  const enoughRequired = all.sampleCount >= 20 && native.sampleCount >= 10;
  const enoughQueue = queue.statistics?.sampleCount >= 20;
  const latencyOnly =
    report.collection?.evidenceMode === 'latency-only' &&
    report.collection?.nativeArtifacts === 'skipped';
  const attributionIncomplete =
    unknown.sampleCount > 0 || (!latencyOnly && report.cache?.unknownCount > 0);
  const runnerWaitEvidenceCount = queue.runnerWait?.evidenceObservedCount ?? 0;
  const unexplainedRepeatedValidationCount =
    queue.unexplainedRepeatedValidationCount ??
    queue.repeatedValidationCount ??
    0;

  if (
    !enoughRequired ||
    !enoughQueue ||
    queue.incompleteCount > 0 ||
    queue.notObservedCount > 0 ||
    queue.runnerEvidenceObservedCount < queue.queueObservedCount ||
    runnerWaitEvidenceCount < queue.queueObservedCount
  )
    categories.push('insufficient-evidence');
  if (attributionIncomplete) categories.push('unknown-attribution');
  if (
    enoughRequired &&
    !attributionIncomplete &&
    (Math.max(all.p50Ms, native.p50Ms) > 300_000 ||
      Math.max(all.p95Ms, native.p95Ms) > 600_000)
  )
    categories.push('required-latency-slo');
  if (enoughQueue && queue.verdict?.qualified === false)
    categories.push('merge-queue-delivery-slo');
  if (queue.dequeue?.pullRequestCount > 0)
    categories.push('merge-queue-dequeue');
  if (unexplainedRepeatedValidationCount > 0)
    categories.push('merge-queue-revalidation');
  if (queue.wastedRunnerMs > 0 || queue.postDequeueRunnerMs > 0)
    categories.push('merge-queue-waste');
  return classification(repository, branch, jsonRoot(report), categories);
}

export function classifyMonitorFailure({ repository, branch, failureClass }) {
  const reportRoot = jsonRoot({
    schema: 'kungfu.dev-gate-latency-patrol.failure/v1',
    repository,
    branch,
    failureClass: String(failureClass || 'collector-failure')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/gu, '-')
      .slice(0, 80),
  });
  return classification(repository, branch, reportRoot, [
    'monitor-infrastructure',
  ]);
}

export function parseArgs(argv) {
  const result = {
    report: '',
    output: '',
    repository: '',
    branch: '',
    collectorExit: 0,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--report') result.report = argv[++index] || '';
    else if (arg === '--output') result.output = argv[++index] || '';
    else if (arg === '--repository') result.repository = argv[++index] || '';
    else if (arg === '--branch') result.branch = argv[++index] || '';
    else if (arg === '--collector-exit')
      result.collectorExit = Number.parseInt(argv[++index] || '', 10);
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const field of ['report', 'output', 'repository', 'branch'])
    if (!result[field])
      throw new Error(
        `--${field.replace(/[A-Z]/gu, (char) => `-${char.toLowerCase()}`)} is required`,
      );
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    let value;
    if (options.collectorExit !== 0 || !fs.existsSync(options.report)) {
      value = classifyMonitorFailure({
        ...options,
        failureClass: `collector-exit-${options.collectorExit}`,
      });
    } else {
      try {
        value = classifyLatencyReport(
          JSON.parse(fs.readFileSync(options.report, 'utf8')),
          options,
        );
      } catch {
        value = classifyMonitorFailure({
          ...options,
          failureClass: 'report-parse-failure',
        });
      }
    }
    fs.mkdirSync(path.dirname(path.resolve(options.output)), {
      recursive: true,
    });
    fs.writeFileSync(options.output, `${JSON.stringify(value, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({ outcome: value.outcome, categories: value.categories })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 2;
  }
}
