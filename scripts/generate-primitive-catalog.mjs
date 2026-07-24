#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const PASSPORT_REGISTRY =
  'framework/incubation/incubation-passport.registry.json';
export const CATALOG_SOURCE =
  'framework/primitive/kungfu-primitive-catalog.contract.json';
export const CATALOG_ARTIFACT =
  'config/primitive/kungfu-primitive-catalog.contract.json';
export const CATALOG_HEADER =
  'framework/core/src/libkungfu/include/kungfu/sdk/generated/primitive_catalog_v1.hpp';

const FACETS = Object.freeze({
  vocabulary: 'docs/vocabulary.registry.json',
  incubationPassports: PASSPORT_REGISTRY,
  kfd1Contracts: 'framework/contract/kungfu-contracts.registry.json',
  invariants: 'framework/invariant/kungfu-invariant.registry.json',
  workLifecycle:
    'framework/work-lifecycle/kungfu-work-lifecycle-operation-matrix.contract.json',
  languageBoundary:
    'framework/core/architecture/layered-api-encoding-boundary.contract.json',
});
const LANGUAGES = Object.freeze(['cpp', 'python', 'node', 'rust']);
const PROMOTION_EVIDENCE = Object.freeze([
  'contract',
  'vectors',
  'invariants',
  'dogfoodReceipts',
]);
const PRIMITIVE_CATALOG_SCHEMA = 'kungfu.primitive-catalog/v1';
const PRIMITIVE_ARTIFACT_SCHEMA = /^kungfu\.primitive(?:[.-])/u;
const MANAGED_PREFIXES = Object.freeze([
  'framework/primitive/contracts/',
  'framework/primitive/operation-slots/',
  'framework/primitive/sdk-slots/',
  'tests/fixtures/primitive/',
]);

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function valueRoot(value) {
  return sha256(JSON.stringify(canonical(value)));
}

function loadJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function fileRoot(root, relativePath) {
  return sha256(fs.readFileSync(path.join(root, relativePath)));
}

function pathRecords(root, paths) {
  return [...new Set(paths)].sort().map((relativePath) => {
    const absolute = path.join(root, relativePath);
    if (!fs.existsSync(absolute)) {
      throw new Error(`missing primitive evidence path: ${relativePath}`);
    }
    return { path: relativePath, root: fileRoot(root, relativePath) };
  });
}

function walkFiles(root, relativeDir) {
  const absolute = path.join(root, relativeDir);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(relativeDir, entry.name);
    return entry.isDirectory() ? walkFiles(root, relative) : [relative];
  });
}

export function managedPrimitiveFiles(root) {
  return MANAGED_PREFIXES.flatMap((prefix) =>
    walkFiles(root, prefix.slice(0, -1)),
  )
    .filter((entry) => !entry.endsWith('/.gitkeep'))
    .sort();
}

export function findGhostArtifacts(managedFiles, declaredArtifacts) {
  const declared = new Set(declaredArtifacts);
  return [...managedFiles]
    .filter((relativePath) => !declared.has(relativePath))
    .sort();
}

function repositoryJsonFiles(root) {
  const result = spawnSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      '*.json',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `cannot enumerate primitive artifact markers: ${(result.stderr || '').trim()}`,
    );
  }
  return result.stdout.split('\0').filter(Boolean).sort();
}

export function discoverPrimitiveArtifacts(
  root = ROOT,
  files = repositoryJsonFiles(root),
) {
  const artifacts = [];
  for (const relativePath of files) {
    const contents = fs.readFileSync(path.join(root, relativePath), 'utf8');
    if (!/"schema"\s*:\s*"kungfu\.primitive(?:[.-])/u.test(contents)) {
      continue;
    }
    const value = JSON.parse(contents);
    const schema = value?.schema;
    if (
      typeof schema !== 'string' ||
      schema === PRIMITIVE_CATALOG_SCHEMA ||
      !PRIMITIVE_ARTIFACT_SCHEMA.test(schema)
    ) {
      continue;
    }
    if (!/^[a-z0-9][a-z0-9-]+$/u.test(value.primitiveId || '')) {
      throw new Error(
        `primitive artifact marker requires primitiveId: ${relativePath}`,
      );
    }
    artifacts.push({
      path: relativePath,
      primitiveId: value.primitiveId,
      schema,
    });
  }
  return artifacts;
}

export function primitiveArtifactClosureIssues({
  managedFiles,
  discoveredArtifacts,
  declaredArtifacts,
}) {
  const issues = [];
  const discoveredByPath = new Map(
    discoveredArtifacts.map((entry) => [entry.path, entry]),
  );
  for (const relativePath of findGhostArtifacts(
    managedFiles,
    declaredArtifacts.keys(),
  )) {
    issues.push(`unregistered-managed-artifact:${relativePath}`);
  }
  for (const artifact of discoveredArtifacts) {
    const declaredPrimitive = declaredArtifacts.get(artifact.path);
    if (!declaredPrimitive) {
      issues.push(`unregistered-machine-artifact:${artifact.path}`);
    } else if (declaredPrimitive !== artifact.primitiveId) {
      issues.push(
        `artifact-primitive-mismatch:${artifact.path}:${artifact.primitiveId}:${declaredPrimitive}`,
      );
    }
  }
  for (const [relativePath] of declaredArtifacts) {
    if (!discoveredByPath.has(relativePath)) {
      issues.push(`declared-artifact-missing-marker:${relativePath}`);
    }
  }
  return issues.sort();
}

function evidenceProjection(root, evidence) {
  return Object.fromEntries(
    PROMOTION_EVIDENCE.map((kind) => {
      const refs = pathRecords(root, evidence[kind] || []);
      return [kind, { state: refs.length > 0 ? 'present' : 'missing', refs }];
    }),
  );
}

function languageProjection(root, evidence, proofs = {}) {
  return Object.fromEntries(
    LANGUAGES.map((language) => {
      const refs = pathRecords(root, evidence[language] || []);
      const proofRefs = pathRecords(root, proofs[language] || []);
      const state =
        refs.length === 0
          ? 'missing'
          : proofRefs.length > 0
            ? 'proved'
            : 'implemented';
      return [language, { state, refs, proofRefs }];
    }),
  );
}

export function verifyPrimitivePromotion(primitive) {
  if (!['admitted', 'stable'].includes(primitive.maturity)) return [];
  const issues = [];
  for (const language of LANGUAGES) {
    if (primitive.languageStates[language]?.state !== 'proved') {
      issues.push(`${primitive.id}:missing-language-proof:${language}`);
    }
  }
  for (const kind of PROMOTION_EVIDENCE) {
    if (primitive.promotionEvidence[kind]?.state !== 'present') {
      issues.push(`${primitive.id}:missing-promotion-evidence:${kind}`);
    }
  }
  return issues;
}

export function verifyPrimitiveCatalogIntegrity(catalog) {
  const { catalogRoot, ...projection } = catalog || {};
  const expected = valueRoot(projection);
  if (catalogRoot !== expected) {
    throw new Error(
      `primitive catalog Root mismatch: ${catalogRoot} != ${expected}`,
    );
  }
  return catalog;
}

export function buildPrimitiveCatalog(root = ROOT) {
  const registry = loadJson(root, PASSPORT_REGISTRY);
  const facetRoots = Object.fromEntries(
    Object.entries(FACETS).map(([id, relativePath]) => [
      id,
      { path: relativePath, root: fileRoot(root, relativePath) },
    ]),
  );
  const seen = new Set();
  const declaredArtifacts = new Map();
  const primitives = [];

  for (const passport of registry.passports || []) {
    for (const declaration of passport.primitiveDeclarations || []) {
      if (seen.has(declaration.id)) {
        throw new Error(`duplicate primitive declaration: ${declaration.id}`);
      }
      seen.add(declaration.id);
      const artifacts = pathRecords(root, declaration.artifacts || []);
      for (const artifact of artifacts) {
        const owner = declaredArtifacts.get(artifact.path);
        if (owner && owner !== declaration.id) {
          throw new Error(
            `primitive artifact declared by multiple primitives: ${artifact.path}`,
          );
        }
        declaredArtifacts.set(artifact.path, declaration.id);
      }
      const primitive = {
        id: declaration.id,
        name: declaration.name,
        layer: declaration.layer,
        maturity: declaration.maturity,
        passportId: passport.id,
        authority: {
          path: declaration.authorityRef,
          root: fileRoot(root, declaration.authorityRef),
        },
        artifacts,
        languageStates: languageProjection(
          root,
          declaration.languageEvidence,
          declaration.languageProofs,
        ),
        promotionEvidence: evidenceProjection(
          root,
          declaration.promotionEvidence,
        ),
        nonClaims: [...declaration.nonClaims],
      };
      primitives.push(primitive);
    }
  }
  primitives.sort((left, right) => left.id.localeCompare(right.id));

  const artifactIssues = primitiveArtifactClosureIssues({
    managedFiles: managedPrimitiveFiles(root),
    discoveredArtifacts: discoverPrimitiveArtifacts(root),
    declaredArtifacts,
  });
  if (artifactIssues.length > 0) {
    throw new Error(
      `primitive artifact closure denied: ${artifactIssues.join(', ')}`,
    );
  }
  const promotionIssues = primitives.flatMap(verifyPrimitivePromotion);
  if (promotionIssues.length > 0) {
    throw new Error(
      `primitive promotion denied: ${promotionIssues.join(', ')}`,
    );
  }

  const projection = {
    schema: PRIMITIVE_CATALOG_SCHEMA,
    id: 'kungfu-primitive-catalog',
    version: 1,
    weldedSurface: 'primitive-catalog',
    contractSchema: {
      kind: 'derived-projection',
      authority: PASSPORT_REGISTRY,
    },
    authority: {
      intake: PASSPORT_REGISTRY,
      rule: 'Derived projection only. Primitive birth and maturity remain owned by the incubation passport registry and referenced evidence.',
    },
    facetRoots,
    primitives,
  };
  return verifyPrimitiveCatalogIntegrity({
    ...projection,
    catalogRoot: valueRoot(projection),
  });
}

export function renderCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

export function renderHeader(catalog) {
  const payload = JSON.stringify(catalog);
  return `// Generated by scripts/generate-primitive-catalog.mjs. Do not edit.\n// SPDX-License-Identifier: Apache-2.0\n#pragma once\n\n#include <string_view>\n\nnamespace kungfu::sdk::generated::primitive_catalog_v1 {\ninline constexpr std::string_view CATALOG_ROOT =\n    \"${catalog.catalogRoot}\";\ninline constexpr std::string_view CATALOG_JSON =\n    R\"KUNGFU_PRIMITIVE(${payload})KUNGFU_PRIMITIVE\";\n} // namespace kungfu::sdk::generated::primitive_catalog_v1\n`;
}

export function expectedOutputs(root = ROOT) {
  const catalog = buildPrimitiveCatalog(root);
  const json = renderCatalog(catalog);
  return new Map([
    [CATALOG_SOURCE, json],
    [CATALOG_ARTIFACT, json],
    [CATALOG_HEADER, renderHeader(catalog)],
  ]);
}

export function generatePrimitiveCatalog({ root = ROOT, check = false } = {}) {
  const stale = [];
  for (const [relativePath, expected] of expectedOutputs(root)) {
    const absolute = path.join(root, relativePath);
    const actual = fs.existsSync(absolute)
      ? fs.readFileSync(absolute, 'utf8')
      : null;
    if (actual === expected) continue;
    if (check) stale.push(relativePath);
    else {
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, expected);
      console.log(`[primitive-catalog] wrote ${relativePath}`);
    }
  }
  if (stale.length > 0) {
    throw new Error(`stale generated primitive catalog: ${stale.join(', ')}`);
  }
  if (check)
    console.log('[primitive-catalog] generated projections are current');
}

const invoked = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invoked) {
  try {
    generatePrimitiveCatalog({ check: process.argv.includes('--check') });
  } catch (error) {
    console.error(`[primitive-catalog] ${error.message}`);
    process.exitCode = 1;
  }
}
