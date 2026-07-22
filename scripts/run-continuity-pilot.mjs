#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_PATH = path.join(
  ROOT,
  'framework/agent-work/kungfu-continuity-pilot.contract.json',
);
const FIXTURE_PATH = path.join(
  ROOT,
  'framework/agent-work/fixtures/continuity-pilot-v1.json',
);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

export function jsonRoot(value) {
  const bytes = JSON.stringify(canonical(value));
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function fileRoot(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${label} is required`);
}

function walk(value, visit, pointer = '$') {
  visit(value, pointer);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries())
      walk(item, visit, `${pointer}[${index}]`);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value))
      walk(item, visit, `${pointer}.${key}`);
  }
}

export function validateReportPair(reports) {
  const { baseline, kungfu } = reports;
  for (const [name, report] of Object.entries({ baseline, kungfu })) {
    if (report?.schema !== 'kungfu.continuity-pilot-report/v1')
      throw new Error(`${name} report schema is unsupported`);
    for (const field of readJson(CONTRACT_PATH).requiredReportFields) {
      if (!(field in report)) throw new Error(`${name} report misses ${field}`);
    }
    requiredString(report.runIdentity?.id, `${name} run identity`);
    requiredString(report.artifactSource?.sourceHead, `${name} source head`);
    requiredString(report.fixture?.taskRoot, `${name} task root`);
    requiredString(
      report.fixture?.initialTreeRoot,
      `${name} initial tree root`,
    );
    requiredString(report.provider?.agent, `${name} provider agent`);
    requiredString(report.provider?.version, `${name} provider version`);
    requiredString(report.provider?.configRoot, `${name} provider config root`);
    if (report.reset?.hiddenTranscriptInjected !== false)
      throw new Error(`${name} hidden transcript injection is forbidden`);
    if (report.reset?.privateSessionStoreRead !== false)
      throw new Error(`${name} private session store access is forbidden`);
    requiredString(report.oracle?.root, `${name} oracle`);
    if (report.evidenceClass !== 'preparatory')
      throw new Error(`${name} evidence class must remain preparatory`);
    if (report.profile !== 'one-minute-continuity-smoke')
      throw new Error(`${name} profile must remain a smoke`);
    if (report.claimClass !== 'preparatory-smoke')
      throw new Error(`${name} smoke cannot be presented as FO10`);
  }
  const same = [
    ['run identity', baseline.runIdentity.id, kungfu.runIdentity.id],
    ['task root', baseline.fixture.taskRoot, kungfu.fixture.taskRoot],
    [
      'initial tree root',
      baseline.fixture.initialTreeRoot,
      kungfu.fixture.initialTreeRoot,
    ],
    ['provider agent', baseline.provider.agent, kungfu.provider.agent],
    ['provider version', baseline.provider.version, kungfu.provider.version],
    [
      'provider config',
      baseline.provider.configRoot,
      kungfu.provider.configRoot,
    ],
    ['oracle', baseline.oracle.root, kungfu.oracle.root],
  ];
  for (const [label, left, right] of same) {
    if (left !== right) throw new Error(`paths do not share the same ${label}`);
  }
  if (baseline.path !== 'baseline' || kungfu.path !== 'kungfu')
    throw new Error('baseline and Kungfu path identities are required');
  return true;
}

export function validatePublicProjection(projection) {
  if (projection?.schema !== 'kungfu.continuity-public-projection/v1')
    throw new Error('public projection schema is unsupported');
  if (projection.evidenceClass !== 'preparatory')
    throw new Error('public projection must remain preparatory');
  if (projection.claimClass !== 'preparatory-smoke')
    throw new Error('public projection cannot claim FO10');
  for (const key of ['baselineReportRoot', 'kungfuReportRoot', 'rawIndexRoot'])
    requiredString(projection.sourceEvidence?.[key], key);
  const forbidden =
    /speedup|success.?rate|fo10.?pass|market.?lead|retention.?improv/i;
  walk(projection, (value, pointer) => {
    if (
      forbidden.test(pointer) ||
      (typeof value === 'string' && forbidden.test(value))
    )
      throw new Error(`fabricated or forbidden public metric at ${pointer}`);
  });
  return true;
}

function parseArgs(argv) {
  const result = { output: '', sourceHead: '', runId: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--output') result.output = argv[++index] || '';
    else if (arg === '--source-head') result.sourceHead = argv[++index] || '';
    else if (arg === '--run-id') result.runId = argv[++index] || '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}

function writeInitialTree(root, initialTree) {
  for (const [relative, content] of Object.entries(initialTree)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function currentHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
}

function runPath({ name, root, fixture, shared, budget }) {
  const started = performance.now();
  writeInitialTree(root, fixture.initialTree);
  const events = [
    { sequence: 1, event: 'initial-tree-materialized' },
    { sequence: 2, event: 'inventory-inspected', itemCount: 3 },
  ];
  if (name === 'kungfu') {
    const fact = {
      ...fixture.phaseOne.durableFact,
      taskRoot: shared.taskRoot,
      initialTreeRoot: shared.initialTreeRoot,
    };
    writeJson(path.join(root, '.continuity/fact.json'), fact);
    events.push({
      sequence: 3,
      event: 'durable-continuation-fact-written',
      factRoot: jsonRoot(fact),
    });
  } else {
    events.push({ sequence: 3, event: 'no-continuation-input' });
  }

  events.push({
    sequence: 4,
    event: 'fresh-worker-started',
    transcriptInjected: false,
  });
  const factPath = path.join(root, '.continuity/fact.json');
  let continuationSource = 'none';
  let verdict = 'unsupported';
  if (fs.existsSync(factPath)) {
    const fact = readJson(factPath);
    if (fact.taskRoot !== shared.taskRoot)
      throw new Error('durable fact task root does not match the fixture');
    fs.writeFileSync(
      path.join(root, fixture.oracle.path),
      fixture.oracle.content,
    );
    continuationSource = 'durable-fact';
    verdict = 'pass';
    events.push({ sequence: 5, event: 'continued-from-durable-fact' });
  } else {
    events.push({ sequence: 5, event: 'continuation-input-unavailable' });
  }
  const oraclePath = path.join(root, fixture.oracle.path);
  const oraclePassed =
    fs.existsSync(oraclePath) &&
    fs.readFileSync(oraclePath, 'utf8') === fixture.oracle.content;
  events.push({ sequence: 6, event: 'oracle-evaluated', passed: oraclePassed });
  const wallTimeMs = Math.round((performance.now() - started) * 1000) / 1000;
  if (wallTimeMs > budget.wallTimeSeconds * 1000)
    throw new Error('continuity pilot exceeded its hard wall-time budget');

  return {
    report: {
      schema: 'kungfu.continuity-pilot-report/v1',
      profile: 'one-minute-continuity-smoke',
      claimClass: 'preparatory-smoke',
      runIdentity: shared.runIdentity,
      artifactSource: shared.artifactSource,
      fixture: {
        id: fixture.id,
        taskRoot: shared.taskRoot,
        initialTreeRoot: shared.initialTreeRoot,
      },
      path: name,
      provider: shared.provider,
      reset: {
        boundary: 'fresh deterministic worker invocation',
        hiddenTranscriptInjected: false,
        privateSessionStoreRead: false,
        continuationSource,
      },
      measurements: {
        wallTimeMs,
        attempts: 1,
        toolCalls: 0,
        humanReExplanation: 0,
        duplicateWork: name === 'baseline' ? 1 : 0,
      },
      oracle: {
        root: shared.oracleRoot,
        passed: oraclePassed,
      },
      evidenceCitations: events.map((event) => `events.json#${event.sequence}`),
      limitations: [
        'The worker is deterministic fixture code, not a hosted or native model agent.',
        'The baseline has no continuation mechanism; this run validates the pipeline, not a provider performance comparison.',
        'Durability, multi-hour recovery, user retention, and FO10 remain untested.',
      ],
      evidenceClass: 'preparatory',
      verdict,
    },
    events,
  };
}

export function runPilot(options = {}) {
  const contract = readJson(CONTRACT_PATH);
  const fixture = readJson(FIXTURE_PATH);
  const output = path.resolve(
    options.output ||
      fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-continuity-')),
  );
  if (fs.existsSync(output) && fs.readdirSync(output).length > 0)
    throw new Error('output directory must be new or empty');
  fs.mkdirSync(output, { recursive: true });
  const sourceHead = options.sourceHead || currentHead();
  requiredString(sourceHead, 'source head');
  const runIdentity = {
    id: options.runId || `continuity-pilot-${sourceHead.slice(0, 12)}`,
    protocol: contract.id,
  };
  const shared = {
    runIdentity,
    artifactSource: {
      repository: 'kungfu-systems/kungfu',
      sourceHead,
      runnerRoot: fileRoot(fileURLToPath(import.meta.url)),
      contractRoot: fileRoot(CONTRACT_PATH),
      fixtureRoot: fileRoot(FIXTURE_PATH),
    },
    taskRoot: jsonRoot(fixture.task),
    initialTreeRoot: jsonRoot(fixture.initialTree),
    oracleRoot: jsonRoot(fixture.oracle),
    provider: {
      agent: 'local-deterministic-fixture-worker',
      version: 'v1',
      configRoot: jsonRoot({ mode: 'fresh-process-equivalent', attempts: 1 }),
    },
  };
  const baseline = runPath({
    name: 'baseline',
    root: path.join(output, 'disposable/baseline'),
    fixture,
    shared,
    budget: contract.budget,
  });
  const kungfu = runPath({
    name: 'kungfu',
    root: path.join(output, 'disposable/kungfu'),
    fixture,
    shared,
    budget: contract.budget,
  });
  validateReportPair({ baseline: baseline.report, kungfu: kungfu.report });

  writeJson(path.join(output, 'baseline-report.json'), baseline.report);
  writeJson(path.join(output, 'kungfu-report.json'), kungfu.report);
  writeJson(path.join(output, 'raw/baseline-events.json'), baseline.events);
  writeJson(path.join(output, 'raw/kungfu-events.json'), kungfu.events);
  const rawIndex = {
    schema: 'kungfu.continuity-raw-evidence-index/v1',
    runIdentity,
    entries: [
      'baseline-report.json',
      'kungfu-report.json',
      'raw/baseline-events.json',
      'raw/kungfu-events.json',
    ].map((relative) => ({
      path: relative,
      root: fileRoot(path.join(output, relative)),
    })),
  };
  writeJson(path.join(output, 'raw-evidence-index.json'), rawIndex);
  const projection = {
    schema: 'kungfu.continuity-public-projection/v1',
    publicOutcome: contract.publicOutcome,
    claimClass: 'preparatory-smoke',
    evidenceClass: 'preparatory',
    sourceEvidence: {
      baselineReportRoot: jsonRoot(baseline.report),
      kungfuReportRoot: jsonRoot(kungfu.report),
      rawIndexRoot: jsonRoot(rawIndex),
    },
    observed: {
      task: fixture.task,
      reset:
        'Both paths started a fresh deterministic worker with no transcript or private session store.',
      baseline: {
        verdict: baseline.report.verdict,
        continuationSource: baseline.report.reset.continuationSource,
        oraclePassed: baseline.report.oracle.passed,
      },
      kungfu: {
        verdict: kungfu.report.verdict,
        continuationSource: kungfu.report.reset.continuationSource,
        oraclePassed: kungfu.report.oracle.passed,
      },
    },
    limitations: kungfu.report.limitations,
  };
  validatePublicProjection(projection);
  writeJson(path.join(output, 'public-projection.json'), projection);
  const animation = {
    schema: 'kungfu.continuity-animation-pack/v1',
    sourceProjectionRoot: jsonRoot(projection),
    durationSeconds: 32,
    storyboard: [
      { id: 'task', from: 0, to: 5, data: '$.observed.task' },
      {
        id: 'inspection',
        from: 5,
        to: 11,
        annotation: 'Both paths inspect the same tiny repository.',
      },
      { id: 'reset', from: 11, to: 18, data: '$.observed.reset' },
      { id: 'continuation', from: 18, to: 26, data: '$.observed' },
      { id: 'boundary', from: 26, to: 32, data: '$.limitations' },
    ],
    redactionRules: [
      'Do not expose absolute paths, environment variables, private logs, transcripts, provider credentials, or session identifiers.',
      'Use only values present in public-projection.json.',
      'Label design annotations separately from observed evidence.',
    ],
    framing: {
      desktop:
        '16:9 split path with reset centered and evidence boundary footer',
      mobile:
        '9:16 stacked path with the same scene order and persistent preparatory label',
    },
    staticFallback:
      'In a local deterministic fixture, the Kungfu path continued from one durable fact after reset; the baseline path had no continuation input. This validates the evidence pipeline, not product or long-task performance.',
    howThisWasTested: {
      command:
        './shifu qualify:continuity-pilot -- --output <disposable-output>',
      sourceHead,
      fixtureRoot: shared.artifactSource.fixtureRoot,
      reportRoots: projection.sourceEvidence,
      evidenceClass: 'preparatory',
    },
  };
  writeJson(path.join(output, 'animation-pack.json'), animation);
  return {
    output,
    baseline: baseline.report,
    kungfu: kungfu.report,
    projection,
    animation,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = runPilot(options);
    process.stdout.write(
      `${JSON.stringify({ schema: 'kungfu.continuity-pilot-run/v1', output: result.output, baselineVerdict: result.baseline.verdict, kungfuVerdict: result.kungfu.verdict, evidenceClass: result.projection.evidenceClass }, null, 2)}\n`,
    );
  } catch (error) {
    console.error(
      `[continuity-pilot] ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  }
}
