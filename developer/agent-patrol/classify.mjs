#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { validateExperimentReport } from '@kungfu-tech/work/agent-repository-work/report';

const CLASSIFICATION_SCHEMA = 'kungfu.agent-patrol.classification/v1';
const FINDING_INTENT_SCHEMA = 'kungfu.agent-patrol.finding-intent/v1';
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SOURCE_HEAD_PATTERN = /^[0-9a-f]{40}$/u;
const FAILURE_CATEGORIES = new Set([
  'verifier',
  'warrant-scope',
  'kungfu-continuity',
  'timeout',
  'model-tool-runtime',
  'runner-environment',
]);
const BLOCKING_CATEGORIES = new Set(['runner-environment', 'warrant-scope']);

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

function stableMessageRoot(value) {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/sha256:[0-9a-f]{64}/gu, '<root>')
    .replace(/\b[0-9a-f]{40}\b/gu, '<git-head>')
    .replace(/(?:[a-z]:\\|\/)[^\s"'`]+/giu, '<absolute-path>')
    .replace(/\b\d{6,}\b/gu, '<number>')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 500);
  if (!normalized) throw new Error('failure message is required');
  return jsonRoot(normalized);
}

function rootsFromReport(report) {
  const candidates = [
    report.sessions?.a?.reportRoot,
    report.sessions?.b?.reportRoot,
    report.claim?.root,
    report.assessment?.root,
    report.continuity?.root,
    report.oracle?.reportRoot,
    report.failure?.outputRoot,
  ];
  return [
    ...new Set(candidates.filter((value) => ROOT_PATTERN.test(value || ''))),
  ].sort();
}

function titleFor(category) {
  const titles = {
    verifier: 'Agent Patrol repair failed deterministic verification',
    'warrant-scope': 'Agent Patrol exceeded the bounded repair Warrant',
    'kungfu-continuity': 'Agent Patrol continuity contract failed',
    timeout: 'Agent Patrol local-model execution timed out',
    'model-tool-runtime': 'Agent Patrol model or tool runtime failed',
    'runner-environment': 'Agent Patrol runner environment failed',
  };
  return titles[category];
}

function summaryFor(category) {
  const summaries = {
    verifier:
      'The bounded repository-work run completed but the external visible-plus-hidden oracle rejected the repair.',
    'warrant-scope':
      'The bounded repository-work run produced a change outside the declared three-file Warrant.',
    'kungfu-continuity':
      'The bounded repository-work run did not satisfy the native transcript-free continuation contract.',
    timeout:
      'The bounded repository-work run exceeded its declared local-model execution timeout.',
    'model-tool-runtime':
      'The bounded repository-work run could not complete through the pinned OpenCode local-model runtime.',
    'runner-environment':
      'The trusted runner could not provide the declared bounded repository-work execution environment.',
  };
  return summaries[category];
}

function validateExpectedIdentity(report, expected) {
  if (!SOURCE_HEAD_PATTERN.test(report.sourceHead || ''))
    throw new Error('report sourceHead is not an exact Git commit');
  if (expected.sourceHead && report.sourceHead !== expected.sourceHead)
    throw new Error('report sourceHead does not match the requested source');
  if (report.runtime?.provider !== 'opencode')
    throw new Error('report provider is not OpenCode');
  if (report.runtime?.model !== expected.model)
    throw new Error('report model does not match the Patrol contract');
  if (report.runtime?.image !== expected.image)
    throw new Error('report image does not match the Patrol contract');
  if (report.runtime?.context !== 65_536)
    throw new Error('report context does not match the Patrol contract');
  if (report.nonClaims?.modelRanking !== true)
    throw new Error('model-ranking non-claim boundary is required');
}

export function classifyReport(
  report,
  { runnerExit, sourceHead, model, image, runner = 'agent-121-kungfu-systems' },
) {
  if (!Number.isInteger(runnerExit) || runnerExit < 0)
    throw new Error('runnerExit must be a non-negative integer');
  validateExperimentReport(report);
  validateExpectedIdentity(report, { sourceHead, model, image });

  const reportRoot = jsonRoot(report);
  if (report.passed === true) {
    if (runnerExit !== 0)
      throw new Error('passing report disagrees with the runner exit status');
    return {
      schema: CLASSIFICATION_SCHEMA,
      outcome: 'passed',
      blocking: false,
      captureRequired: false,
      reason: 'deterministic-oracle-passed',
      reportRoot,
      sourceHead: report.sourceHead,
      runner,
      findingIntent: null,
      issueAdmission: 'prohibited',
    };
  }

  const category = String(report.failure?.category || '');
  if (!FAILURE_CATEGORIES.has(category))
    throw new Error('failure report category is unsupported');
  const messageRoot = stableMessageRoot(report.failure?.message);
  const evidenceRoots = rootsFromReport(report);
  const fingerprintRoot = jsonRoot({
    schema: 'kungfu.agent-patrol.failure-fingerprint/v1',
    experiment: report.fixture?.id,
    provider: report.runtime.provider,
    model: report.runtime.model,
    image: report.runtime.image,
    category,
    messageRoot,
  });
  const findingId = `patrol-agent-repository-work-${fingerprintRoot.slice(7, 39)}`;
  const blocking = BLOCKING_CATEGORIES.has(category) || runnerExit === 0;
  const episodeRoot = evidenceRoots[0] || reportRoot;
  const findingIntent = {
    schema: FINDING_INTENT_SCHEMA,
    fingerprintRoot,
    findingId,
    capture: {
      findingId,
      title: titleFor(category),
      summary: summaryFor(category),
      episodeRoot,
      evidenceRoots: [...new Set([reportRoot, ...evidenceRoots])].sort(),
      dimensions: {
        repository: ['kungfu'],
        component: ['agent-patrol', 'agent-repository-work'],
        capability: ['local-model-agent-patrol'],
        command: ['qualify:agent-repository-work'],
        error: [category, `fingerprint:${fingerprintRoot.slice(7, 23)}`],
        build: [`source:${report.sourceHead}`],
        platform: ['linux-x64', 'agent-121'],
        tag: [
          'opencode',
          'qwen3-coder',
          `fixture:${report.fixture.id}`,
          blocking ? 'blocking' : 'advisory',
        ],
        evidence: ['bounded-report'],
      },
      privacy: 'internal',
      impact: 'normal',
      recurrence: 1,
    },
  };

  return {
    schema: CLASSIFICATION_SCHEMA,
    outcome: blocking ? 'blocking-failure' : 'advisory-failure',
    blocking,
    captureRequired: true,
    reason:
      runnerExit === 0
        ? 'runner-exit-report-disagreement'
        : `classified-${category}`,
    category,
    messageRoot,
    reportRoot,
    sourceHead: report.sourceHead,
    runner,
    findingIntent,
    issueAdmission: 'prohibited',
  };
}

export function parseArgs(argv) {
  const result = {
    report: '',
    output: '',
    runnerExit: null,
    sourceHead: '',
    model: '',
    image: '',
    runner: 'agent-121-kungfu-systems',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--report') result.report = argv[++index] || '';
    else if (arg === '--output') result.output = argv[++index] || '';
    else if (arg === '--runner-exit')
      result.runnerExit = Number.parseInt(argv[++index] || '', 10);
    else if (arg === '--source-head') result.sourceHead = argv[++index] || '';
    else if (arg === '--model') result.model = argv[++index] || '';
    else if (arg === '--image') result.image = argv[++index] || '';
    else if (arg === '--runner') result.runner = argv[++index] || '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const field of ['report', 'output', 'sourceHead', 'model', 'image'])
    if (!result[field])
      throw new Error(
        `--${field.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)} is required`,
      );
  return result;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = JSON.parse(fs.readFileSync(options.report, 'utf8'));
    const classification = classifyReport(report, options);
    writeJson(options.output, classification);
    process.stdout.write(
      `${JSON.stringify({
        outcome: classification.outcome,
        blocking: classification.blocking,
        captureRequired: classification.captureRequired,
        findingId: classification.findingIntent?.findingId || null,
        reportRoot: classification.reportRoot,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 2;
  }
}
