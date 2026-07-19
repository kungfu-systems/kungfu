// SPDX-License-Identifier: Apache-2.0

// Qualification-only source harness. This is not a frozen public CLI surface.

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

function invoke(runtime, operation, payload) {
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
        PYTHONPATH: [BINDING, SOURCE, process.env.PYTHONPATH]
          .filter(Boolean)
          .join(path.delimiter),
      },
      input: JSON.stringify(payload),
    },
  );
  if (child.status !== 0)
    throw new Error(child.stderr || `Core adapter exited ${child.status}`);
  return JSON.parse(child.stdout);
}

function ports(runtime) {
  const call = (operation, payload) => invoke(runtime, operation, payload);
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
    executorProfile: 'source-dogfood',
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
    status: envelope.state || result.state || 'unknown',
    identities: Object.fromEntries(
      Object.entries(roles).map(([role, binding]) => [role, binding.id]),
    ),
    authority: Object.fromEntries(
      Object.entries(roles).map(([role, binding]) => [role, binding.root]),
    ),
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
    ...roleLines,
    `factRef: ${projected.factRef?.name || '-'} @ ${projected.factRef?.cutRoot || '-'}#${projected.factRef?.revision ?? '-'}`,
    `residualRisk: ${projected.residualRisk.join(' | ') || 'none'}`,
    `nextStep: ${projected.nextStep || 'none'}`,
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtime = path.resolve(required(args, 'runtime'));
  const adapters = ports(runtime);
  let result;
  if (args.command === 'begin') {
    result = await beginActionLoop(contract, beginRequest(args), adapters);
  } else if (args.command === 'resume' || args.command === 'surface') {
    result = await resumeActionLoop(
      contract,
      required(args, 'loop-ref'),
      adapters,
    );
  } else if (args.command === 'settle') {
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
    throw new Error('command must be begin, resume, surface, or settle');
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
