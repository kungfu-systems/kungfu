#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_REPOSITORY_WORK_FIXTURE_ID,
  getRepositoryWorkFixture,
} from '../../tests/qualification/agent-repository-work/fixture-catalog.mjs';
import {
  materializeIncidentBoardFixture,
  qualifySeededIncidentBoardFixture,
  verifyIncidentBoardWorkspace,
} from '../../tests/qualification/agent-repository-work/incident-board-replay-v1-oracle.mjs';
import {
  materializeRealModuleSnapshot,
  qualifySeededRealModuleSnapshot,
  verifyRealModuleSnapshotWorkspace,
} from '../../tests/qualification/agent-repository-work/kungfu-agent-patrol-real-module-snapshot-v1-oracle.mjs';
import { validateExperimentReport } from './report.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const PROXY_PATH = path.join(
  ROOT,
  'framework/agent-repository-work/opencode-docker-proxy.mjs',
);
const CONTRACT_PATH = path.join(
  ROOT,
  'tests/qualification/agent-repository-work/contract.json',
);
const REPORT_SCHEMA = 'kungfu.agent-repository-work.report/v1';
const PROFILE_SCHEMA = 'kungfu.agent-runtime-profile/v1';
const DEFAULT_IMAGE =
  'ghcr.io/kungfu-systems/build-images/opencode-ci@sha256:4083ee089fa9a419f4915505094a6c1bcce433ff77455605ce8993af3b684ed3';
const DEFAULT_MODEL = 'qwen3-coder:30b-opencode-64k';
const DEFAULT_BASE_URL = 'http://host.docker.internal:11435/v1';

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

function fileRoot(file) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex')}`;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function parseArgs(argv) {
  const result = {
    output: '',
    image: DEFAULT_IMAGE,
    model: DEFAULT_MODEL,
    baseUrl: DEFAULT_BASE_URL,
    opencode: '',
    sourceHead: '',
    timeoutSeconds: 900,
    fixture: DEFAULT_REPOSITORY_WORK_FIXTURE_ID,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--output') result.output = argv[++index] || '';
    else if (arg === '--image') result.image = argv[++index] || '';
    else if (arg === '--model') result.model = argv[++index] || '';
    else if (arg === '--base-url') result.baseUrl = argv[++index] || '';
    else if (arg === '--opencode') result.opencode = argv[++index] || '';
    else if (arg === '--source-head') result.sourceHead = argv[++index] || '';
    else if (arg === '--fixture') result.fixture = argv[++index] || '';
    else if (arg === '--timeout-seconds')
      result.timeoutSeconds = Number.parseInt(argv[++index] || '', 10);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(result.timeoutSeconds) || result.timeoutSeconds < 60)
    throw new Error('--timeout-seconds must be an integer of at least 60');
  if (!result.opencode && !result.image.includes('@sha256:'))
    throw new Error('--image must be pinned by digest');
  getRepositoryWorkFixture(result.fixture);
  return result;
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout || 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const evidence = `${result.stdout || ''}\n${result.stderr || ''}`;
    const error = new Error(
      `${commandName} exited ${result.status}; output root ${jsonRoot(evidence)}`,
    );
    error.command = commandName;
    error.status = result.status;
    error.outputRoot = jsonRoot(evidence);
    throw error;
  }
  return result.stdout;
}

function currentHead() {
  return command('git', ['rev-parse', 'HEAD']).trim();
}

function pythonKungfu(args, { home, configHome, cwd, timeout }) {
  const pythonPath = [
    path.join(ROOT, 'framework/core/src/python'),
    process.env.KUNGFU_NATIVE_PATH ||
      path.join(ROOT, 'framework/core/build/Release'),
    process.env.PYTHONPATH,
  ]
    .filter(Boolean)
    .join(path.delimiter);
  return command(
    'uv',
    [
      'run',
      '--project',
      path.join(ROOT, 'framework/core'),
      '--frozen',
      'python',
      '-m',
      'kungfu',
      '--home',
      home,
      ...args,
    ],
    {
      cwd,
      timeout,
      env: {
        PYTHONPATH: pythonPath,
        KF_CONFIG_HOME: configHome,
        KUNGFU_CONFIG_CONTRACT: path.join(
          ROOT,
          'framework/config/kungfu-config.contract.json',
        ),
      },
    },
  );
}

function treeRows(workspace) {
  const rows = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path
        .relative(workspace, absolute)
        .split(path.sep)
        .join('/');
      const stats = fs.lstatSync(absolute);
      if (stats.isSymbolicLink())
        throw new Error(`workspace symlink is forbidden: ${relative}`);
      if (stats.isDirectory()) walk(absolute);
      else if (stats.isFile())
        rows.push({
          path: relative,
          bytes: stats.size,
          root: fileRoot(absolute),
        });
    }
  }
  walk(workspace);
  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

function lineCount(content) {
  if (content.length === 0) return 0;
  return content.toString('utf8').split('\n').length;
}

function symbols(content, relative) {
  const text = content.toString('utf8');
  const pattern = relative.endsWith('.py')
    ? /^(?:async\s+)?(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gmu
    : /(?:^|\n)(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gu;
  return [...text.matchAll(pattern)].map((match) => match[1]).sort();
}

function metricRows(workspace) {
  return treeRows(workspace).map((row) => {
    const content = fs.readFileSync(path.join(workspace, row.path));
    return {
      ...row,
      lines: lineCount(content),
      symbolRoot: jsonRoot(symbols(content, row.path)),
    };
  });
}

function changeSignals(before, after, writablePaths) {
  const beforeByPath = new Map(before.map((row) => [row.path, row]));
  const afterByPath = new Map(after.map((row) => [row.path, row]));
  const changedPaths = [
    ...new Set([...beforeByPath.keys(), ...afterByPath.keys()]),
  ]
    .filter(
      (relative) =>
        beforeByPath.get(relative)?.root !== afterByPath.get(relative)?.root,
    )
    .sort();
  let lineDeltaAbs = 0;
  let byteDeltaAbs = 0;
  for (const relative of changedPaths) {
    const initial = beforeByPath.get(relative);
    const current = afterByPath.get(relative);
    lineDeltaAbs += Math.abs((current?.lines || 0) - (initial?.lines || 0));
    byteDeltaAbs += Math.abs((current?.bytes || 0) - (initial?.bytes || 0));
  }
  const structuralRows = changedPaths.map((relative) => {
    const initial = beforeByPath.get(relative);
    const current = afterByPath.get(relative);
    return {
      pathRoot: jsonRoot(relative),
      beforeBytes: initial?.bytes || 0,
      beforeLines: initial?.lines || 0,
      afterBytes: current?.bytes || 0,
      afterLines: current?.lines || 0,
    };
  });
  const symbolRows = changedPaths.map((relative) => ({
    pathRoot: jsonRoot(relative),
    beforeSymbolRoot: beforeByPath.get(relative)?.symbolRoot || null,
    afterSymbolRoot: afterByPath.get(relative)?.symbolRoot || null,
  }));
  return {
    changedPathCount: changedPaths.length,
    changedFileCount: changedPaths.length,
    lineDeltaAbs,
    byteDeltaAbs,
    expectedMutationSiteContact: changedPaths.some((relative) =>
      writablePaths.includes(relative),
    ),
    structuralFingerprintRoot: jsonRoot(structuralRows),
    symbolFingerprintRoot: jsonRoot(symbolRows),
  };
}

export function runtimeProfile({
  id,
  mode,
  model,
  image,
  baseUrl,
  opencode,
  agent,
  dockerHost = '',
}) {
  const nodeAdapter = opencode.endsWith('.mjs');
  const executable = !opencode || nodeAdapter ? process.execPath : opencode;
  const prefix = opencode
    ? nodeAdapter
      ? [path.resolve(opencode)]
      : []
    : [
        PROXY_PATH,
        '--image',
        image,
        '--base-url',
        baseUrl,
        '--model',
        model,
        '--context',
        '65536',
        '--mode',
        mode,
        ...(dockerHost ? ['--docker-host', dockerHost] : []),
        '--',
      ];
  return {
    schema: PROFILE_SCHEMA,
    id,
    label: `OpenCode repository work ${mode}`,
    provider: 'opencode',
    launch: {
      executable,
      argv: [
        ...prefix,
        'run',
        '--pure',
        '--model',
        `local/${model}`,
        '--agent',
        agent,
        '--format',
        'json',
      ],
      shellMode: false,
    },
    cwdPolicy: 'workspace-root',
    backendDefault: 'direct',
    bootstrap: { adapter: 'opencode', envelope: 'required' },
    source: 'user',
    lastVerified: null,
  };
}

function configureProfile(profile, context) {
  const args = [
    'agent',
    'runtime',
    'upsert',
    '--id',
    profile.id,
    '--label',
    profile.label,
    '--provider',
    profile.provider,
    '--executable',
    profile.launch.executable,
    ...profile.launch.argv.flatMap((arg) => [`--arg=${arg}`]),
    '--cwd-policy',
    profile.cwdPolicy,
    '--backend',
    profile.backendDefault,
    '--envelope',
    profile.bootstrap.envelope,
    '--execute',
    '--json',
  ];
  return JSON.parse(pythonKungfu(args, context));
}

function providerSessionId(run, label) {
  const values = run.providerObservation?.providerSessionIds || [];
  if (values.length !== 1)
    throw new Error(`${label} must expose exactly one provider session id`);
  return values[0];
}

export function parseInvestigationClaim(
  text,
  fixture = getRepositoryWorkFixture('incident-board-replay-v1'),
) {
  if (typeof text !== 'string' || !text.trim())
    throw new Error('Agent A returned no investigation claim');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const source =
    fenced?.[1] || text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    const error = new Error(
      'Agent A returned invalid JSON investigation output',
    );
    error.failureCategory = 'model-tool-runtime';
    throw error;
  }
  const expectedFailures = [...fixture.investigation.expectedFailures].sort();
  const expectedPaths = [...fixture.warrants.agentB.writablePaths].sort();
  if (
    value?.schema !== 'kungfu.agent-repository-work.investigation-claim/v1' ||
    value.investigationComplete !== true ||
    JSON.stringify([...(value.failingTests || [])].sort()) !==
      JSON.stringify(expectedFailures) ||
    JSON.stringify([...(value.repairPaths || [])].sort()) !==
      JSON.stringify(expectedPaths) ||
    value.remainingObligation !== fixture.investigation.remainingObligation ||
    value.nextAction !== fixture.investigation.nextAction
  )
    throw new Error(
      'Agent A investigation claim failed deterministic assessment',
    );
  return value;
}

export function classifyFailure(error) {
  if (error?.failureCategory === 'model-tool-runtime')
    return 'model-tool-runtime';
  const message = String(error?.message || error);
  if (/oracle|visible|hidden|seeded|test/iu.test(message)) return 'verifier';
  if (/scope|symlink|writable|tree|modified/iu.test(message))
    return 'warrant-scope';
  if (/continuation|WorkRef|claim|assessment/iu.test(message))
    return 'kungfu-continuity';
  if (/timeout|timed out/iu.test(message)) return 'timeout';
  if (/docker|opencode|provider session|profile/iu.test(message))
    return 'model-tool-runtime';
  return 'runner-environment';
}

function buildBaseReport(options, sourceHead, fixture) {
  const syntheticFiles = fixture.files || null;
  return {
    schema: REPORT_SCHEMA,
    evidenceClass: 'bounded-experiment',
    passed: false,
    sourceHead,
    fixture: {
      id: fixture.id,
      kind: fixture.kind || 'synthetic',
      fileCount: syntheticFiles ? Object.keys(syntheticFiles).length : null,
      lineCount: syntheticFiles
        ? Object.values(syntheticFiles).reduce(
            (count, content) => count + content.split('\n').length,
            0,
          )
        : null,
    },
    runtime: {
      provider: 'opencode',
      image: options.opencode ? null : options.image,
      directExecutable: options.opencode || null,
      model: options.model,
      baseUrlRoot: options.opencode ? null : jsonRoot(options.baseUrl),
      context: 65_536,
    },
    sessions: { distinct: 0 },
    continuity: {
      priorTranscriptBytes: 0,
      humanRestatementCount: 0,
    },
    warrant: {
      agentA: 'investigation-only',
      agentB: 'bounded-repair',
      writablePaths: [...fixture.warrants.agentB.writablePaths],
      verifierOutsideAgentWorkspace: true,
    },
    dimensions: {
      execution: null,
      correctness: null,
      scope: null,
      continuity: null,
      evidence: null,
      efficiency: null,
      residuals: null,
    },
    nonClaims: {
      auditableDemo: true,
      agentWorkLab: true,
      releaseGate: true,
      publicClaim: true,
      modelRanking: true,
    },
    changeSignals: null,
    failure: null,
  };
}

function materializeFixture(workspace, fixture, sourceHead) {
  if (fixture.kind === 'real-module-snapshot') {
    const materialized = materializeRealModuleSnapshot(workspace, {
      fixture,
      repositoryRoot: ROOT,
      sourceHead,
    });
    return {
      ...materialized,
      fileCount: materialized.manifest.fileCount,
      lineCount: materialized.manifest.lineCount,
    };
  }
  const initialTree = materializeIncidentBoardFixture(workspace, fixture);
  return {
    initialTree,
    sourceTreeRoot: null,
    fileCount: Object.keys(fixture.files).length,
    lineCount: Object.values(fixture.files).reduce(
      (count, content) => count + content.split('\n').length,
      0,
    ),
  };
}

function qualifySeededFixture(fixture, sourceHead) {
  if (fixture.kind === 'real-module-snapshot')
    return qualifySeededRealModuleSnapshot({
      fixture,
      repositoryRoot: ROOT,
      sourceHead,
    });
  return qualifySeededIncidentBoardFixture(fixture);
}

function verifyFixture(workspace, fixture, expectedInitialTree) {
  if (fixture.kind === 'real-module-snapshot')
    return verifyRealModuleSnapshotWorkspace(workspace, {
      fixture,
      expectedInitialTree,
    });
  return verifyIncidentBoardWorkspace(workspace, {
    fixture,
    expectedInitialTree,
  });
}

function visibleCommand(fixture) {
  return (
    fixture.verification?.visibleCommand?.join(' ') ||
    'python -m unittest discover -s tests -v'
  );
}

function investigationPrompt(fixture) {
  const scope =
    fixture.kind === 'real-module-snapshot'
      ? 'inspect the Agent Patrol failure-fingerprint normalization boundary'
      : 'inspect the lease, command, and replay boundaries';
  return [
    'Investigate the repository defect without modifying any file.',
    `Run \`${visibleCommand(fixture)}\`, ${scope}, and identify the exact bounded repair paths.`,
    `The admitted investigation Warrant limits the candidate repair to exactly these repository-relative paths: ${fixture.warrants.agentB.writablePaths.join(', ')}.`,
    'Confirm the seeded failures can be repaired within that Warrant; do not propose tests or any other path.',
    'Return only one JSON object, with no prose or Markdown.',
    `The object must contain schema "kungfu.agent-repository-work.investigation-claim/v1", investigationComplete true, failingTests containing exactly ${JSON.stringify(fixture.investigation.expectedFailures)}, repairPaths containing exactly ${JSON.stringify(fixture.warrants.agentB.writablePaths)} without leading slashes, line numbers, or fragments, remainingObligation "${fixture.investigation.remainingObligation}", and nextAction "${fixture.investigation.nextAction}".`,
  ].join(' ');
}

export { validateExperimentReport };

export function runExperiment(options = {}) {
  const normalized = {
    output:
      options.output ||
      fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-agent-repository-work.')),
    image: options.image || DEFAULT_IMAGE,
    model: options.model || DEFAULT_MODEL,
    baseUrl: options.baseUrl || DEFAULT_BASE_URL,
    opencode: options.opencode || '',
    sourceHead: options.sourceHead || '',
    timeoutSeconds: options.timeoutSeconds || 900,
    fixture: options.fixture || DEFAULT_REPOSITORY_WORK_FIXTURE_ID,
  };
  const fixture = getRepositoryWorkFixture(normalized.fixture);
  const output = path.resolve(normalized.output);
  if (fs.existsSync(output) && fs.readdirSync(output).length > 0)
    throw new Error('output directory must be new or empty');
  fs.mkdirSync(output, { recursive: true });
  const reportPath = path.join(output, 'agent-repository-work-report.json');
  const sourceHead = normalized.sourceHead || currentHead();
  const report = buildBaseReport(normalized, sourceHead, fixture);
  const started = process.hrtime.bigint();
  let workspace = null;
  let initialMetrics = null;
  try {
    if (!fs.existsSync(CONTRACT_PATH))
      throw new Error('agent repository work contract is missing');
    const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
    workspace = path.join(output, 'workspace');
    const home = path.join(output, 'kf-home');
    const configHome = path.join(output, 'kf-config');
    const materialized = materializeFixture(workspace, fixture, sourceHead);
    const initialTree = materialized.initialTree;
    initialMetrics = metricRows(workspace);
    report.fixture.fileCount = materialized.fileCount;
    report.fixture.lineCount = materialized.lineCount;
    report.fixture.sourceTreeRoot = materialized.sourceTreeRoot;
    const initialTreeRoot = jsonRoot(initialTree);
    const seeded = qualifySeededFixture(fixture, sourceHead);
    if (!seeded.passed)
      throw new Error('seeded fixture did not expose the expected failures');
    const planProfile = runtimeProfile({
      id: 'opencode.repository-work.investigate',
      mode: 'read-only',
      model: normalized.model,
      image: normalized.image,
      baseUrl: normalized.baseUrl,
      opencode: normalized.opencode,
      dockerHost: process.env.DOCKER_HOST || '',
      // OpenCode's built-in plan agent disables shell execution. Use the
      // tool-capable agent while the Docker mount and permission policy keep
      // this runtime strictly read-only.
      agent: 'build',
    });
    const buildProfile = runtimeProfile({
      id: 'opencode.repository-work.repair',
      mode: 'bounded-write',
      model: normalized.model,
      image: normalized.image,
      baseUrl: normalized.baseUrl,
      opencode: normalized.opencode,
      dockerHost: process.env.DOCKER_HOST || '',
      agent: 'build',
    });
    const context = {
      home,
      configHome,
      cwd: workspace,
      timeout: (normalized.timeoutSeconds + 60) * 1000,
    };
    configureProfile(planProfile, context);
    configureProfile(buildProfile, context);
    for (const profile of [planProfile, buildProfile]) {
      const verification = JSON.parse(
        pythonKungfu(
          ['agent', 'runtime', 'verify', profile.id, '--json'],
          context,
        ),
      );
      if (!verification.ok)
        throw new Error(`Agent Runtime Profile failed: ${profile.id}`);
    }
    const contractRoot = fileRoot(CONTRACT_PATH);
    const workEntity = {
      schema: 'kungfu.agent-repository-work.entity/v1',
      contractRoot,
      fixtureId: fixture.id,
      initialTreeRoot,
      sourceTreeRoot: materialized.sourceTreeRoot,
      warrantRoot: jsonRoot(fixture.warrants),
    };
    const currentCutRoot = jsonRoot({
      schema: 'kungfu.agent-repository-work.cut/v1',
      sourceHead,
      ...workEntity,
    });
    const workRef = {
      schema: 'kungfu.work-ref/v1',
      workspaceId: 'agent-repository-work-disposable',
      profileId: fixture.id,
      profileRoot: jsonRoot(contract),
      entityType: 'assignment',
      entityId: fixture.id,
      initiativeId: 'agent-repository-work-qualification',
      entityRoot: jsonRoot(workEntity),
      purpose: 'bounded-local-agent-repository-load-experiment',
      systemTimeCut: currentCutRoot,
    };
    const workRefPath = path.join(output, 'inputs/work-ref.json');
    writeJson(workRefPath, workRef);
    const promptA = investigationPrompt(fixture);
    const sessionA = JSON.parse(
      pythonKungfu(
        [
          'run',
          'agent',
          '--agent',
          planProfile.id,
          '--prompt',
          promptA,
          '--workspace',
          workspace,
          '--work-ref',
          workRefPath,
          '--timeout',
          String(normalized.timeoutSeconds),
          '--json',
        ],
        context,
      ),
    );
    const afterATree = treeRows(workspace);
    const agentAZeroModification =
      JSON.stringify(afterATree) === JSON.stringify(initialTree);
    if (!agentAZeroModification)
      throw new Error('Agent A modified the investigation-only workspace');
    const investigation = parseInvestigationClaim(
      sessionA.providerObservation?.text,
      fixture,
    );
    const claimBody = {
      schema: 'kungfu.agent-repository-work.claim/v1',
      currentCutRoot,
      providerRunRoot: sessionA.reportRoot,
      investigationRoot: jsonRoot(investigation),
      completed: 'bounded-investigation',
      remainingObligation: investigation.remainingObligation,
      nextAction: investigation.nextAction,
      selfReported: true,
      completionAuthority: false,
    };
    const claim = { ...claimBody, root: jsonRoot(claimBody) };
    const assessmentBody = {
      schema: 'kungfu.agent-repository-work.assessment/v1',
      assessor: 'deterministic-seeded-fixture-verifier',
      independent: true,
      claimRoot: claim.root,
      currentCutRoot,
      initialTreeRoot,
      seededDefectRoot: jsonRoot(seeded),
      outcome: 'partial',
      remainingObligation: `Complete ${fixture.task.title.toLowerCase()} using only ${fixture.warrants.agentB.writablePaths.join(', ')}; run ${visibleCommand(fixture)} and leave the workspace for an external hidden verifier.`,
      nextAction: 'implement bounded repair and run visible tests',
    };
    const assessment = {
      ...assessmentBody,
      root: jsonRoot(assessmentBody),
    };
    const continuation = {
      schema: 'kungfu.agent-continuation-envelope/v1',
      workRef,
      currentCutRoot,
      priorClaimRoot: claim.root,
      assessmentRoot: assessment.root,
      remainingObligation: assessment.remainingObligation,
      nextAction: assessment.nextAction,
    };
    const continuationPath = path.join(output, 'inputs/continuation.json');
    writeJson(continuationPath, continuation);
    const promptB = [
      'Continue solely from the admitted Kungfu continuation evidence.',
      'Do not request a transcript or a human restatement.',
      'Before editing, report the recovered roots and obligation as required by the Kungfu bootstrap.',
      'Complete the admitted bounded work, run the visible verification, and return a concise completion claim.',
    ].join(' ');
    const sessionB = JSON.parse(
      pythonKungfu(
        [
          'run',
          'agent',
          '--agent',
          buildProfile.id,
          '--prompt',
          promptB,
          '--workspace',
          workspace,
          '--continuation',
          continuationPath,
          '--timeout',
          String(normalized.timeoutSeconds),
          '--json',
        ],
        context,
      ),
    );
    const providerSessionA = providerSessionId(sessionA, 'Agent A');
    const providerSessionB = providerSessionId(sessionB, 'Agent B');
    if (providerSessionA === providerSessionB)
      throw new Error('Agent A and Agent B reused one provider session');
    const episodeVerification = {};
    for (const [label, session] of [
      ['a', sessionA],
      ['b', sessionB],
    ])
      episodeVerification[label] = JSON.parse(
        pythonKungfu(
          [
            'storage',
            'fsck',
            '--scope',
            'episode',
            '--episode-id',
            String(session.episode.episodeId),
            '--verify-frames',
            '--json',
          ],
          context,
        ),
      );
    if (!episodeVerification.a.ok || !episodeVerification.b.ok)
      throw new Error('Kungfu Episode frame verification failed');
    report.sessions = {
      distinct: 2,
      a: {
        runId: sessionA.runId,
        providerSessionId: providerSessionA,
        profileId: sessionA.runtimeProfile.id,
        reportRoot: sessionA.reportRoot,
        processExitSettlesWork: sessionA.work.processExitSettlesWork,
        selfReportSettlesWork: sessionA.work.selfReportSettlesWork,
      },
      b: {
        runId: sessionB.runId,
        providerSessionId: providerSessionB,
        profileId: sessionB.runtimeProfile.id,
        reportRoot: sessionB.reportRoot,
        processExitSettlesWork: sessionB.work.processExitSettlesWork,
        selfReportSettlesWork: sessionB.work.selfReportSettlesWork,
      },
    };
    report.claim = claim;
    report.assessment = assessment;
    report.continuity = {
      ...report.continuity,
      root: jsonRoot(continuation),
      currentCutRoot,
      priorClaimRoot: claim.root,
      assessmentRoot: assessment.root,
      agentBReportedPriorTranscriptBytes:
        sessionB.privacy.priorTranscriptBytesGivenToAgent,
    };
    report.warrant = {
      ...report.warrant,
      agentAZeroModification,
    };
    report.episodeVerification = episodeVerification;
    const oracle = verifyFixture(workspace, fixture, initialTree);
    report.oracle = oracle;
    report.warrant = {
      ...report.warrant,
      changedPaths: oracle.changedPaths,
      scopeViolations: oracle.scopeViolations,
    };
    report.changeSignals = changeSignals(
      initialMetrics,
      metricRows(workspace),
      fixture.warrants.agentB.writablePaths,
    );
    report.dimensions = {
      execution: 'two-fresh-opencode-processes-completed',
      correctness: oracle.passed
        ? 'visible-and-hidden-oracles-passed'
        : 'external-oracle-rejected-repair',
      scope:
        oracle.scopeViolations.length === 0
          ? 'all-changes-within-bounded-warrant'
          : 'warrant-scope-violation',
      continuity: 'native-workref-and-transcript-free-continuation-admitted',
      evidence: 'content-rooted-episodes-claim-assessment-and-oracle',
      efficiency: {
        elapsedMilliseconds: Number(
          (process.hrtime.bigint() - started) / 1_000_000n,
        ),
        sessionAUsage: sessionA.providerObservation?.usage || null,
        sessionBUsage: sessionB.providerObservation?.usage || null,
      },
      residuals: [
        `single deterministic fixture ${fixture.id}`,
        'single pinned local model and one trusted runner',
        'no multi-day durability or concurrent repository-edit claim',
      ],
    };
    if (!oracle.passed)
      throw new Error(`external oracle rejected repair: ${oracle.reportRoot}`);
    report.passed = true;
    validateExperimentReport(report);
  } catch (error) {
    report.failure = {
      category: classifyFailure(error),
      message: String(error?.message || error).slice(0, 500),
      outputRoot: error?.outputRoot || null,
    };
    report.dimensions.efficiency = {
      elapsedMilliseconds: Number(
        (process.hrtime.bigint() - started) / 1_000_000n,
      ),
    };
    if (workspace && initialMetrics && fs.existsSync(workspace))
      report.changeSignals = changeSignals(
        initialMetrics,
        metricRows(workspace),
        fixture.warrants.agentB.writablePaths,
      );
  }
  writeJson(reportPath, report);
  return { output, reportPath, report };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = runExperiment(parseArgs(process.argv.slice(2)));
    process.stdout.write(
      `${JSON.stringify({
        passed: result.report.passed,
        output: result.output,
        report: result.reportPath,
        failure: result.report.failure,
      })}\n`,
    );
    if (!result.report.passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}
