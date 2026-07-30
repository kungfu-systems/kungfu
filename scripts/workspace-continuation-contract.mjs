// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { semanticRoot } from '../framework/project-cut/src/project-cut.mjs';

const DEFAULT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const CONTRACT =
  'framework/episode-provider/workspace-continuation.contract.json';
const STATES = [
  'uninitialized',
  'shadow-only',
  'live-runtime',
  'evidence-degraded',
];
const ACTIONS = [
  'inspect-settled-history',
  'start-continuation',
  'request-full-evidence',
  'import-full-evidence',
  'settle-project-cut',
];

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

export function checkWorkspaceContinuationContract(root = DEFAULT_ROOT) {
  const contract = JSON.parse(read(root, CONTRACT));
  if (contract.schema !== 'kungfu.workspace.continuation-contract/v1')
    throw new Error('workspace continuation contract schema drifted');
  if (JSON.stringify(contract.states) !== JSON.stringify(STATES))
    throw new Error('workspace continuation state vocabulary drifted');
  if (
    JSON.stringify(contract.actions.map((action) => action.id)) !==
    JSON.stringify(ACTIONS)
  )
    throw new Error('workspace continuation action vocabulary drifted');
  if (
    contract.authorities?.episodeSemantic !== 'yijinjing-journal' ||
    contract.authorities?.settledHistory !== 'qualified-git-shadow'
  )
    throw new Error('workspace continuation authority boundary drifted');
  if (
    !contract.nonClaims?.includes('git-shadow-is-not-episode-authority') ||
    !contract.nonClaims?.includes('inspection-does-not-initialize-runtime')
  )
    throw new Error('workspace continuation non-claims drifted');

  const python = read(root, 'framework/core/src/python/kungfu/workspace.py');
  const desktop = read(root, 'framework/gui/src/main/workspace-selection.ts');
  const apiRegistry = JSON.parse(
    read(root, 'framework/core/src/python/kungfu/agent/kfd3_api.registry.json'),
  );
  const commands = JSON.parse(
    read(root, 'framework/core/src/python/kungfu/agent/commands.json'),
  );
  for (const state of STATES) {
    if (!python.includes(`\"${state}\"`) || !desktop.includes(`'${state}'`))
      throw new Error(
        `workspace continuation state is not projected: ${state}`,
      );
  }
  const apiIds = [
    'kungfu.workspace.start-continuation',
    'kungfu.workspace.request-full-evidence',
    'kungfu.workspace.import-full-evidence',
  ];
  for (const apiId of apiIds) {
    if (!apiRegistry.apis?.some((row) => row.id === apiId))
      throw new Error(`KFD3 registry is missing ${apiId}`);
    if (!commands.commands?.some((row) => row.apiId === apiId))
      throw new Error(`agent command catalog is missing ${apiId}`);
  }

  return {
    contractRoot: semanticRoot(contract),
    states: contract.states.length,
    actions: contract.actions.length,
  };
}
