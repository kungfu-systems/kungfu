// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { semanticRoot } from '@kungfu-tech/work/project-cut';

const DEFAULT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const CONTRACT =
  'framework/core/episode-admission/episode-admission.contract.json';
const ACTIONS = [
  'contract',
  'plan',
  'execute',
  'inspect',
  'resume',
  'reconcile',
  'cancel',
];
const TRANSPORTS = ['local-direct', 'bundle', 'remote-stream'];

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

export function checkEpisodeAdmissionContract(root = DEFAULT_ROOT) {
  const contract = JSON.parse(read(root, CONTRACT));
  if (contract.schema !== 'kungfu.episode-admission.contract/v1')
    throw new Error('Episode Admission contract schema drifted');
  if (JSON.stringify(contract.actions) !== JSON.stringify(ACTIONS))
    throw new Error('Episode Admission action vocabulary drifted');
  if (JSON.stringify(contract.transports) !== JSON.stringify(TRANSPORTS))
    throw new Error('Episode Admission transport vocabulary drifted');
  if (
    contract.authority !== 'destination-yijinjing-journal' ||
    contract.mutationBoundary?.destinationDecides !== true ||
    contract.mutationBoundary?.sourceIsReadOnly !== true ||
    contract.mutationBoundary?.forceOverride !== false
  )
    throw new Error('Episode Admission authority boundary drifted');
  if (
    contract.remoteBoundary?.implementationStatus !== 'local-simulation-only' ||
    contract.remoteBoundary?.versionNegotiationRequired !== true ||
    contract.remoteBoundary?.authenticationRequired !== true ||
    contract.remoteBoundary?.encryptionRequired !== true ||
    contract.remoteBoundary?.backpressureRequired !== true ||
    contract.remoteBoundary?.resumeBindsPlanRoot !== true ||
    contract.remoteBoundary?.replayRequiresFreshDestinationFrontier !== true ||
    contract.remoteBoundary?.secretsInPlanOrReceipt !== false
  )
    throw new Error('Episode Admission remote safety boundary drifted');

  const core = read(
    root,
    'framework/core/src/libkungfu/src/runtime/storage/episode_admission.cpp',
  );
  const python = read(
    root,
    'framework/core/src/python/kungfu/storage/service.py',
  );
  const typescript = read(root, 'framework/api/src/capability/storage.ts');
  const cli = read(
    root,
    'framework/core/src/python/kungfu/cli/commands/workspace.py',
  );
  const registry = JSON.parse(
    read(root, 'framework/core/src/python/kungfu/agent/kfd3_api.registry.json'),
  );
  const commands = JSON.parse(
    read(root, 'framework/core/src/python/kungfu/agent/commands.json'),
  );
  for (const action of ACTIONS) {
    if (!core.includes(`"${action}"`))
      throw new Error(`C++ Episode Admission action is missing: ${action}`);
  }
  for (const transport of TRANSPORTS) {
    if (!core.includes(`"${transport}"`))
      throw new Error(
        `C++ Episode Admission transport is missing: ${transport}`,
      );
  }
  if (
    !python.includes('def episode_admission(') ||
    !typescript.includes('episodeAdmission:')
  )
    throw new Error('Episode Admission binding projection is missing');
  if (!cli.includes('def pull(') || !cli.includes('def push('))
    throw new Error('Workspace Push/Pull CLI projection is missing');
  const apiIds = new Set(registry.apis.map((row) => row.id));
  const commandIds = new Set(commands.commands.map((row) => row.apiId));
  for (const apiId of ['kungfu.workspace.pull', 'kungfu.workspace.push']) {
    if (!apiIds.has(apiId) || !commandIds.has(apiId))
      throw new Error(
        `Workspace Push/Pull Agent projection is missing: ${apiId}`,
      );
  }

  return {
    contractRoot: semanticRoot(contract),
    actions: contract.actions.length,
    transports: contract.transports.length,
    states: contract.states.length,
  };
}
