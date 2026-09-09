#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { fileURLToPath } from 'node:url';

import {
  fileRoot,
  generatorClosure,
  loadJson,
  repositoryRoot,
  verifyGeneratorClosure,
  verifyRootRecords,
  writeOrCheckOutputs,
} from './lib/sdk-generator.mjs';

const ROOT = repositoryRoot(import.meta.url);
export const GENERATOR_PATH =
  'scripts/materialize-work-lifecycle-operation-matrix.mjs';
export const GENERATOR_HELPER_PATH = 'scripts/lib/sdk-generator.mjs';
export const MATRIX_PATH =
  'framework/work/work-lifecycle/kungfu-work-lifecycle-operation-matrix.contract.json';
export const CUT_CATALOG_PATH =
  'framework/work/project-cut/work-lifecycle.contract.json';
export const EPISODE_CATALOG_PATH =
  'framework/core/episode/native-operation-catalog.contract.json';

const MANAGED_LAYERS = new Set(['cut', 'episode']);
const SEMANTIC_FIELDS = [
  'id',
  'capability',
  'layer',
  'authorityOwner',
  'authoritySurface',
  'preconditions',
  'result',
  'receipt',
  'idempotency',
  'durability',
  'failureClasses',
  'capabilityContraction',
];
const METADATA_FIELDS = [
  'public',
  'native',
  'currentParity',
  'targetParity',
  'evidence',
];

export function workLifecycleGeneration(root = ROOT) {
  return {
    generator: generatorClosure(root, GENERATOR_PATH, [GENERATOR_HELPER_PATH]),
    semanticSources: {
      cut: { path: CUT_CATALOG_PATH, root: fileRoot(root, CUT_CATALOG_PATH) },
      episode: {
        path: EPISODE_CATALOG_PATH,
        root: fileRoot(root, EPISODE_CATALOG_PATH),
      },
    },
    managedLayers: [...MANAGED_LAYERS],
    retainedMetadata: [...METADATA_FIELDS],
  };
}

export function verifyWorkLifecycleGeneration(generation, root = ROOT) {
  const errors = verifyGeneratorClosure(generation?.generator, root);
  errors.push(...verifyRootRecords(generation?.semanticSources ?? {}, root));
  const expected = workLifecycleGeneration(root);
  for (const id of ['cut', 'episode']) {
    if (
      generation?.semanticSources?.[id]?.path !==
      expected.semanticSources[id].path
    )
      errors.push(`${id}: unexpected semantic source path`);
  }
  if (
    JSON.stringify(generation?.managedLayers) !==
    JSON.stringify(expected.managedLayers)
  )
    errors.push('managed lifecycle layers drifted');
  if (
    JSON.stringify(generation?.retainedMetadata) !==
    JSON.stringify(expected.retainedMetadata)
  )
    errors.push('retained matrix metadata fields drifted');
  return errors;
}

function readJson(relative, root = ROOT) {
  return loadJson(root, relative);
}

function pick(value, fields, label) {
  const result = {};
  for (const field of fields) {
    if (!Object.hasOwn(value, field))
      throw new Error(`${label} is missing ${field}`);
    result[field] = structuredClone(value[field]);
  }
  return result;
}

function operationProjection(semantic, metadata) {
  return {
    id: semantic.id,
    capability: semantic.capability,
    layer: semantic.layer,
    public: metadata.public,
    authorityOwner: semantic.authorityOwner,
    authoritySurface: semantic.authoritySurface,
    preconditions: semantic.preconditions,
    result: semantic.result,
    receipt: semantic.receipt,
    idempotency: semantic.idempotency,
    durability: semantic.durability,
    failureClasses: semantic.failureClasses,
    capabilityContraction: semantic.capabilityContraction,
    native: metadata.native,
    currentParity: metadata.currentParity,
    targetParity: metadata.targetParity,
    evidence: metadata.evidence,
  };
}

export function materializeWorkLifecycleOperationMatrix({
  matrix,
  cutCatalog,
  episodeCatalog,
  generation = workLifecycleGeneration(),
}) {
  if (cutCatalog.schema !== 'project.cut.work-lifecycle-catalog/v1')
    throw new Error('unsupported Project Cut lifecycle catalog');
  if (episodeCatalog.schema !== 'kungfu.episode.native-operation-catalog/v1')
    throw new Error('unsupported Episode native operation catalog');
  const semanticOperations = [
    ...cutCatalog.operations,
    ...episodeCatalog.operations,
  ];
  const semantics = new Map();
  for (const operation of semanticOperations) {
    const semantic = pick(operation, SEMANTIC_FIELDS, operation.id ?? 'entry');
    if (!MANAGED_LAYERS.has(semantic.layer))
      throw new Error(
        `managed operation has unsupported layer ${semantic.layer}`,
      );
    if (semantics.has(semantic.id))
      throw new Error(`duplicate managed operation ${semantic.id}`);
    semantics.set(semantic.id, semantic);
  }

  const projected = [];
  const observed = new Set();
  for (const operation of matrix.operations) {
    const semantic = semantics.get(operation.id);
    if (!semantic) {
      if (MANAGED_LAYERS.has(operation.layer))
        throw new Error(
          `managed matrix row lacks authority catalog: ${operation.id}`,
        );
      projected.push(structuredClone(operation));
      continue;
    }
    observed.add(operation.id);
    const metadata = pick(operation, METADATA_FIELDS, operation.id);
    projected.push(operationProjection(semantic, metadata));
  }
  for (const id of semantics.keys()) {
    if (!observed.has(id))
      throw new Error(`authority catalog row lacks matrix metadata: ${id}`);
  }
  return {
    ...structuredClone(matrix),
    generation: structuredClone(generation),
    operations: projected,
  };
}

export function loadMaterializedMatrix(root = ROOT) {
  return materializeWorkLifecycleOperationMatrix({
    matrix: readJson(MATRIX_PATH, root),
    cutCatalog: readJson(CUT_CATALOG_PATH, root),
    episodeCatalog: readJson(EPISODE_CATALOG_PATH, root),
    generation: workLifecycleGeneration(root),
  });
}

function main() {
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check');
  if (write === check)
    throw new Error('choose exactly one of --write or --check');
  const materialized = `${JSON.stringify(loadMaterializedMatrix(), null, 2)}\n`;
  writeOrCheckOutputs({
    root: ROOT,
    outputs: new Map([[MATRIX_PATH, materialized]]),
    check,
    label: 'work-lifecycle-matrix',
  });
  if (write)
    console.log(
      '[work-lifecycle-matrix] materialized Cut/Episode catalog projection',
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
