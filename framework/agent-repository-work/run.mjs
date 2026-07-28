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
  materializeIncidentBoardFixture,
  qualifySeededIncidentBoardFixture,
  verifyIncidentBoardWorkspace,
} from '../../tests/qualification/agent-repository-work/incident-board-replay-v1-oracle.mjs';
import { INCIDENT_BOARD_FIXTURE } from '../../tests/qualification/agent-repository-work/incident-board-replay-v1.mjs';

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
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
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

function parseArgs(argv) {
  const result = {
    output: '',
    image: DEFAULT_IMAGE,
    model: DEFAULT_MODEL,
    baseUrl: DEFAULT_BASE_URL,
    opencode: '',
    sourceHead: '',
    timeoutSeconds: 900,
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
    else if (arg === '--timeout-seconds')
      result.timeoutSeconds = Number.parseInt(argv[++index] || '', 10);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(result.timeoutSeconds) || result.timeoutSeconds < 60)
    throw new Error('--timeout-seconds must be an integer of at least 60');
  if (!result.opencode && !result.image.includes('@sha256:'))
    throw new Error('--image must be pinned by digest');
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

export function parseInvestigationClaim(text) {
  if (typeof text !== 'string' || !text.trim())
    throw new Error('Agent A returned no investigation claim');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const source =
    fenced?.[1] || text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const value = JSON.parse(source);
  const expectedFailures = [
    'test_expired_lease_cannot_complete',
    'test_legacy_duplicate_log_has_stable_restart_summary',
  ];
  const expectedPaths = [
    ...INCIDENT_BOARD_FIXTURE.warrants.agentB.writablePaths,
  ].sort();
  if (
    value?.schema !== 'kungfu.agent-repository-work.investigation-claim/v1' ||
    value.investigationComplete !== true ||
    JSON.stringify([...(value.failingTests || [])].sort()) !==
      JSON.stringify(expectedFailures) ||
    JSON.stringify([...(value.repairPaths || [])].sort()) !==
      JSON.stringify(expectedPaths) ||
    value.remainingObligation !== 'implement-and-verify-bounded-repair' ||
    value.nextAction !== 'repair-seeded-completion-idempotency'
  )
    throw new Error(
      'Agent A investigation claim failed deterministic assessment',
    );
  return value;
}

function classifyFailure(error) {
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

export function validateExperimentReport(report) {
  if (report?.schema !== REPORT_SCHEMA)
    throw new Error('repository-work report schema is unsupported');
  if (report.evidenceClass !== 'bounded-experiment')
    throw new Error('repository-work evidence class must stay bounded');
  if (report.nonClaims?.auditableDemo !== true)
    throw new Error('Auditable Demo non-integration boundary is required');
  if (report.nonClaims?.qualificationLab !== true)
    throw new Error('Qualification Lab non-integration boundary is required');
  if (
    report.nonClaims?.releaseGate !== true ||
    report.nonClaims?.publicClaim !== true
  )
    throw new Error('release and public-claim boundaries are required');
  if (report.passed) {
    if (report.sessions?.distinct !== 2)
      throw new Error('exactly two fresh provider sessions are required');
    if (report.continuity?.priorTranscriptBytes !== 0)
      throw new Error('Agent B must receive zero prior transcript bytes');
    if (report.continuity?.humanRestatementCount !== 0)
      throw new Error('Agent B must receive no human task restatement');
    if (report.warrant?.agentAZeroModification !== true)
      throw new Error('Agent A modified the production fixture');
    if (report.oracle?.passed !== true || report.oracle?.authoritative !== true)
      throw new Error('external deterministic oracle is authoritative');
    if (
      report.sessions.a.providerSessionId ===
      report.sessions.b.providerSessionId
    )
      throw new Error('provider sessions are not fresh and distinct');
    for (const value of [
      report.claim?.root,
      report.assessment?.root,
      report.continuity?.root,
      report.oracle?.reportRoot,
    ])
      if (!ROOT_PATTERN.test(value || ''))
        throw new Error('repository-work evidence root is invalid');
  }
  return true;
}

function buildBaseReport(options, sourceHead) {
  return {
    schema: REPORT_SCHEMA,
    evidenceClass: 'bounded-experiment',
    passed: false,
    sourceHead,
    fixture: {
      id: INCIDENT_BOARD_FIXTURE.id,
      fileCount: Object.keys(INCIDENT_BOARD_FIXTURE.files).length,
      lineCount: Object.values(INCIDENT_BOARD_FIXTURE.files).reduce(
        (count, content) => count + content.split('\n').length,
        0,
      ),
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
      writablePaths: [...INCIDENT_BOARD_FIXTURE.warrants.agentB.writablePaths],
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
      qualificationLab: true,
      releaseGate: true,
      publicClaim: true,
      modelRanking: true,
    },
    failure: null,
  };
}

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
  };
  const output = path.resolve(normalized.output);
  if (fs.existsSync(output) && fs.readdirSync(output).length > 0)
    throw new Error('output directory must be new or empty');
  fs.mkdirSync(output, { recursive: true });
  const reportPath = path.join(output, 'agent-repository-work-report.json');
  const sourceHead = normalized.sourceHead || currentHead();
  const report = buildBaseReport(normalized, sourceHead);
  const started = process.hrtime.bigint();
  try {
    if (!fs.existsSync(CONTRACT_PATH))
      throw new Error('agent repository work contract is missing');
    const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
    const workspace = path.join(output, 'workspace');
    const home = path.join(output, 'kf-home');
    const configHome = path.join(output, 'kf-config');
    const initialTree = materializeIncidentBoardFixture(workspace);
    const initialTreeRoot = jsonRoot(initialTree);
    const seeded = qualifySeededIncidentBoardFixture();
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
      fixtureId: INCIDENT_BOARD_FIXTURE.id,
      initialTreeRoot,
      warrantRoot: jsonRoot(INCIDENT_BOARD_FIXTURE.warrants),
    };
    const currentCutRoot = jsonRoot({
      schema: 'kungfu.agent-repository-work.cut/v1',
      sourceHead,
      ...workEntity,
    });
    const workRef = {
      schema: 'kungfu.work-ref/v1',
      workspaceId: 'agent-repository-work-disposable',
      profileId: 'incident-board-replay-v1',
      profileRoot: jsonRoot(contract),
      entityType: 'work',
      entityId: 'incident-board-replay-v1',
      entityRoot: jsonRoot(workEntity),
      purpose: 'bounded-local-agent-repository-load-experiment',
      systemTimeCut: currentCutRoot,
    };
    const workRefPath = path.join(output, 'inputs/work-ref.json');
    writeJson(workRefPath, workRef);
    const promptA = [
      'Investigate the repository defect without modifying any file.',
      'Run `python -m unittest discover -s tests -v`, inspect the lease, command, and replay boundaries, and identify the exact bounded repair paths.',
      `The admitted investigation Warrant limits the candidate repair to exactly these repository-relative paths: ${INCIDENT_BOARD_FIXTURE.warrants.agentB.writablePaths.join(', ')}.`,
      'Confirm the seeded failures can be repaired within that Warrant; do not propose tests, service.py, or any other path.',
      'Return only one JSON object, with no prose or Markdown.',
      'The object must contain schema "kungfu.agent-repository-work.investigation-claim/v1", investigationComplete true, failingTests containing exactly the two failing unittest method names, repairPaths containing exactly three repository-relative Python paths without leading slashes, line numbers, or fragments, remainingObligation "implement-and-verify-bounded-repair", and nextAction "repair-seeded-completion-idempotency".',
    ].join(' ');
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
      remainingObligation:
        'Repair expired-lease authorization, retry idempotency, and restart replay using only incident_board/commands.py, incident_board/lease.py, and incident_board/replay.py; run python -m unittest discover -s tests -v and leave the workspace for an external hidden verifier.',
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
    const oracle = verifyIncidentBoardWorkspace(workspace, {
      expectedInitialTree: initialTree,
    });
    report.oracle = oracle;
    report.warrant = {
      ...report.warrant,
      changedPaths: oracle.changedPaths,
      scopeViolations: oracle.scopeViolations,
    };
    report.dimensions = {
      execution: 'two-fresh-opencode-processes-completed',
      correctness: oracle.passed
        ? 'visible-and-hidden-oracles-passed'
        : 'external-oracle-rejected-repair',
      scope:
        oracle.scopeViolations.length === 0
          ? 'all-changes-within-three-file-warrant'
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
        'single deterministic Python fixture',
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
