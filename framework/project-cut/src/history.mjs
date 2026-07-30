// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import {
  parseRootJson,
  semanticRoot,
  verifyProjectCut,
} from './project-cut.mjs';

export const HISTORY_REQUEST_SCHEMA = 'project.cut.history-request/v1';
export const HISTORY_OBSERVATION_SCHEMA = 'project.cut.history-observation/v1';

const ROOT = /^sha256:[0-9a-f]{64}$/u;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REF = /^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u;
const OPERATIONS = new Set([
  'publish',
  'branch',
  'merge',
  'rebase',
  'amend',
  'squash',
  'revert',
  'cherry-pick',
  'empty',
  'recovery',
]);
const REWRITE_OPERATIONS = new Set([
  'rebase',
  'amend',
  'squash',
  'cherry-pick',
]);
const OPERATION_RELATIONS = new Map([
  ['publish', 'new'],
  ['branch', 'same'],
  ['merge', 'successor'],
  ['rebase', 'same'],
  ['amend', 'same'],
  ['squash', 'same'],
  ['revert', 'successor'],
  ['cherry-pick', 'same'],
  ['empty', 'new'],
  ['recovery', 'successor'],
]);

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function gitResult(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

function diagnostic(code, path, detail) {
  return { code, path, detail };
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareText);
}

function sameStrings(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function normalizeDiagnostics(items) {
  return items.sort(
    (left, right) =>
      compareText(left.path, right.path) || compareText(left.code, right.code),
  );
}

function requireExactKeys(value, allowed, required, at, diagnostics) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push(diagnostic('invalid-type', at, 'expected an object'));
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      diagnostics.push(
        diagnostic('unknown-field', `${at}.${key}`, 'field is not admitted'),
      );
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key))
      diagnostics.push(
        diagnostic(
          'missing-field',
          `${at}.${key}`,
          'required field is missing',
        ),
      );
  }
  return true;
}

function requireRoot(value, at, diagnostics, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !ROOT.test(value))
    diagnostics.push(diagnostic('invalid-root', at, 'expected a sha256 root'));
}

function requireOid(value, at, diagnostics, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !OID.test(value))
    diagnostics.push(diagnostic('invalid-oid', at, 'expected a Git object id'));
}

function requireRootArray(value, at, diagnostics) {
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic('invalid-type', at, 'expected an array'));
    return [];
  }
  for (const [index, root] of value.entries())
    requireRoot(root, `${at}[${index}]`, diagnostics);
  const normalized = sortedUnique(
    value.filter((item) => typeof item === 'string'),
  );
  if (!sameStrings(value, normalized))
    diagnostics.push(
      diagnostic(
        'non-canonical-order',
        at,
        'roots must be byte-sorted and unique',
      ),
    );
  return normalized;
}

function commitFacts(root, commitInput) {
  const commitOid = git(root, ['rev-parse', `${commitInput}^{commit}`]);
  const treeOid = git(root, ['rev-parse', `${commitOid}^{tree}`]);
  const line = git(root, ['rev-list', '--parents', '-n', '1', commitOid]).split(
    ' ',
  );
  return { commitOid, treeOid, parentCommitOids: line.slice(1) };
}

function cutInventory(root, commitOid) {
  const names = git(root, ['ls-tree', '-r', '-z', '--name-only', commitOid])
    .split('\0')
    .filter(Boolean)
    .filter(
      (entry) =>
        entry.startsWith('.kungfu/project-cuts/') &&
        (entry.endsWith('/manifest.json') || entry.endsWith('/cut.json')),
    );
  const cuts = new Map();
  const diagnostics = [];
  for (const path of names) {
    try {
      const cut = parseRootJson(git(root, ['show', `${commitOid}:${path}`]));
      const verified = verifyProjectCut(cut, {
        availableParentRoots: cut.parentCutRoots ?? [],
      });
      if (!verified.valid) {
        diagnostics.push(
          ...verified.diagnostics.map((entry) =>
            diagnostic(entry.code, `${path}:${entry.path}`, entry.message),
          ),
        );
        continue;
      }
      cuts.set(cut.cutRoot, { path, cut });
    } catch (error) {
      diagnostics.push(
        diagnostic(error.code ?? 'invalid-cut', path, String(error.message)),
      );
    }
  }
  return { cuts, diagnostics };
}

function requestDiagnostics(request) {
  const diagnostics = [];
  if (
    !requireExactKeys(
      request,
      [
        'schema',
        'operation',
        'commit',
        'cutRoots',
        'episodeRoots',
        'integrationEpisodeRoot',
        'semanticRelation',
        'priorBindings',
        'ref',
      ],
      [
        'schema',
        'operation',
        'commit',
        'cutRoots',
        'episodeRoots',
        'integrationEpisodeRoot',
        'semanticRelation',
        'priorBindings',
        'ref',
      ],
      '$',
      diagnostics,
    )
  )
    return diagnostics;
  if (request.schema !== HISTORY_REQUEST_SCHEMA)
    diagnostics.push(
      diagnostic('unknown-version', '$.schema', 'unsupported request schema'),
    );
  if (!OPERATIONS.has(request.operation))
    diagnostics.push(
      diagnostic(
        'invalid-operation',
        '$.operation',
        'operation is not supported',
      ),
    );
  if (typeof request.commit !== 'string' || request.commit.length === 0)
    diagnostics.push(
      diagnostic('invalid-type', '$.commit', 'commit ref is required'),
    );
  requireRootArray(request.cutRoots, '$.cutRoots', diagnostics);
  requireRootArray(request.episodeRoots, '$.episodeRoots', diagnostics);
  requireRoot(
    request.integrationEpisodeRoot,
    '$.integrationEpisodeRoot',
    diagnostics,
    true,
  );
  if (!['new', 'same', 'successor'].includes(request.semanticRelation))
    diagnostics.push(
      diagnostic(
        'invalid-relation',
        '$.semanticRelation',
        'relation must be new, same, or successor',
      ),
    );
  if (!Array.isArray(request.priorBindings))
    diagnostics.push(
      diagnostic('invalid-type', '$.priorBindings', 'expected an array'),
    );
  if (request.ref !== null) {
    if (
      requireExactKeys(
        request.ref,
        ['name', 'expectedOid'],
        ['name', 'expectedOid'],
        '$.ref',
        diagnostics,
      )
    ) {
      if (typeof request.ref.name !== 'string' || !REF.test(request.ref.name))
        diagnostics.push(
          diagnostic(
            'invalid-ref',
            '$.ref.name',
            'expected refs/heads or refs/tags',
          ),
        );
      requireOid(request.ref.expectedOid, '$.ref.expectedOid', diagnostics);
    }
  }
  return diagnostics;
}

function verifiedPriorBindings(values, diagnostics) {
  if (!Array.isArray(values)) return [];
  const verified = [];
  for (const [index, value] of values.entries()) {
    const result = verifyHistoryObservation(value);
    if (!result.ok) {
      diagnostics.push(
        ...result.diagnostics.map((entry) => ({
          ...entry,
          path: `$.priorBindings[${index}]:${entry.path}`,
        })),
      );
    } else if (value.status !== 'qualified') {
      diagnostics.push(
        diagnostic(
          'incomplete-prior-binding',
          `$.priorBindings[${index}]`,
          'only qualified observations can authorize a history relation',
        ),
      );
    } else {
      verified.push(value);
    }
  }
  return verified;
}

function currentRef(root, name) {
  const result = gitResult(root, ['rev-parse', '--verify', `${name}^{commit}`]);
  return result.status === 0 ? result.stdout.trim() : null;
}

function operationDiagnostics(
  root,
  request,
  publication,
  cuts,
  priors,
  diagnostics,
) {
  const requestedRoots = request.cutRoots;
  const priorRoots = sortedUnique(
    priors.flatMap((binding) => binding.semantics.cutRoots),
  );
  const declaredParentRoots = sortedUnique(
    requestedRoots.flatMap(
      (rootValue) => cuts.get(rootValue)?.cut.parentCutRoots ?? [],
    ),
  );
  const expectedRelation = OPERATION_RELATIONS.get(request.operation);
  if (request.semanticRelation !== expectedRelation)
    diagnostics.push(
      diagnostic(
        'invalid-relation',
        '$.semanticRelation',
        `${request.operation} requires the ${expectedRelation} relation`,
      ),
    );
  for (const rootValue of requestedRoots) {
    if (!cuts.has(rootValue))
      diagnostics.push(
        diagnostic(
          'missing-cut',
          '$.cutRoots',
          `${rootValue} is not present in the commit tree`,
        ),
      );
  }
  if (
    publication.parentCommitOids.length > 1 &&
    request.operation !== 'merge' &&
    request.semanticRelation !== 'same'
  )
    diagnostics.push(
      diagnostic(
        'unqualified-merge',
        '$.operation',
        'a multi-parent commit must use the merge operation',
      ),
    );
  if (request.operation === 'merge') {
    if (publication.parentCommitOids.length < 2)
      diagnostics.push(
        diagnostic(
          'not-a-merge',
          '$.commit',
          'merge requires multiple Git parents',
        ),
      );
    if (request.integrationEpisodeRoot === null)
      diagnostics.push(
        diagnostic(
          'missing-integration-episode',
          '$.integrationEpisodeRoot',
          'merge conflict selection requires an independent Integration Episode',
        ),
      );
    else if (!request.episodeRoots.includes(request.integrationEpisodeRoot))
      diagnostics.push(
        diagnostic(
          'unadmitted-integration-episode',
          '$.episodeRoots',
          'the Integration Episode must be present in the admitted Episode set',
        ),
      );
    const priorCommits = sortedUnique(
      priors.map((binding) => binding.publication.commitOid),
    );
    const gitParents = sortedUnique(publication.parentCommitOids);
    if (!sameStrings(priorCommits, gitParents))
      diagnostics.push(
        diagnostic(
          'parent-publication-mismatch',
          '$.priorBindings',
          'merge prior bindings must qualify the exact Git parent commits',
        ),
      );
    for (const rootValue of priorRoots) {
      if (!declaredParentRoots.includes(rootValue))
        diagnostics.push(
          diagnostic(
            'parent-cut-mismatch',
            '$.cutRoots',
            `merge output does not declare parent cut ${rootValue}`,
          ),
        );
    }
  }
  if (REWRITE_OPERATIONS.has(request.operation)) {
    if (priors.length === 0)
      diagnostics.push(
        diagnostic(
          'unqualified-rewrite',
          '$.priorBindings',
          'rewrite and republish operations require prior rooted bindings',
        ),
      );
    if (
      request.semanticRelation === 'same' &&
      !sameStrings(requestedRoots, priorRoots)
    )
      diagnostics.push(
        diagnostic(
          'semantic-root-drift',
          '$.cutRoots',
          'same relation requires the exact prior cut-root set',
        ),
      );
  }
  if (request.operation === 'publish' && priors.length > 0)
    diagnostics.push(
      diagnostic(
        'unexpected-prior-binding',
        '$.priorBindings',
        'an initial publication cannot claim prior bindings',
      ),
    );
  if (request.operation === 'branch') {
    if (priors.length === 0)
      diagnostics.push(
        diagnostic(
          'missing-prior-binding',
          '$.priorBindings',
          'branch publication requires the source binding',
        ),
      );
    if (!sameStrings(requestedRoots, priorRoots))
      diagnostics.push(
        diagnostic(
          'semantic-root-drift',
          '$.cutRoots',
          'branch publication must preserve the exact source cut-root set',
        ),
      );
  }
  if (request.semanticRelation === 'successor') {
    for (const priorRoot of priorRoots) {
      if (!declaredParentRoots.includes(priorRoot))
        diagnostics.push(
          diagnostic(
            'parent-cut-mismatch',
            '$.cutRoots',
            `successor cuts do not declare ${priorRoot} as a parent`,
          ),
        );
    }
  }
  if (request.operation === 'revert' || request.operation === 'recovery') {
    if (priors.length === 0)
      diagnostics.push(
        diagnostic(
          'missing-prior-binding',
          '$.priorBindings',
          'operation requires the prior publication binding',
        ),
      );
    if (request.semanticRelation !== 'successor')
      diagnostics.push(
        diagnostic(
          'invalid-relation',
          '$.semanticRelation',
          'revert and recovery publish successor cuts',
        ),
      );
    if (request.integrationEpisodeRoot === null)
      diagnostics.push(
        diagnostic(
          'missing-resolution-episode',
          '$.integrationEpisodeRoot',
          'revert and recovery require a resolution Episode',
        ),
      );
    else if (!request.episodeRoots.includes(request.integrationEpisodeRoot))
      diagnostics.push(
        diagnostic(
          'unadmitted-resolution-episode',
          '$.episodeRoots',
          'the resolution Episode must be present in the admitted Episode set',
        ),
      );
  }
  if (request.operation === 'empty') {
    if (publication.parentCommitOids.length !== 1)
      diagnostics.push(
        diagnostic(
          'invalid-empty',
          '$.commit',
          'empty requires exactly one parent',
        ),
      );
    else {
      const parentTree = git(root, [
        'rev-parse',
        `${publication.parentCommitOids[0]}^{tree}`,
      ]);
      if (parentTree !== publication.treeOid)
        diagnostics.push(
          diagnostic(
            'invalid-empty',
            '$.commit',
            'empty commit changes the tree',
          ),
        );
    }
    if (requestedRoots.length !== 0 || request.episodeRoots.length !== 0)
      diagnostics.push(
        diagnostic(
          'invalid-empty',
          '$.cutRoots',
          'empty commit cannot claim new cuts or Episodes',
        ),
      );
  }
  if (request.operation === 'branch' && request.ref === null)
    diagnostics.push(
      diagnostic('missing-ref', '$.ref', 'branch observation requires a ref'),
    );
  if (request.ref !== null) {
    if (gitResult(root, ['check-ref-format', request.ref.name]).status !== 0)
      diagnostics.push(
        diagnostic(
          'invalid-ref',
          '$.ref.name',
          'ref does not satisfy Git check-ref-format',
        ),
      );
    const actual = currentRef(root, request.ref.name);
    if (request.ref.expectedOid !== publication.commitOid)
      diagnostics.push(
        diagnostic(
          'ref-target-mismatch',
          '$.ref.expectedOid',
          'the expected ref target must equal the observed commit',
        ),
      );
    if (actual !== request.ref.expectedOid)
      diagnostics.push(
        diagnostic(
          'ref-cas-lost',
          '$.ref.expectedOid',
          `expected ${request.ref.expectedOid ?? 'missing'}, observed ${actual ?? 'missing'}`,
        ),
      );
  }
}

function qualifiedObservationDiagnostics(value, diagnostics) {
  if (value.status !== 'qualified') return;
  const priorRoots = value.relation.priorBindingRoots;
  const priorCommits = value.relation.priorCommitOids;
  const parents = value.publication.parentCommitOids;
  const integration = value.semantics.integrationEpisodeRoot;
  const episodes = value.semantics.episodeRoots;
  if (value.operation === 'publish' && priorRoots.length > 0)
    diagnostics.push(
      diagnostic(
        'unexpected-prior-binding',
        '$.relation.priorBindingRoots',
        'an initial publication cannot claim prior bindings',
      ),
    );
  if (REWRITE_OPERATIONS.has(value.operation) && priorRoots.length === 0)
    diagnostics.push(
      diagnostic(
        'unqualified-rewrite',
        '$.relation.priorBindingRoots',
        'rewrite and republish observations require prior rooted bindings',
      ),
    );
  if (value.operation === 'branch') {
    if (priorRoots.length === 0)
      diagnostics.push(
        diagnostic(
          'missing-prior-binding',
          '$.relation.priorBindingRoots',
          'branch publication requires the source binding',
        ),
      );
    if (value.ref === null)
      diagnostics.push(
        diagnostic('missing-ref', '$.ref', 'branch observation requires a ref'),
      );
  }
  if (value.operation === 'merge') {
    if (parents.length < 2)
      diagnostics.push(
        diagnostic(
          'not-a-merge',
          '$.publication',
          'merge requires Git parents',
        ),
      );
    if (!sameStrings(sortedUnique(parents), priorCommits))
      diagnostics.push(
        diagnostic(
          'parent-publication-mismatch',
          '$.relation.priorCommitOids',
          'merge bindings must qualify the exact Git parent commits',
        ),
      );
    if (integration === null || !episodes.includes(integration))
      diagnostics.push(
        diagnostic(
          'missing-integration-episode',
          '$.semantics.integrationEpisodeRoot',
          'merge requires an admitted independent Integration Episode',
        ),
      );
  }
  if (value.operation === 'revert' || value.operation === 'recovery') {
    if (priorRoots.length === 0)
      diagnostics.push(
        diagnostic(
          'missing-prior-binding',
          '$.relation.priorBindingRoots',
          'operation requires the prior publication binding',
        ),
      );
    if (integration === null || !episodes.includes(integration))
      diagnostics.push(
        diagnostic(
          'missing-resolution-episode',
          '$.semantics.integrationEpisodeRoot',
          'operation requires an admitted resolution Episode',
        ),
      );
  }
  if (value.operation === 'empty') {
    if (parents.length !== 1)
      diagnostics.push(
        diagnostic(
          'invalid-empty',
          '$.publication.parentCommitOids',
          'empty requires exactly one Git parent',
        ),
      );
    if (
      value.semantics.cutRoots.length !== 0 ||
      value.semantics.episodeRoots.length !== 0
    )
      diagnostics.push(
        diagnostic(
          'invalid-empty',
          '$.semantics',
          'empty cannot claim Cuts or Episodes',
        ),
      );
  }
  if (value.ref !== null) {
    if (value.ref.expectedOid !== value.publication.commitOid)
      diagnostics.push(
        diagnostic(
          'ref-target-mismatch',
          '$.ref.expectedOid',
          'expected ref target must equal the publication commit',
        ),
      );
    if (value.ref.observedOid !== value.ref.expectedOid)
      diagnostics.push(
        diagnostic(
          'ref-cas-lost',
          '$.ref.observedOid',
          'qualified ref evidence must observe its expected target',
        ),
      );
  }
}

export function observeHistory(rootInput, request) {
  const root = resolve(rootInput);
  const diagnostics = requestDiagnostics(request);
  if (diagnostics.length > 0)
    return {
      ok: false,
      action: 'history-observe',
      observation: null,
      diagnostics: normalizeDiagnostics(diagnostics),
    };
  let publication;
  try {
    publication = commitFacts(root, request.commit);
  } catch (error) {
    diagnostics.push(
      diagnostic('unknown-commit', '$.commit', String(error.message)),
    );
    return {
      ok: false,
      action: 'history-observe',
      observation: null,
      diagnostics: normalizeDiagnostics(diagnostics),
    };
  }
  const inventory = cutInventory(root, publication.commitOid);
  diagnostics.push(...inventory.diagnostics);
  const priors = verifiedPriorBindings(request.priorBindings, diagnostics);
  operationDiagnostics(
    root,
    request,
    publication,
    inventory.cuts,
    priors,
    diagnostics,
  );
  const ref =
    request.ref === null
      ? null
      : {
          name: request.ref.name,
          expectedOid: request.ref.expectedOid,
          observedOid: currentRef(root, request.ref.name),
        };
  const normalized = normalizeDiagnostics(diagnostics);
  const core = {
    schema: HISTORY_OBSERVATION_SCHEMA,
    operation: request.operation,
    publication,
    semantics: {
      cutRoots: [...request.cutRoots],
      parentCutRoots: sortedUnique(
        request.cutRoots.flatMap(
          (rootValue) =>
            inventory.cuts.get(rootValue)?.cut.parentCutRoots ?? [],
        ),
      ),
      episodeRoots: [...request.episodeRoots],
      integrationEpisodeRoot: request.integrationEpisodeRoot,
    },
    relation: {
      kind: request.semanticRelation,
      priorBindingRoots: sortedUnique(
        priors.map((binding) => binding.observationRoot),
      ),
      priorCommitOids: sortedUnique(
        priors.map((binding) => binding.publication.commitOid),
      ),
    },
    ref,
    status: normalized.length === 0 ? 'qualified' : 'incomplete',
    diagnostics: normalized,
  };
  const observation = { ...core, observationRoot: semanticRoot(core) };
  return {
    ok: normalized.length === 0,
    action: 'history-observe',
    observation,
    diagnostics: normalized,
  };
}

export function verifyHistoryObservation(value) {
  const diagnostics = [];
  if (
    !requireExactKeys(
      value,
      [
        'schema',
        'operation',
        'publication',
        'semantics',
        'relation',
        'ref',
        'status',
        'diagnostics',
        'observationRoot',
      ],
      [
        'schema',
        'operation',
        'publication',
        'semantics',
        'relation',
        'ref',
        'status',
        'diagnostics',
        'observationRoot',
      ],
      '$',
      diagnostics,
    )
  )
    return { ok: false, diagnostics };
  if (value.schema !== HISTORY_OBSERVATION_SCHEMA)
    diagnostics.push(
      diagnostic(
        'unknown-version',
        '$.schema',
        'unsupported observation schema',
      ),
    );
  if (!OPERATIONS.has(value.operation))
    diagnostics.push(
      diagnostic(
        'invalid-operation',
        '$.operation',
        'operation is not supported',
      ),
    );
  const expectedRelation = OPERATION_RELATIONS.get(value.operation);
  if (
    requireExactKeys(
      value.publication,
      ['commitOid', 'treeOid', 'parentCommitOids'],
      ['commitOid', 'treeOid', 'parentCommitOids'],
      '$.publication',
      diagnostics,
    )
  ) {
    requireOid(
      value.publication.commitOid,
      '$.publication.commitOid',
      diagnostics,
    );
    requireOid(value.publication.treeOid, '$.publication.treeOid', diagnostics);
    if (!Array.isArray(value.publication.parentCommitOids))
      diagnostics.push(
        diagnostic(
          'invalid-type',
          '$.publication.parentCommitOids',
          'expected an array',
        ),
      );
    else
      for (const [index, oid] of value.publication.parentCommitOids.entries())
        requireOid(
          oid,
          `$.publication.parentCommitOids[${index}]`,
          diagnostics,
        );
  }
  if (
    requireExactKeys(
      value.semantics,
      ['cutRoots', 'parentCutRoots', 'episodeRoots', 'integrationEpisodeRoot'],
      ['cutRoots', 'parentCutRoots', 'episodeRoots', 'integrationEpisodeRoot'],
      '$.semantics',
      diagnostics,
    )
  ) {
    requireRootArray(
      value.semantics.cutRoots,
      '$.semantics.cutRoots',
      diagnostics,
    );
    requireRootArray(
      value.semantics.parentCutRoots,
      '$.semantics.parentCutRoots',
      diagnostics,
    );
    requireRootArray(
      value.semantics.episodeRoots,
      '$.semantics.episodeRoots',
      diagnostics,
    );
    requireRoot(
      value.semantics.integrationEpisodeRoot,
      '$.semantics.integrationEpisodeRoot',
      diagnostics,
      true,
    );
  }
  if (
    requireExactKeys(
      value.relation,
      ['kind', 'priorBindingRoots', 'priorCommitOids'],
      ['kind', 'priorBindingRoots', 'priorCommitOids'],
      '$.relation',
      diagnostics,
    )
  ) {
    if (!['new', 'same', 'successor'].includes(value.relation.kind))
      diagnostics.push(
        diagnostic(
          'invalid-relation',
          '$.relation.kind',
          'relation is invalid',
        ),
      );
    else if (value.relation.kind !== expectedRelation)
      diagnostics.push(
        diagnostic(
          'invalid-relation',
          '$.relation.kind',
          `${value.operation} requires the ${expectedRelation} relation`,
        ),
      );
    requireRootArray(
      value.relation.priorBindingRoots,
      '$.relation.priorBindingRoots',
      diagnostics,
    );
    if (!Array.isArray(value.relation.priorCommitOids))
      diagnostics.push(
        diagnostic(
          'invalid-type',
          '$.relation.priorCommitOids',
          'expected an array',
        ),
      );
    else {
      for (const [index, oid] of value.relation.priorCommitOids.entries())
        requireOid(oid, `$.relation.priorCommitOids[${index}]`, diagnostics);
      const normalized = sortedUnique(
        value.relation.priorCommitOids.filter(
          (item) => typeof item === 'string',
        ),
      );
      if (!sameStrings(value.relation.priorCommitOids, normalized))
        diagnostics.push(
          diagnostic(
            'non-canonical-order',
            '$.relation.priorCommitOids',
            'object ids must be byte-sorted and unique',
          ),
        );
    }
  }
  if (value.ref !== null) {
    if (
      requireExactKeys(
        value.ref,
        ['name', 'expectedOid', 'observedOid'],
        ['name', 'expectedOid', 'observedOid'],
        '$.ref',
        diagnostics,
      )
    ) {
      if (typeof value.ref.name !== 'string' || !REF.test(value.ref.name))
        diagnostics.push(
          diagnostic(
            'invalid-ref',
            '$.ref.name',
            'expected refs/heads or refs/tags',
          ),
        );
      requireOid(value.ref.expectedOid, '$.ref.expectedOid', diagnostics);
      requireOid(value.ref.observedOid, '$.ref.observedOid', diagnostics, true);
    }
  }
  if (!['qualified', 'incomplete'].includes(value.status))
    diagnostics.push(
      diagnostic('invalid-status', '$.status', 'status is invalid'),
    );
  if (!Array.isArray(value.diagnostics))
    diagnostics.push(
      diagnostic('invalid-type', '$.diagnostics', 'expected an array'),
    );
  else {
    for (const [index, entry] of value.diagnostics.entries()) {
      if (
        requireExactKeys(
          entry,
          ['code', 'path', 'detail'],
          ['code', 'path', 'detail'],
          `$.diagnostics[${index}]`,
          diagnostics,
        )
      ) {
        for (const key of ['code', 'path', 'detail'])
          if (typeof entry[key] !== 'string' || entry[key].length === 0)
            diagnostics.push(
              diagnostic(
                'invalid-type',
                `$.diagnostics[${index}].${key}`,
                'expected a non-empty string',
              ),
            );
      }
    }
    if (value.status === 'qualified' && value.diagnostics.length !== 0)
      diagnostics.push(
        diagnostic(
          'status-diagnostic-mismatch',
          '$.status',
          'qualified observations cannot contain diagnostics',
        ),
      );
    if (value.status === 'incomplete' && value.diagnostics.length === 0)
      diagnostics.push(
        diagnostic(
          'status-diagnostic-mismatch',
          '$.status',
          'incomplete observations require diagnostics',
        ),
      );
  }
  requireRoot(value.observationRoot, '$.observationRoot', diagnostics);
  if (diagnostics.length === 0)
    qualifiedObservationDiagnostics(value, diagnostics);
  if (diagnostics.length === 0) {
    const { observationRoot: _root, ...preimage } = value;
    if (semanticRoot(preimage) !== value.observationRoot)
      diagnostics.push(
        diagnostic(
          'observation-root-mismatch',
          '$.observationRoot',
          'observation root differs from its canonical preimage',
        ),
      );
  }
  return {
    ok: diagnostics.length === 0,
    diagnostics: normalizeDiagnostics(diagnostics),
  };
}

export function reconcileHistory(rootInput, observations, options = {}) {
  const root = resolve(rootInput);
  const archivedRoots = new Set(options.archivedRoots ?? []);
  const diagnostics = [];
  if (!Array.isArray(observations))
    return {
      ok: false,
      action: 'history-reconcile',
      bindings: [],
      publications: [],
      episodes: [],
      diagnostics: [
        diagnostic('invalid-type', '$', 'observations must be an array'),
      ],
    };
  const bindings = new Map();
  for (const [index, observation] of observations.entries()) {
    const result = verifyHistoryObservation(observation);
    if (!result.ok) {
      diagnostics.push(
        ...result.diagnostics.map((entry) => ({
          ...entry,
          path: `$[${index}]:${entry.path}`,
        })),
      );
      continue;
    }
    if (bindings.has(observation.observationRoot))
      diagnostics.push(
        diagnostic(
          'duplicate-observation',
          `$[${index}].observationRoot`,
          'observation root occurs more than once',
        ),
      );
    else bindings.set(observation.observationRoot, observation);
  }
  const superseded = new Set(
    [...bindings.values()].flatMap(
      (observation) => observation.relation.priorBindingRoots,
    ),
  );
  const publications = new Map();
  const episodes = new Map();
  const initialPublications = new Map();
  const report = [];
  for (const observation of bindings.values()) {
    for (const priorRoot of observation.relation.priorBindingRoots) {
      if (!bindings.has(priorRoot))
        diagnostics.push(
          diagnostic(
            'missing-prior-binding',
            observation.observationRoot,
            `prior binding ${priorRoot} is absent`,
          ),
        );
    }
    for (const cutRoot of observation.semantics.cutRoots) {
      if (!publications.has(cutRoot)) publications.set(cutRoot, new Set());
      publications.get(cutRoot).add(observation.publication.commitOid);
      if (observation.relation.kind === 'new') {
        if (!initialPublications.has(cutRoot))
          initialPublications.set(cutRoot, new Set());
        initialPublications.get(cutRoot).add(observation.observationRoot);
      }
    }
    for (const episodeRoot of observation.semantics.episodeRoots) {
      if (!episodes.has(episodeRoot)) episodes.set(episodeRoot, new Set());
      episodes.get(episodeRoot).add(observation.publication.commitOid);
    }
    const reachable =
      gitResult(root, [
        'for-each-ref',
        '--format=%(refname)',
        '--contains',
        observation.publication.commitOid,
        'refs/heads',
        'refs/tags',
      ]).stdout.trim().length > 0;
    let disposition = 'published';
    if (archivedRoots.has(observation.observationRoot))
      disposition = 'archived';
    else if (superseded.has(observation.observationRoot))
      disposition = 'superseded';
    else if (!reachable) {
      disposition = 'orphaned';
      diagnostics.push(
        diagnostic(
          'orphaned-publication',
          observation.observationRoot,
          'commit is unreachable and the binding is neither superseded nor archived',
        ),
      );
    }
    report.push({
      observationRoot: observation.observationRoot,
      commitOid: observation.publication.commitOid,
      cutRoots: observation.semantics.cutRoots,
      disposition,
    });
  }
  for (const [cutRoot, roots] of initialPublications) {
    if (roots.size > 1)
      diagnostics.push(
        diagnostic(
          'duplicate-initial-publication',
          cutRoot,
          'one Cut has multiple unrelated initial publication observations',
        ),
      );
  }
  const normalized = normalizeDiagnostics(diagnostics);
  return {
    ok: normalized.length === 0,
    action: 'history-reconcile',
    bindings: report.sort((left, right) =>
      compareText(left.observationRoot, right.observationRoot),
    ),
    publications: [...publications.entries()]
      .map(([cutRoot, commitOids]) => ({
        cutRoot,
        commitOids: sortedUnique([...commitOids]),
      }))
      .sort((left, right) => compareText(left.cutRoot, right.cutRoot)),
    episodes: [...episodes.entries()]
      .map(([episodeRoot, commitOids]) => ({
        episodeRoot,
        commitOids: sortedUnique([...commitOids]),
      }))
      .sort((left, right) => compareText(left.episodeRoot, right.episodeRoot)),
    diagnostics: normalized,
  };
}
