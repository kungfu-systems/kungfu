// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  contractRoot,
  createPlan,
  fileRoot,
  rooted,
  schemaValidators,
} from '../contract.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const AUTHORITY_PATHS = Object.freeze({
  layers: 'framework/core/architecture/layers.json',
  buildCapabilities: 'framework/core/architecture/build-capabilities.json',
});
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export class ProductionGraphCompileError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'ProductionGraphCompileError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProductionGraphCompileError(code, message);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid-input', `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join('\0') !== wanted.join('\0')) {
    fail(
      'unknown-or-missing-field',
      `${label} fields must be exactly ${wanted.join(', ')}`,
    );
  }
}

function requireRoot(value, label) {
  if (!ROOT_PATTERN.test(value || '')) {
    fail('invalid-root', `${label} must be a sha256 root`);
  }
}

function sortedUnique(values, label) {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== 'string')
  ) {
    fail('invalid-input', `${label} must be an array of strings`);
  }
  const sorted = [...values].sort();
  if (new Set(sorted).size !== sorted.length) {
    fail('duplicate-value', `${label} contains duplicate values`);
  }
  return sorted;
}

function authorityIdentifiers(layers, buildCapabilities) {
  const collect = (records) =>
    new Set((records || []).map(({ id }) => id).filter(Boolean));
  const layerIds = new Set([
    ...collect(layers.layers),
    ...collect(layers.components),
    ...collect(layers.internal_targets),
    ...collect(layers.public_contracts?.levels),
    ...collect(layers.public_contracts?.header_rules),
  ]);
  const buildIds = new Set([
    ...collect(buildCapabilities.components),
    ...collect(buildCapabilities.providers),
    ...collect(buildCapabilities.projections),
    ...collect(buildCapabilities.bindings),
    ...collect(buildCapabilities.dependencies),
    ...collect(buildCapabilities.profiles),
    ...Object.keys(buildCapabilities.target_dependencies || {}),
  ]);
  return { layers: layerIds, 'build-capabilities': buildIds };
}

function loadAndVerifyAuthorities(request, root) {
  const documents = {
    layers: JSON.parse(
      fs.readFileSync(path.join(root, AUTHORITY_PATHS.layers), 'utf8'),
    ),
    buildCapabilities: JSON.parse(
      fs.readFileSync(
        path.join(root, AUTHORITY_PATHS.buildCapabilities),
        'utf8',
      ),
    ),
  };
  const observed = {
    layers: fileRoot(path.join(root, AUTHORITY_PATHS.layers)),
    buildCapabilities: fileRoot(
      path.join(root, AUTHORITY_PATHS.buildCapabilities),
    ),
  };
  for (const field of Object.keys(observed)) {
    requireRoot(request[field], `authorityReferences.${field}`);
    if (request[field] !== observed[field]) {
      fail(
        'authority-root-drift',
        `${field} expected ${request[field]}, observed ${observed[field]}`,
      );
    }
  }
  return {
    identifiers: authorityIdentifiers(
      documents.layers,
      documents.buildCapabilities,
    ),
    roots: observed,
  };
}

function observedSource(root) {
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  return {
    revision: git('rev-parse', 'HEAD'),
    tree: git('rev-parse', 'HEAD^{tree}'),
  };
}

function verifySource(source, observed) {
  exactKeys(source, ['repository', 'revision', 'tree'], 'source');
  for (const field of ['revision', 'tree']) {
    if (source[field] !== observed[field]) {
      fail(
        'source-drift',
        `${field} expected ${source[field]}, observed ${observed[field]}`,
      );
    }
  }
}

function verifyXinfa(request, sourceRevision) {
  exactKeys(request.semanticImpact, ['selectionRoot'], 'semanticImpact');
  exactKeys(
    request.xinfaVerification,
    ['owner', 'selectionRoot', 'sourceRevision', 'status', 'verificationRoot'],
    'xinfaVerification',
  );
  const verification = request.xinfaVerification;
  requireRoot(
    request.semanticImpact.selectionRoot,
    'semanticImpact.selectionRoot',
  );
  requireRoot(verification.selectionRoot, 'xinfaVerification.selectionRoot');
  requireRoot(
    verification.verificationRoot,
    'xinfaVerification.verificationRoot',
  );
  if (verification.owner !== 'xinfa' || verification.status !== 'verified') {
    fail('xinfa-selection-unverified', 'Xinfa must own a verified selection');
  }
  if (verification.sourceRevision !== sourceRevision) {
    fail('xinfa-selection-stale', 'Xinfa selection source revision drifted');
  }
  if (verification.selectionRoot !== request.semanticImpact.selectionRoot) {
    fail('xinfa-selection-root-mismatch', 'Xinfa selection roots differ');
  }
}

function normalizeReference(reference, label, rootedInput) {
  exactKeys(reference, ['id', 'kind', 'root'], label);
  if (rootedInput && reference.root === null) {
    fail('unrooted-compiler-input', `${label}.root must retain an exact root`);
  }
  return {
    id: reference.id,
    kind: reference.kind,
    root: reference.root,
  };
}

function normalizeNode(node, identifiers) {
  exactKeys(
    node,
    [
      'authorityRefs',
      'dependencies',
      'events',
      'executor',
      'exit',
      'failure',
      'id',
      'inputs',
      'nextAction',
      'outputs',
      'recovery',
    ],
    `node.${node?.id || 'unknown'}`,
  );
  exactKeys(
    node.executor,
    ['entrypoint', 'executionOwnedBy', 'invokedByVerifier', 'task'],
    `${node.id}.executor`,
  );
  exactKeys(
    node.exit,
    [
      'cancellationIsNonQualifying',
      'failureIsNonQualifying',
      'successCodes',
      'timeoutSeconds',
    ],
    `${node.id}.exit`,
  );
  exactKeys(node.failure, ['owner', 'retainedEvidence'], `${node.id}.failure`);
  exactKeys(node.recovery, ['nextAction', 'strategy'], `${node.id}.recovery`);
  const authorityRefs = [...(node.authorityRefs || [])]
    .map((reference, index) => {
      exactKeys(
        reference,
        ['authority', 'id'],
        `${node.id}.authorityRefs.${index}`,
      );
      return {
        authority: reference.authority,
        id: reference.id,
      };
    })
    .sort((left, right) =>
      `${left.authority}\0${left.id}`.localeCompare(
        `${right.authority}\0${right.id}`,
      ),
    );
  for (const reference of authorityRefs) {
    const ids = identifiers[reference.authority];
    if (!ids || !ids.has(reference.id)) {
      fail(
        'unknown-authority-reference',
        `${node.id} references ${reference.authority}:${reference.id}`,
      );
    }
  }
  const references = (values, label, rootedInput) =>
    [...(values || [])]
      .map((reference, index) =>
        normalizeReference(reference, `${label}.${index}`, rootedInput),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
  return {
    id: node.id,
    authorityRefs,
    dependencies: sortedUnique(
      node.dependencies || [],
      `${node.id}.dependencies`,
    ),
    executor: {
      entrypoint: node.executor?.entrypoint,
      task: node.executor?.task,
      executionOwnedBy: node.executor?.executionOwnedBy,
      invokedByVerifier: node.executor?.invokedByVerifier,
    },
    inputs: references(node.inputs, `${node.id}.inputs`, true),
    outputs: references(node.outputs, `${node.id}.outputs`, false),
    events: sortedUnique(node.events || [], `${node.id}.events`),
    exit: {
      successCodes: [...(node.exit?.successCodes || [])].sort((a, b) => a - b),
      timeoutSeconds: node.exit?.timeoutSeconds,
      failureIsNonQualifying: node.exit?.failureIsNonQualifying,
      cancellationIsNonQualifying: node.exit?.cancellationIsNonQualifying,
    },
    failure: {
      owner: node.failure?.owner,
      retainedEvidence: sortedUnique(
        node.failure?.retainedEvidence || [],
        `${node.id}.failure.retainedEvidence`,
      ),
    },
    recovery: {
      strategy: node.recovery?.strategy,
      nextAction: node.recovery?.nextAction,
    },
    nextAction: node.nextAction,
  };
}

function schemaErrors(validate, document) {
  if (validate(document)) return [];
  return (validate.errors || []).map(
    ({ instancePath, message }) => `${instancePath || '/'} ${message}`,
  );
}

export async function compileProductionGraph(
  request,
  { root = ROOT, source = observedSource(root), validators = null } = {},
) {
  exactKeys(
    request,
    [
      'authorityReferences',
      'graphId',
      'intent',
      'nextAction',
      'nodes',
      'schema',
      'semanticImpact',
      'source',
      'xinfaVerification',
    ],
    'request',
  );
  if (request.schema !== 'shifu.production-graph-compile-request/v0') {
    fail('unsupported-schema', 'compile request schema is unsupported');
  }
  exactKeys(
    request.authorityReferences,
    ['buildCapabilities', 'layers'],
    'authorityReferences',
  );
  exactKeys(
    request.intent,
    ['mode', 'requestedOutputs', 'sideEffects', 'summary'],
    'intent',
  );
  if (!Array.isArray(request.nodes)) {
    fail('invalid-input', 'nodes must be an array');
  }
  verifySource(request.source, source);
  verifyXinfa(request, request.source.revision);
  const authority = loadAndVerifyAuthorities(request.authorityReferences, root);
  const nodes = [...request.nodes]
    .map((node) => normalizeNode(node, authority.identifiers))
    .sort((left, right) => left.id.localeCompare(right.id));
  const graph = rooted(
    {
      schema: 'shifu.production-graph/v0',
      graphId: request.graphId,
      contractRoot: contractRoot(root),
      source: request.source,
      authorityReferences: authority.roots,
      semanticImpact: {
        owner: 'xinfa',
        selectionRoot: request.semanticImpact.selectionRoot,
        otherInputs: [],
      },
      intent: {
        mode: request.intent.mode,
        summary: request.intent.summary,
        requestedOutputs: sortedUnique(
          request.intent.requestedOutputs,
          'intent.requestedOutputs',
        ),
        sideEffects: request.intent.sideEffects,
      },
      nodes,
      nextAction: request.nextAction,
    },
    'graphRoot',
  );
  const plan = createPlan(graph);
  const checks = validators || (await schemaValidators(root));
  const errors = [
    ...schemaErrors(checks.graph, graph),
    ...schemaErrors(checks.plan, plan),
  ];
  if (errors.length) fail('schema-invalid', errors.join('; '));
  return { graph, plan };
}

export { AUTHORITY_PATHS };
