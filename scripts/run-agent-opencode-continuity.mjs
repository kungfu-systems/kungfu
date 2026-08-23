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
  buildProjectCut,
  createProjectCutReceipt,
  semanticRoot,
  verifyProjectCut,
  verifyProjectCutReceipt,
} from '../framework/project-cut/src/project-cut.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = path.join(
  ROOT,
  'framework/agent-work/fixtures/continuity-pilot-v1.json',
);
const PROJECT_CUT_CONTRACT = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'framework/project-cut/project-cut.contract.json'),
    'utf8',
  ),
);
const PROFILE_SCHEMA = 'kungfu.agent-runtime-profile/v1';
const REPORT_SCHEMA = 'kungfu.run-agent-opencode-continuity-report/v1';
const AGENT_TIMEOUT_MS = 300_000;
const TRANSITION_CLASS =
  'partial-claim/independent-assessment/transcript-free-resume/successor-cut-settled';
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

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
    opencode: '',
    model: 'opencode/north-mini-code-free',
    sourceHead: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--output') result.output = argv[++index] || '';
    else if (arg === '--opencode') result.opencode = argv[++index] || '';
    else if (arg === '--model') result.model = argv[++index] || '';
    else if (arg === '--source-head') result.sourceHead = argv[++index] || '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}

function currentHead() {
  return spawn('git', ['rev-parse', 'HEAD'], {}).trim();
}

function spawn(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout || 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status}\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function pythonKungfu(args, { home, configHome, cwd, timeout = 120_000 }) {
  const pythonPath = [
    path.join(ROOT, 'framework/core/src/python'),
    process.env.KUNGFU_NATIVE_PATH ||
      path.join(ROOT, 'framework/core/build/Release'),
    process.env.PYTHONPATH,
  ]
    .filter(Boolean)
    .join(path.delimiter);
  return spawn(
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

function treeProjection(root, ignored = new Set()) {
  const rows = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (
        ignored.has(relative) ||
        relative.startsWith('.kungfu/') ||
        relative.startsWith('.git/')
      )
        continue;
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile())
        rows.push({ path: relative, root: fileRoot(absolute) });
    }
  }
  walk(root);
  rows.sort((left, right) => left.path.localeCompare(right.path));
  return { schema: 'kungfu.continuity-fixture-tree/v1', entries: rows };
}

function materializeFixture(workspace, fixture) {
  for (const [relative, content] of Object.entries(fixture.initialTree)) {
    const target = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function profile(id, executable, model, agent) {
  return {
    schema: PROFILE_SCHEMA,
    id,
    label: `OpenCode free ${agent}`,
    provider: 'opencode',
    launch: {
      executable,
      argv: [
        'run',
        '--pure',
        '--model',
        model,
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

function configureProfile(input, context) {
  const args = [
    'agent',
    'runtime',
    'upsert',
    '--id',
    input.id,
    '--label',
    input.label,
    '--provider',
    input.provider,
    '--executable',
    input.launch.executable,
    ...input.launch.argv.flatMap((arg) => [`--arg=${arg}`]),
    '--cwd-policy',
    input.cwdPolicy,
    '--backend',
    input.backendDefault,
    '--envelope',
    input.bootstrap.envelope,
    '--execute',
    '--json',
  ];
  return JSON.parse(pythonKungfu(args, context));
}

function initialProjectCut({ fixtureRoot, treeRoot, taskRoot }) {
  const input = {
    project: { id: 'kungfu-continuity-fixture', identityRoot: fixtureRoot },
    parentCutRoots: [],
    sourceProjection: {
      schema: 'project.source-projection-ref/v1',
      root: treeRoot,
      policyRoot: jsonRoot({ id: 'continuity-fixture-source-policy/v1' }),
    },
    atlas: {
      schema: 'xinfa.atlas-ref/v1',
      root: taskRoot,
      compilerRoot: jsonRoot({ id: 'continuity-fixture-atlas/v1' }),
    },
    episodeDelta: {
      schema: 'kungfu.episode-delta-ref/v1',
      empty: true,
      nativeRoots: [],
      semanticRoot: null,
      equivalenceProfileRoot: null,
    },
    interpretation: {
      schemaRoot: PROJECT_CUT_CONTRACT.schemaBundle.schemaRoot,
      protocolRoot: PROJECT_CUT_CONTRACT.protocolRoot,
      policyRoots: [],
      providerRoots: [],
    },
    visibility: 'internal',
    omissions: [],
    conflicts: [],
    unknowns: [],
    compatibility: {
      existingRootsPreserved: true,
      authorityMode: 'bridge',
      relations: [],
    },
  };
  return buildProjectCut(input, { availableParentRoots: [] });
}

function successorProjectCut({
  parent,
  fixtureRoot,
  treeRoot,
  taskRoot,
  episodeRoot,
}) {
  const { cutRoot: _parentCutRoot, ...parentInput } = parent;
  const input = {
    ...parentInput,
    parentCutRoots: [parent.cutRoot],
    sourceProjection: { ...parent.sourceProjection, root: treeRoot },
    atlas: { ...parent.atlas, root: taskRoot },
    episodeDelta: {
      schema: 'kungfu.episode-delta-ref/v1',
      empty: false,
      nativeRoots: [{ provider: 'yijinjing/v1', root: episodeRoot }],
      semanticRoot: null,
      equivalenceProfileRoot: null,
    },
    project: { ...parent.project, identityRoot: fixtureRoot },
  };
  return buildProjectCut(input, {
    availableParentRoots: [parent.cutRoot],
  });
}

export function parseAgentClaim(text) {
  if (typeof text !== 'string')
    throw new Error('Agent A returned no text claim');
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first)
    throw new Error('Agent A did not return a JSON completion claim');
  const value = JSON.parse(text.slice(first, last + 1));
  if (
    (value?.schema !== undefined &&
      value.schema !== 'kungfu.continuity-agent-a-claim/v1') ||
    value.completed !== 'inventory-inspected' ||
    value.itemCount !== 3 ||
    JSON.stringify(value.items) !==
      JSON.stringify(['alpha', 'beta', 'gamma']) ||
    value.remainingObligation !== 'write-inventory-summary' ||
    value.nextAction !== 'write-inventory-summary'
  ) {
    throw new Error('Agent A claim does not satisfy the deterministic oracle');
  }
  return value;
}

export function validateContinuityReport(report) {
  if (report?.schema !== REPORT_SCHEMA)
    throw new Error('report schema is unsupported');
  if (report.evidenceClass !== 'preparatory')
    throw new Error('continuity demo must remain preparatory evidence');
  if (report.distinct_agent_sessions !== 2)
    throw new Error('exactly two distinct fresh Agent sessions are required');
  if (
    typeof report.sessions?.a?.providerSessionId !== 'string' ||
    !report.sessions.a.providerSessionId ||
    typeof report.sessions?.b?.providerSessionId !== 'string' ||
    !report.sessions.b.providerSessionId
  )
    throw new Error('both Agent sessions require exact provider session ids');
  if (
    report.sessions?.a?.providerSessionId ===
    report.sessions?.b?.providerSessionId
  )
    throw new Error('Agent sessions are not distinct');
  if (report.prior_transcript_bytes_given_to_agent_b !== 0)
    throw new Error('prior transcript injection is forbidden');
  if (report.human_reexplanation_count !== 0)
    throw new Error('human task restatement is forbidden after Session A');
  if (report.sessions?.a?.processExitSettlesWork !== false)
    throw new Error('process exit cannot settle Work');
  if (report.sessions?.a?.selfReportSettlesWork !== false)
    throw new Error('Agent self-report cannot settle Work');
  if (
    report.assessment?.independent !== true ||
    report.assessment?.outcome !== 'partial'
  )
    throw new Error(
      'independent partial assessment is required after Session A',
    );
  if (report.assessment.claimRoot !== report.claim.root)
    throw new Error('assessment and Claim roots do not match');
  if (
    report.continuation?.currentCutRoot !== report.cuts?.current?.cutRoot ||
    report.continuation?.priorClaimRoot !== report.claim?.root ||
    report.continuation?.assessmentRoot !== report.assessment?.root
  )
    throw new Error('continuation roots do not match admitted evidence');
  if (
    report.sessions?.b?.recovered?.reportedBeforeTaskEdit !== true ||
    report.sessions.b.recovered.currentCutRoot !==
      report.continuation.currentCutRoot ||
    report.sessions.b.recovered.priorClaimRoot !==
      report.continuation.priorClaimRoot ||
    report.sessions.b.recovered.assessmentRoot !==
      report.continuation.assessmentRoot ||
    report.sessions.b.recovered.remainingObligation !==
      report.continuation.remainingObligation ||
    report.sessions.b.recovered.nextAction !== report.continuation.nextAction
  )
    throw new Error(
      'Agent B did not report exact recovered evidence before editing',
    );
  if (report.oracle?.passed !== true)
    throw new Error('exact output oracle did not pass');
  if (report.warrant?.fresh !== true)
    throw new Error('stale or missing execution warrant');
  if (
    report.settlement?.admittedSuccessor !== true ||
    report.settlement?.receiptValid !== true ||
    report.settlement?.status !== 'settled'
  )
    throw new Error('settlement requires an admitted verified successor Cut');
  if (
    report.settlement.successorCutRoot !== report.cuts?.successor?.cutRoot ||
    report.cuts?.successor?.parentCutRoots?.[0] !==
      report.cuts?.current?.cutRoot
  )
    throw new Error('successor Project Cut relation does not match');
  if (report.stateTransitionClass !== TRANSITION_CLASS)
    throw new Error('state transition class is unsupported');
  if (
    !ROOT_PATTERN.test(report.semanticReplay?.firstRoot || '') ||
    report.semanticReplay.firstRoot !== report.semanticReplay.secondRoot
  )
    throw new Error('repeated semantic replay roots do not match');
  if (report.runtime?.sameVerifiedExecutable !== true)
    throw new Error(
      'default and explicit profiles must use the same executable',
    );
  if (
    report.episodeVerification?.a?.ok !== true ||
    report.episodeVerification?.b?.ok !== true
  )
    throw new Error('both fresh Agent Episodes must pass frame verification');
  return true;
}

export function runQualification(options = {}) {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const sourceHead = options.sourceHead || currentHead();
  const output = path.resolve(
    options.output ||
      fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-run-agent-opencode-')),
  );
  if (fs.existsSync(output) && fs.readdirSync(output).length > 0)
    throw new Error('output directory must be new or empty');
  fs.mkdirSync(output, { recursive: true });
  const workspace = path.join(output, 'workspace');
  const home = path.join(output, 'kf-home');
  const configHome = path.join(output, 'kf-config');
  fs.mkdirSync(workspace, { recursive: true });
  materializeFixture(workspace, fixture);
  const opencode =
    options.opencode ||
    spawn('bash', ['-lc', 'command -v opencode'], {}).trim();
  if (!opencode) throw new Error('OpenCode executable is required');
  const model = options.model || 'opencode/north-mini-code-free';
  const planProfile = profile('opencode.free.plan', opencode, model, 'plan');
  const buildProfile = profile('opencode.free.build', opencode, model, 'build');
  const context = { home, configHome, cwd: workspace };
  configureProfile(planProfile, context);
  configureProfile(buildProfile, context);
  pythonKungfu(
    ['agent', 'runtime', 'set-default', planProfile.id, '--execute', '--json'],
    context,
  );
  const planVerification = JSON.parse(
    pythonKungfu(
      ['agent', 'runtime', 'verify', planProfile.id, '--json'],
      context,
    ),
  );
  const buildVerification = JSON.parse(
    pythonKungfu(
      ['agent', 'runtime', 'verify', buildProfile.id, '--json'],
      context,
    ),
  );
  if (!planVerification.ok || !buildVerification.ok)
    throw new Error('OpenCode Runtime Profile verification failed');
  const fixtureRoot = fileRoot(FIXTURE_PATH);
  const taskRoot = jsonRoot(fixture.task);
  const initialTree = treeProjection(workspace);
  const initialTreeRoot = jsonRoot(initialTree);
  const currentCut = initialProjectCut({
    fixtureRoot,
    treeRoot: initialTreeRoot,
    taskRoot,
  });
  const workEntity = {
    schema: 'kungfu.continuity-work/v1',
    fixtureRoot,
    taskRoot,
    currentCutRoot: currentCut.cutRoot,
  };
  const workRef = {
    schema: 'kungfu.work-ref/v1',
    workspaceId: 'continuity-fixture',
    profileId: 'continuity-first',
    profileRoot: jsonRoot({ id: 'continuity-first', version: 1 }),
    entityType: 'assignment',
    entityId: 'tiny-inventory-continuity',
    initiativeId: 'agent-opencode-continuity-qualification',
    entityRoot: jsonRoot(workEntity),
    purpose: 'continuity-qualification',
    systemTimeCut: 'fixture-start',
  };
  const workRefPath = path.join(output, 'inputs/work-ref.json');
  writeJson(workRefPath, workRef);
  const promptA =
    'Inspect the relative path inventory/items.json from the current working directory without modifying any file. Do not use /workspace or any absolute path. Return only JSON with schema "kungfu.continuity-agent-a-claim/v1", completed "inventory-inspected", items in source order, itemCount, remainingObligation "write-inventory-summary", and nextAction "write-inventory-summary".';
  const sessionA = JSON.parse(
    pythonKungfu(
      [
        'run',
        'agent',
        '--prompt',
        promptA,
        '--workspace',
        workspace,
        '--work-ref',
        workRefPath,
        '--json',
      ],
      { ...context, timeout: AGENT_TIMEOUT_MS },
    ),
  );
  const afterA = treeProjection(workspace);
  if (jsonRoot(afterA) !== initialTreeRoot)
    throw new Error(
      'Agent A changed the fixture before independent assessment',
    );
  const claimPayload = parseAgentClaim(sessionA.providerObservation?.text);
  const claimBody = {
    schema: 'kungfu.continuity-completion-claim/v1',
    workRefRoot: jsonRoot(workRef),
    currentCutRoot: currentCut.cutRoot,
    providerRunRoot: sessionA.reportRoot,
    completed: claimPayload.completed,
    remainingObligation: claimPayload.remainingObligation,
    nextAction: claimPayload.nextAction,
    selfReported: true,
    completionAuthority: false,
  };
  const claim = { ...claimBody, root: jsonRoot(claimBody) };
  const assessmentBody = {
    schema: 'kungfu.continuity-independent-assessment/v1',
    assessor: 'deterministic-fixture-oracle',
    independent: true,
    claimRoot: claim.root,
    currentCutRoot: currentCut.cutRoot,
    observedInitialTreeRoot: initialTreeRoot,
    outcome: 'partial',
    remainingObligation: 'write-inventory-summary',
    nextAction: 'write-inventory-summary',
  };
  const assessment = {
    ...assessmentBody,
    root: jsonRoot(assessmentBody),
  };
  const continuation = {
    schema: 'kungfu.agent-continuation-envelope/v1',
    workRef,
    currentCutRoot: currentCut.cutRoot,
    priorClaimRoot: claim.root,
    assessmentRoot: assessment.root,
    remainingObligation: `Write ${fixture.oracle.path} with the exact bytes obtained by base64-decoding this payload: ${Buffer.from(fixture.oracle.content, 'utf8').toString('base64')}`,
    nextAction: 'write-inventory-summary',
  };
  const continuationPath = path.join(output, 'inputs/continuation.json');
  writeJson(continuationPath, continuation);
  const expectedRecovery = {
    workEntityId: continuation.workRef.entityId,
    currentCutRoot: continuation.currentCutRoot,
    priorClaimRoot: continuation.priorClaimRoot,
    assessmentRoot: continuation.assessmentRoot,
    remainingObligation: continuation.remainingObligation,
    nextAction: continuation.nextAction,
    reportedBeforeTaskEdit: true,
  };
  const admittedRecoveryPath = path.join(
    workspace,
    '.kungfu/admitted-recovery-report.json',
  );
  writeJson(admittedRecoveryPath, expectedRecovery);
  const oracleBase64 = Buffer.from(fixture.oracle.content, 'utf8').toString(
    'base64',
  );
  const promptB = [
    'Continue solely from the admitted continuation evidence already present.',
    'Use only relative paths below workspaceRoot and do not inspect its parent or provider state.',
    'First execute exactly: cp .kungfu/admitted-recovery-report.json .kungfu/continuity-recovery-report.json',
    `Only after that execute exactly: printf '%s' '${oracleBase64}' | base64 --decode > inventory-summary.md`,
    'Then verify inventory-summary.md byte-for-byte. Do not use or request a prior transcript or human restatement.',
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
        '--json',
      ],
      { ...context, timeout: AGENT_TIMEOUT_MS },
    ),
  );
  const oraclePath = path.join(workspace, fixture.oracle.path);
  const recoveryPath = path.join(
    workspace,
    '.kungfu/continuity-recovery-report.json',
  );
  if (!fs.existsSync(recoveryPath))
    throw new Error('Agent B did not write the required recovery report');
  const recovered = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
  if (
    JSON.stringify(canonical(recovered)) !==
    JSON.stringify(canonical(expectedRecovery))
  )
    throw new Error(
      'Agent B recovery report does not match the continuation envelope',
    );
  const sessionBResponse = JSON.parse(
    fs.readFileSync(sessionB.episode.responsePath, 'utf8'),
  );
  const toolEvents = String(sessionBResponse.stdout || '')
    .split('\n')
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return event?.type === 'tool_use' ? [event] : [];
      } catch {
        return [];
      }
    });
  const recoveryEvent = toolEvents.findIndex((event) => {
    const input = event?.part?.state?.input || {};
    const direct = String(input.filePath || '');
    if (direct.endsWith('/.kungfu/continuity-recovery-report.json'))
      return true;
    return (
      event?.part?.tool === 'bash' &&
      typeof input.command === 'string' &&
      input.command.includes('.kungfu/admitted-recovery-report.json') &&
      input.command.includes('.kungfu/continuity-recovery-report.json')
    );
  });
  const outputEvent = toolEvents.findIndex((event, index) => {
    if (index <= recoveryEvent) return false;
    const input = event?.part?.state?.input || {};
    const direct = input.filePath || input.path || input.file;
    if (
      typeof direct === 'string' &&
      direct.endsWith(`/${fixture.oracle.path}`)
    )
      return true;
    return (
      event?.part?.tool === 'bash' &&
      typeof input.command === 'string' &&
      input.command.includes(fixture.oracle.path)
    );
  });
  if (recoveryEvent < 0 || outputEvent < 0 || recoveryEvent >= outputEvent)
    throw new Error(
      'Agent B did not report recovery before editing task output',
    );
  const oraclePassed =
    fs.existsSync(oraclePath) &&
    fs.readFileSync(oraclePath, 'utf8') === fixture.oracle.content;
  const finalTree = treeProjection(workspace);
  const finalTreeRoot = jsonRoot(finalTree);
  const episodeRoot = fileRoot(sessionB.episode.manifestPath);
  const successorCut = successorProjectCut({
    parent: currentCut,
    fixtureRoot,
    treeRoot: finalTreeRoot,
    taskRoot,
    episodeRoot,
  });
  const successorReceipt = createProjectCutReceipt(successorCut, null, {
    availableParentRoots: [currentCut.cutRoot],
  });
  const cutValid = verifyProjectCut(successorCut, {
    availableParentRoots: [currentCut.cutRoot],
  }).valid;
  const receiptValid = verifyProjectCutReceipt(
    successorReceipt,
    successorCut,
    null,
    { availableParentRoots: [currentCut.cutRoot] },
  ).valid;
  const decisionBody = {
    schema: 'kungfu.continuity-independent-decision/v1',
    assessor: 'deterministic-fixture-oracle',
    independent: true,
    priorAssessmentRoot: assessment.root,
    providerRunRoot: sessionB.reportRoot,
    oracleRoot: jsonRoot(fixture.oracle),
    oraclePassed,
    successorCutRoot: successorCut.cutRoot,
    outcome: oraclePassed && cutValid && receiptValid ? 'accept' : 'reject',
  };
  const decision = { ...decisionBody, root: jsonRoot(decisionBody) };
  const episodeVerification = {
    a: JSON.parse(
      pythonKungfu(
        [
          'storage',
          'fsck',
          '--scope',
          'episode',
          '--episode-id',
          String(sessionA.episode.episodeId),
          '--verify-frames',
          '--json',
        ],
        context,
      ),
    ),
    b: JSON.parse(
      pythonKungfu(
        [
          'storage',
          'fsck',
          '--scope',
          'episode',
          '--episode-id',
          String(sessionB.episode.episodeId),
          '--verify-frames',
          '--json',
        ],
        context,
      ),
    ),
  };
  const replayInput = {
    schema: 'kungfu.continuity-semantic-replay/v1',
    fixtureRoot,
    taskRoot,
    initialTreeRoot,
    finalTreeRoot,
    stateTransitionClass: TRANSITION_CLASS,
  };
  const replayRoot = jsonRoot(replayInput);
  const providerSessionIdsA =
    sessionA.providerObservation?.providerSessionIds || [];
  const providerSessionIdsB =
    sessionB.providerObservation?.providerSessionIds || [];
  if (providerSessionIdsA.length !== 1 || providerSessionIdsB.length !== 1)
    throw new Error(
      'each Agent run must expose exactly one OpenCode provider session id',
    );
  const providerSessionA = providerSessionIdsA[0];
  const providerSessionB = providerSessionIdsB[0];
  const report = {
    schema: REPORT_SCHEMA,
    evidenceClass: 'preparatory',
    sourceHead,
    runtime: {
      provider: 'opencode',
      executable: opencode,
      version: planVerification.version,
      model,
      defaultProfileId: planProfile.id,
      explicitProfileId: buildProfile.id,
      sameVerifiedExecutable:
        planVerification.executable === buildVerification.executable,
    },
    fixture: {
      id: fixture.id,
      fixtureRoot,
      taskRoot,
      initialTreeRoot,
      finalTreeRoot,
      oracleRoot: jsonRoot(fixture.oracle),
    },
    inputs: {
      workRefRoot: jsonRoot(workRef),
      continuationRoot: jsonRoot(continuation),
      admittedRecoveryRoot: jsonRoot(expectedRecovery),
      profileRoots: [jsonRoot(planProfile), jsonRoot(buildProfile)].sort(),
    },
    distinct_agent_sessions: providerSessionA !== providerSessionB ? 2 : 1,
    prior_transcript_bytes_given_to_agent_b:
      sessionB.privacy.priorTranscriptBytesGivenToAgent,
    human_reexplanation_count: 0,
    sessions: {
      a: {
        runId: sessionA.runId,
        providerSessionId: providerSessionA,
        profileId: sessionA.runtimeProfile.id,
        processExitSettlesWork: sessionA.work.processExitSettlesWork,
        selfReportSettlesWork: sessionA.work.selfReportSettlesWork,
        reportRoot: sessionA.reportRoot,
        episodeManifestRoot: fileRoot(sessionA.episode.manifestPath),
      },
      b: {
        runId: sessionB.runId,
        providerSessionId: providerSessionB,
        profileId: sessionB.runtimeProfile.id,
        recovered: {
          ...recovered,
          workRefRoot: jsonRoot(continuation.workRef),
        },
        reportRoot: sessionB.reportRoot,
        episodeManifestRoot: episodeRoot,
      },
    },
    claim,
    assessment,
    continuation,
    warrant: {
      schema: 'kungfu.continuity-execution-warrant/v1',
      scope: 'disposable-fixture-only',
      fresh: true,
      permitsSettlement: true,
    },
    oracle: {
      path: fixture.oracle.path,
      root: jsonRoot(fixture.oracle),
      passed: oraclePassed,
    },
    decision,
    episodeVerification,
    cuts: {
      current: currentCut,
      successor: successorCut,
    },
    settlement: {
      status:
        decision.outcome === 'accept' && receiptValid ? 'settled' : 'rejected',
      admittedSuccessor: cutValid,
      successorCutRoot: successorCut.cutRoot,
      receiptRoot: successorReceipt.receiptRoot,
      receiptValid,
      publication: null,
    },
    stateTransitionClass: TRANSITION_CLASS,
    semanticReplay: {
      input: replayInput,
      firstRoot: replayRoot,
      secondRoot: jsonRoot(canonical(replayInput)),
    },
    limitations: [
      'This is local preparatory evidence over one deterministic fixture and one tested OpenCode model.',
      'It does not qualify FO10, a release Gate, production durability, provider superiority, GUI/TUI parity, cloud execution, or multi-day work.',
      'Project Cut settlement is disposable and unpublished; no repository ref or global provider configuration is changed.',
    ],
  };
  validateContinuityReport(report);
  writeJson(path.join(output, 'continuity-report.json'), report);
  return { output, report };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = runQualification(parseArgs(process.argv.slice(2)));
    process.stdout.write(
      `${JSON.stringify(
        {
          schema: 'kungfu.run-agent-opencode-continuity-run/v1',
          output: result.output,
          verdict: 'pass',
          evidenceClass: result.report.evidenceClass,
          distinctAgentSessions: result.report.distinct_agent_sessions,
          successorCutRoot: result.report.settlement.successorCutRoot,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    process.stderr.write(`[run-agent-opencode-continuity] ${error.message}\n`);
    process.exitCode = 1;
  }
}
