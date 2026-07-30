// SPDX-License-Identifier: Apache-2.0

// Internal source/agent entry. Public CLI naming remains intentionally unfrozen.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  beginActionLoop,
  createCorePublicAdapters,
  createExplicitCompatibilityAdapters,
  resumeActionLoop,
} from './action-loop-begin.mjs';
import {
  createSettlementCoreAdapters,
  settleActionLoop,
} from './action-loop-settle.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(DIR, '..', '..');
const CORE = path.join(REPO, 'framework', 'core');
const BINDING = path.join(CORE, 'build', 'python');
const SOURCE = path.join(CORE, 'src', 'python');
const contract = JSON.parse(
  fs.readFileSync(path.join(DIR, 'action-loop.contract.json'), 'utf8'),
);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith('--')) throw new Error(`unexpected argument: ${item}`);
    const key = item.slice(2);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      values[key] = true;
    } else {
      values[key] = value;
      index += 1;
    }
  }
  return values;
}

function required(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`--${key} is required`);
  return value;
}

function exactRoot(value, field) {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value))
    throw new Error(`${field} must be an exact sha256 root`);
  return value;
}

export function resolveProjectCutAuthority(state, { missionId, goalId }) {
  const activeProjectCutPhases = new Set([
    'native-go',
    'episode-sealed',
    'cut-prepared',
    'cut-bound',
    'cut-observed',
    'claimed',
    'reviewed',
    'continuation-decided',
  ]);
  if (!state || !activeProjectCutPhases.has(state.phase))
    throw new Error('Project Cut state is not an active native Go context');
  if (state.goal_id !== goalId || state.native?.go_id !== goalId)
    throw new Error('Project Cut goal coordinate does not match --goal-id');
  if (state.native?.mission_id !== missionId)
    throw new Error(
      'Project Cut Mission coordinate does not match --mission-id',
    );
  const goReceipt = state.native?.go_receipt;
  const atlasVerification = state.context?.receipts?.atlas_verify;
  const pursuitRoot = exactRoot(
    goReceipt?.receipt?.payload_hash,
    'native Go receipt payload root',
  );
  const atlasRoot = exactRoot(
    state.roots?.input_atlas_root,
    'input Atlas root',
  );
  if (
    atlasVerification?.valid !== true ||
    atlasVerification.atlas_root !== atlasRoot ||
    (atlasVerification.diagnostics ?? []).length !== 0
  ) {
    throw new Error('Project Cut Atlas verification is not exact and clean');
  }
  const acceptanceRoot = exactRoot(
    state.roots?.acceptance_root,
    'Go acceptance root',
  );
  const externalRepoPath = state.coordinates?.external_repo_path;
  const sourceBuildBinding = externalRepoPath
    ? path.join(externalRepoPath, 'framework/core/build/python')
    : '';
  const hasSourceBuildBinding =
    sourceBuildBinding !== '' &&
    fs.existsSync(sourceBuildBinding) &&
    fs
      .readdirSync(sourceBuildBinding)
      .some(
        (name) =>
          name.startsWith('pykungfu.') &&
          (name.endsWith('.so') || name.endsWith('.pyd')),
      );
  return {
    schema: 'kungfu.action-loop.project-cut-authority/v0',
    missionId,
    goalId,
    bindingDir: hasSourceBuildBinding
      ? sourceBuildBinding
      : required(state.coordinates ?? {}, 'binding_dir'),
    contextBindingRoot: exactRoot(
      state.roots?.context_binding_root,
      'context binding root',
    ),
    pursuit: {
      id: required(goReceipt ?? {}, 'go_subject'),
      root: pursuitRoot,
    },
    atlas: {
      id: `xinfa:${state.roots.context_binding_root.slice(7, 31)}`,
      root: atlasRoot,
      verification: atlasVerification,
    },
    warrant: {
      id: `project-cut-warrant:${goalId}`,
      root: acceptanceRoot,
    },
  };
}

export function beginNativeRequest(args, authority, nativeAuthority) {
  const goalId = authority.goalId;
  const loopRef = args['loop-ref'] || `action-loop/${goalId}`;
  return {
    schema: 'kungfu.action-loop.begin-request/v0',
    loopId: args['loop-id'] || `loop:${goalId}`,
    loopRoot: authority.warrant.root,
    loopRef,
    idempotencyKey:
      args['idempotency-key'] ||
      `action-loop:${goalId}:${authority.contextBindingRoot.slice(7, 23)}`,
    factRef: { name: loopRef, cutRoot: null, revision: 0 },
    pursuit: {
      explicit: true,
      binding: { ...authority.pursuit, state: 'active' },
    },
    atlas: {
      binding: {
        id: authority.atlas.id,
        root: authority.atlas.root,
        state: 'current',
      },
      verification: {
        valid: true,
        atlasRoot: authority.atlas.root,
        diagnostics: [],
      },
    },
    warrant: {
      explicit: true,
      binding: { ...authority.warrant, state: 'issued' },
    },
    episode: {
      id: args['episode-id'] || `episode:${goalId}`,
      source: args['episode-source'] || `action-loop:${goalId}`,
      title: args['episode-title'],
      actor: args.actor,
    },
    fact: {
      id: args['fact-id'] || `fact:${goalId}`,
      root: authority.warrant.root,
      state: 'declared',
    },
    nativeAuthority,
  };
}

function readProjectCutAuthority(args) {
  const statePath = path.resolve(required(args, 'project-cut-state'));
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return resolveProjectCutAuthority(state, {
    missionId: required(args, 'mission-id'),
    goalId: required(args, 'goal-id'),
  });
}

export function pythonSearchPath(
  bindingDir,
  inherited = process.env.PYTHONPATH,
) {
  return [SOURCE, bindingDir, inherited].filter(Boolean).join(path.delimiter);
}

export function qualificationExecutorProfile(value) {
  const profile = value ?? 'inline';
  if (!['inline', 'thread', 'process'].includes(profile))
    throw new Error('--executor-profile must be inline, thread, or process');
  return profile;
}

function invoke(runtime, bindingDir, operation, payload) {
  const child = spawnSync(
    'uv',
    [
      'run',
      '--project',
      CORE,
      '--frozen',
      'python',
      '-m',
      'kungfu.agent.action_loop',
      '--runtime-dir',
      runtime,
      operation,
    ],
    {
      cwd: REPO,
      encoding: 'utf8',
      env: {
        ...process.env,
        PYTHONPATH: pythonSearchPath(bindingDir),
      },
      input: JSON.stringify(payload),
    },
  );
  if (child.status !== 0)
    throw new Error(child.stderr || `Core adapter exited ${child.status}`);
  return JSON.parse(child.stdout);
}

function ports(runtime, bindingDir) {
  const call = (operation, payload) =>
    invoke(runtime, bindingDir, operation, payload);
  const begin = createCorePublicAdapters(call);
  const settle = createSettlementCoreAdapters(call);
  return {
    ...createExplicitCompatibilityAdapters(),
    ...begin,
    ...settle,
    episodeRecorder: {
      ...begin.episodeRecorder,
      ...settle.episodeRecorder,
    },
  };
}

function beginRequest(args) {
  const loopRef = required(args, 'loop-ref');
  const loopId = required(args, 'loop-id');
  const atlasRoot = required(args, 'atlas-root');
  return {
    schema: 'kungfu.action-loop.begin-request/v0',
    loopId,
    loopRoot: required(args, 'loop-root'),
    loopRef,
    idempotencyKey: required(args, 'idempotency-key'),
    factRef: { name: loopRef, cutRoot: null, revision: 0 },
    pursuit: {
      explicit: true,
      binding: {
        id: required(args, 'pursuit-id'),
        root: required(args, 'pursuit-root'),
        state: 'active',
      },
    },
    atlas: {
      binding: {
        id: required(args, 'atlas-id'),
        root: atlasRoot,
        state: 'current',
      },
      verification: { valid: true, atlasRoot, diagnostics: [] },
    },
    warrant: {
      explicit: true,
      binding: {
        id: required(args, 'warrant-id'),
        root: required(args, 'warrant-root'),
        state: 'issued',
      },
    },
    episode: {
      id: required(args, 'episode-id'),
      source: required(args, 'episode-source'),
      title: args['episode-title'],
      actor: args.actor,
    },
    fact: {
      id: required(args, 'fact-id'),
      root: required(args, 'fact-root'),
      state: 'declared',
    },
  };
}

function completion(args) {
  return {
    missionId: required(args, 'mission-id'),
    goalId: required(args, 'goal-id'),
    statement: required(args, 'statement'),
    acceptanceRoot: required(args, 'acceptance-root'),
    inputAtlasRoot: required(args, 'input-atlas-root'),
    projectCutRoot: required(args, 'project-cut-root'),
    projectCutReceiptRoot: required(args, 'project-cut-receipt-root'),
    gitCommit: required(args, 'git-commit'),
    gitTreeRoot: required(args, 'git-tree-root'),
    reviewer: required(args, 'reviewer'),
    reviewerSource: required(args, 'reviewer-source'),
    checkoutPath: required(args, 'checkout-path'),
    evidenceEpisodeIds: String(args['evidence-episode-ids'] || '')
      .split(',')
      .filter(Boolean),
    proofRoots: String(args['proof-roots'] || '')
      .split(',')
      .filter(Boolean),
    knownGaps: String(args['known-gaps'] || '')
      .split('|')
      .filter(Boolean),
    evidenceAvailability: String(args['evidence-availability'] || '')
      .split('|')
      .filter(Boolean),
    proposedFollowups: String(args['proposed-followups'] || '')
      .split('|')
      .filter(Boolean),
    actor: args.actor || 'agent',
    actorType: 'agent',
    purpose: 'handoff',
    executorProfile: qualificationExecutorProfile(args['executor-profile']),
    decisionAction: args['decision-action'] || 'close',
    changeClass: args['change-class'] || 'mechanical',
  };
}

export function projectQualificationResult(result) {
  const envelope = result.envelope || {};
  const roles = envelope.roles || {};
  return {
    schema: 'kungfu.action-loop.qualification-projection/v0',
    ok: result.ok === true,
    code: result.code,
    message: result.message ?? null,
    current: result.current ?? null,
    status: envelope.state || result.state || 'unknown',
    identities: Object.fromEntries(
      Object.entries(roles).map(([role, binding]) => [role, binding.id]),
    ),
    authority: Object.fromEntries(
      Object.entries(roles).map(([role, binding]) => [role, binding.root]),
    ),
    nativeAuthority: envelope.nativeAuthority ?? null,
    factRef: envelope.factRef || null,
    residualRisk: envelope.residualRisk || [],
    nextStep: result.nextStep ?? null,
    acceptedReceiptRoots: (result.receipts || []).map(
      (receipt) => receipt.receiptRoot,
    ),
    checkpointRoot: result.checkpointRoot || null,
    writeOccurred: result.writeOccurred === true,
  };
}

export function renderQualificationResult(projected) {
  const roleLines = Object.keys(projected.identities)
    .sort()
    .map(
      (role) =>
        `${role}: ${projected.identities[role]} @ ${projected.authority[role]}`,
    );
  return [
    `status: ${projected.status} (${projected.code})`,
    ...(projected.message ? [`message: ${projected.message}`] : []),
    ...roleLines,
    `nativeAuthority: ${projected.nativeAuthority?.id || '-'} @ ${projected.nativeAuthority?.root || '-'}`,
    `factRef: ${projected.factRef?.name || '-'} @ ${projected.factRef?.cutRoot || '-'}#${projected.factRef?.revision ?? '-'}`,
    `residualRisk: ${projected.residualRisk.join(' | ') || 'none'}`,
    `nextStep: ${projected.nextStep || 'none'}`,
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtime = path.resolve(required(args, 'runtime'));
  const nativeCommand = args.command?.endsWith('-native');
  const authority = nativeCommand ? readProjectCutAuthority(args) : null;
  const bindingDir =
    authority?.bindingDir || path.resolve(args['binding-dir'] || BINDING);
  const adapters = ports(runtime, bindingDir);
  let result;
  if (args.command === 'begin-native') {
    const inspected = invoke(runtime, bindingDir, 'authority-inspect', null);
    if (inspected.status !== 'current') {
      result = inspected;
    } else {
      result = await beginActionLoop(
        contract,
        beginNativeRequest(args, authority, inspected.binding),
        adapters,
      );
    }
  } else if (args.command === 'begin') {
    result = await beginActionLoop(contract, beginRequest(args), adapters);
  } else if (
    ['resume', 'surface', 'resume-native', 'surface-native'].includes(
      args.command,
    )
  ) {
    result = await resumeActionLoop(
      contract,
      args['loop-ref'] || `action-loop/${authority?.goalId}`,
      adapters,
    );
  } else if (args.command === 'settle' || args.command === 'settle-native') {
    const pauseBeforeAtlas = args['pause-before-atlas'] === true;
    if (pauseBeforeAtlas) {
      adapters.atlasRefresher = {
        async refresh() {
          return {
            status: 'blocked',
            code: 'stale-atlas',
            message:
              'successor Atlas is intentionally deferred until the sealed Episode is admitted',
            diagnostics: ['qualification-pause-after-episode-seal'],
            writeOccurred: false,
          };
        },
      };
    }
    result = await settleActionLoop(
      contract,
      {
        loopRef: required(args, 'loop-ref'),
        result: { reason: required(args, 'reason') },
        successorAtlas: pauseBeforeAtlas
          ? undefined
          : {
              binding: {
                id: required(args, 'successor-atlas-id'),
                root: required(args, 'successor-atlas-root'),
                state: 'current',
              },
              verification: {
                valid: true,
                atlasRoot: required(args, 'successor-atlas-root'),
                receiptRoot: required(args, 'atlas-verification-receipt-root'),
                diagnostics: [],
              },
            },
        completion: pauseBeforeAtlas ? undefined : completion(args),
        settlement: pauseBeforeAtlas
          ? undefined
          : {
              settlementRoot: required(args, 'settlement-root'),
              outcome: args.outcome || 'completed',
            },
      },
      adapters,
    );
  } else {
    throw new Error(
      'command must be begin, resume, surface, settle, or a -native variant',
    );
  }
  const projected = projectQualificationResult(result);
  if (args.format === 'human')
    process.stdout.write(`${renderQualificationResult(projected)}\n`);
  else process.stdout.write(`${JSON.stringify(projected, null, 2)}\n`);
  if (!result.ok) process.exitCode = 2;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
