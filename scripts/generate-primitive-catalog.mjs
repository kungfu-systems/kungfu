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
  'framework/spec/incubation/incubation-passport.registry.json';
export const CATALOG_SOURCE =
  'framework/spec/primitive/kungfu-primitive-catalog.contract.json';
export const CATALOG_ARTIFACT =
  'config/primitive/kungfu-primitive-catalog.contract.json';
export const CATALOG_HEADER =
  'framework/core/src/libkungfu/include/kungfu/sdk/generated/primitive_catalog_v2.hpp';

const FACETS = Object.freeze({
  vocabulary: 'docs/vocabulary.registry.json',
  incubationPassports: PASSPORT_REGISTRY,
  kfd1Contracts: 'framework/spec/contract/kungfu-contracts.registry.json',
  invariants: 'framework/spec/invariant/kungfu-invariant.registry.json',
  workLifecycle:
    'framework/work/work-lifecycle/kungfu-work-lifecycle-operation-matrix.contract.json',
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
const PRIMITIVE_CATALOG_SCHEMA = 'kungfu.primitive-catalog/v2';
const CPP_LITERAL_MAX_BYTES = 8 * 1024;
const PRIMITIVE_ARTIFACT_SCHEMA = /^kungfu\.primitive(?:[.-])/u;
const MANAGED_PREFIXES = Object.freeze([
  'framework/spec/primitive/contracts/',
  'framework/spec/primitive/operation-slots/',
  'framework/spec/primitive/sdk-slots/',
  'tests/fixtures/primitive/',
]);
const CLASSIFICATION_FAMILIES = new Set([
  'semantic-substrate',
  'ontology-binding',
  'coordinate',
  'domain-projection',
  'responsibility-role',
  'ordinary-capability',
]);
const RELATION_KINDS = new Set([
  'depends-on',
  'composes',
  'binds',
  'projects',
  'implements',
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
    if (!/"schema"\s*:\s*"kungfu\.primitive(?:[.-])/u.test(contents)) continue;
    const value = JSON.parse(contents);
    const schema = value?.schema;
    if (
      typeof schema !== 'string' ||
      schema === PRIMITIVE_CATALOG_SCHEMA ||
      schema === 'kungfu.primitive-catalog/v1' ||
      !PRIMITIVE_ARTIFACT_SCHEMA.test(schema)
    )
      continue;
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

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be explicit`);
  }
  return value;
}

export function verifyPrimitiveDefinition(declaration) {
  const issues = [];
  const classification = declaration.classification || {};
  const threshold = declaration.admissionThreshold || {};
  if (!CLASSIFICATION_FAMILIES.has(classification.family)) {
    issues.push(`${declaration.id}:invalid-classification-family`);
  }
  if (
    !['active', 'superseded', 'retired'].includes(declaration.lifecycle?.state)
  ) {
    issues.push(`${declaration.id}:invalid-definition-lifecycle`);
  }
  if (threshold.independentDurableSemantics !== true) {
    issues.push(`${declaration.id}:no-independent-durable-semantics`);
  }
  if (
    !['claimed', 'not-claimed'].includes(
      threshold.crossDomainOrRuntimeRelevance,
    )
  ) {
    issues.push(`${declaration.id}:invalid-cross-domain-relevance`);
  }
  if (
    !['responsibility', 'persistent-fact', 'both'].includes(
      threshold.boundaryParticipation,
    )
  ) {
    issues.push(`${declaration.id}:invalid-boundary-participation`);
  }
  for (const key of ['deletion', 'substitution', 'compression']) {
    if (
      typeof threshold[`${key}Rationale`] !== 'string' ||
      !threshold[`${key}Rationale`].trim()
    ) {
      issues.push(`${declaration.id}:missing-${key}-rationale`);
    }
  }
  return issues;
}

function definitionProjection(root, declaration) {
  const issues = verifyPrimitiveDefinition(declaration);
  if (issues.length)
    throw new Error(`primitive definition denied: ${issues.join(', ')}`);
  return {
    identity: { id: declaration.id, name: declaration.name },
    classification: declaration.classification,
    lifecycle: declaration.lifecycle,
    semantics: {
      authority: {
        path: declaration.authorityRef,
        root: fileRoot(root, declaration.authorityRef),
      },
      invariants: pathRecords(
        root,
        declaration.promotionEvidence?.invariants || [],
      ),
      admissionThreshold: declaration.admissionThreshold,
    },
  };
}

function relationProjection(root, declaration) {
  return (declaration.relations || []).map((relation) => {
    if (!RELATION_KINDS.has(relation.kind)) {
      throw new Error(
        `${declaration.id}:invalid-relation-kind:${relation.kind}`,
      );
    }
    if (relation.target === declaration.id) {
      throw new Error(`${declaration.id}:self-relation-denied`);
    }
    return {
      source: declaration.id,
      kind: relation.kind,
      target: requireText(relation.target, `${declaration.id} relation target`),
      layerBoundary: requireText(
        relation.layerBoundary,
        `${declaration.id} relation layerBoundary`,
      ),
      authority: {
        path: relation.authorityRef,
        root: fileRoot(root, relation.authorityRef),
      },
    };
  });
}

function axis(state, refs, policy) {
  return { state, refs, policy };
}

function admissionProjection(root, declaration) {
  const languages = languageProjection(
    root,
    declaration.languageEvidence,
    declaration.languageProofs,
  );
  const evidence = evidenceProjection(
    root,
    declaration.promotionEvidence || {},
  );
  const languageValues = Object.values(languages);
  const implemented = languageValues.filter(
    (entry) => entry.state !== 'missing',
  ).length;
  const proved = languageValues.filter(
    (entry) => entry.state === 'proved',
  ).length;
  const semanticRefs = [
    {
      path: declaration.authorityRef,
      root: fileRoot(root, declaration.authorityRef),
    },
    ...evidence.invariants.refs,
  ];
  const vector = {
    semanticStability: axis(
      declaration.lifecycle.state === 'active' && semanticRefs.length > 1
        ? 'qualified'
        : declaration.lifecycle.state === 'active'
          ? 'declared'
          : declaration.lifecycle.state,
      semanticRefs,
      'active authority plus invariant evidence qualifies semantic stability',
    ),
    implementationCompleteness: axis(
      implemented === 0
        ? 'missing'
        : implemented === LANGUAGES.length
          ? 'complete'
          : 'partial',
      languageValues.flatMap((entry) => entry.refs),
      'all four language implementation references are required for complete',
    ),
    languageConformance: axis(
      proved === 0
        ? 'unproved'
        : proved === LANGUAGES.length
          ? 'proved'
          : 'partial',
      languageValues.flatMap((entry) => entry.proofRefs),
      'all four language proof references are required for proved',
    ),
    artifactShipment: axis(
      declaration.artifacts.length > 0 ? 'declared' : 'not-shipped',
      pathRecords(root, declaration.artifacts || []),
      'declared shipped artifacts must close through the artifact join',
    ),
    qualification: axis(
      evidence.contract.state === 'present' &&
        evidence.vectors.state === 'present' &&
        evidence.invariants.state === 'present'
        ? 'qualified'
        : 'incomplete',
      [
        ...evidence.contract.refs,
        ...evidence.vectors.refs,
        ...evidence.invariants.refs,
      ],
      'contract, vector, and invariant evidence are jointly required',
    ),
    operationalEvidence: axis(
      implemented > 0 ? 'observed' : 'unobserved',
      languageValues.flatMap((entry) => entry.refs),
      'implementation references are bounded operational evidence, not availability',
    ),
    retainedUseEvidence: axis(
      evidence.dogfoodReceipts.state === 'present' ? 'retained' : 'unproved',
      evidence.dogfoodReceipts.refs,
      'retained use requires durable dogfood receipt references',
    ),
  };
  const admitted =
    vector.semanticStability.state === 'qualified' &&
    vector.implementationCompleteness.state === 'complete' &&
    vector.languageConformance.state === 'proved' &&
    vector.qualification.state === 'qualified' &&
    vector.retainedUseEvidence.state === 'retained';
  const candidate =
    vector.semanticStability.state === 'qualified' &&
    vector.qualification.state === 'qualified';
  const experimental = implemented > 0;
  return {
    vector,
    languageStates: languages,
    evidence,
    summary: {
      state: admitted
        ? 'admitted'
        : candidate
          ? 'candidate'
          : experimental
            ? 'experimental'
            : 'incubating',
      policy: 'kungfu.primitive-admission-summary/v2',
      conclusionOnly: true,
      mutableByLabel: false,
    },
    nonClaims: [...declaration.nonClaims],
  };
}

export function verifyPrimitivePromotion(primitive) {
  if (!['admitted', 'stable'].includes(primitive.admission?.summary?.state))
    return [];
  const issues = [];
  for (const language of LANGUAGES) {
    if (primitive.admission.languageStates[language]?.state !== 'proved') {
      issues.push(`${primitive.id}:missing-language-proof:${language}`);
    }
  }
  for (const kind of PROMOTION_EVIDENCE) {
    if (primitive.admission.evidence[kind]?.state !== 'present') {
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
  const relations = [];

  for (const passport of registry.passports || []) {
    for (const declaration of passport.primitiveDeclarations || []) {
      if (seen.has(declaration.id))
        throw new Error(`duplicate primitive declaration: ${declaration.id}`);
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
      const definition = definitionProjection(root, declaration);
      const admission = admissionProjection(root, declaration);
      const rowRelations = relationProjection(root, declaration);
      relations.push(...rowRelations);
      primitives.push({
        id: declaration.id,
        passportId: passport.id,
        definition,
        admission,
        artifacts,
      });
    }
  }
  primitives.sort((left, right) => left.id.localeCompare(right.id));
  relations.sort((left, right) =>
    `${left.source}\0${left.kind}\0${left.target}`.localeCompare(
      `${right.source}\0${right.kind}\0${right.target}`,
    ),
  );
  for (const relation of relations) {
    if (!seen.has(relation.target)) {
      throw new Error(
        `${relation.source}:unknown-relation-target:${relation.target}`,
      );
    }
  }

  const artifactIssues = primitiveArtifactClosureIssues({
    managedFiles: managedPrimitiveFiles(root),
    discoveredArtifacts: discoverPrimitiveArtifacts(root),
    declaredArtifacts,
  });
  if (artifactIssues.length) {
    throw new Error(
      `primitive artifact closure denied: ${artifactIssues.join(', ')}`,
    );
  }
  const promotionIssues = primitives.flatMap(verifyPrimitivePromotion);
  if (promotionIssues.length) {
    throw new Error(
      `primitive promotion denied: ${promotionIssues.join(', ')}`,
    );
  }

  const projection = {
    schema: PRIMITIVE_CATALOG_SCHEMA,
    id: 'kungfu-primitive-catalog',
    version: 2,
    weldedSurface: 'primitive-catalog',
    contractSchema: {
      kind: 'derived-read-only-projection',
      authority: PASSPORT_REGISTRY,
    },
    authority: {
      intake: PASSPORT_REGISTRY,
      rule: 'Definition and admission are derived from passport declarations and rooted evidence. Runtime availability is a separate perspective-bound observation and is never inferred by this catalog.',
    },
    planes: {
      definition:
        'durable identity, classification, lifecycle, semantics, invariants, and typed relations',
      admission:
        'evidence-derived multi-axis qualification with a policy conclusion',
      availability:
        'runtime observation outside this catalog; non-monotonic and perspective-bound',
    },
    facetRoots,
    relationGraph: {
      schema: 'kungfu.primitive-relation-graph/v1',
      authority: 'referenced semantic authorities',
      catalogAuthoredEdges: false,
      relations,
    },
    availabilityPolicy: {
      schema: 'kungfu.primitive-availability-policy/v1',
      states: ['available', 'degraded', 'unavailable', 'unknown'],
      reasonCodes: [
        'healthy',
        'health-degraded',
        'capability-missing',
        'authority-missing',
        'storage-owner-unavailable',
        'observation-missing',
        'observation-stale',
        'binding-mismatch',
      ],
      missingObservationState: 'unknown',
      failClosed: true,
    },
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

export function splitUtf8ForCppLiterals(
  value,
  maxBytes = CPP_LITERAL_MAX_BYTES,
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('C++ literal chunk size must be a positive safe integer');
  }
  const chunks = [];
  let chunk = '';
  let chunkBytes = 0;
  for (const symbol of value) {
    const symbolBytes = Buffer.byteLength(symbol);
    if (symbolBytes > maxBytes) {
      throw new Error('one UTF-8 symbol exceeds the C++ literal chunk size');
    }
    if (chunkBytes > 0 && chunkBytes + symbolBytes > maxBytes) {
      chunks.push(chunk);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += symbol;
    chunkBytes += symbolBytes;
  }
  if (chunk || value.length === 0) chunks.push(chunk);
  return chunks;
}

export function renderHeader(catalog) {
  const payload = JSON.stringify(catalog);
  const chunks = splitUtf8ForCppLiterals(payload);
  const literals = chunks
    .map((chunk) => `    R"KUNGFU_PRIMITIVE(${chunk})KUNGFU_PRIMITIVE"`)
    .join(',\n');
  return `// Generated by scripts/generate-primitive-catalog.mjs. Do not edit.\n// SPDX-License-Identifier: Apache-2.0\n#pragma once\n\n#include <array>\n#include <cstddef>\n#include <string_view>\n\nnamespace kungfu::sdk::generated::primitive_catalog_v2 {\ninline constexpr std::string_view CATALOG_ROOT =\n    "${catalog.catalogRoot}";\ninline constexpr std::array<std::string_view, ${chunks.length}> CATALOG_JSON_CHUNKS = {\n${literals},\n};\ninline constexpr std::size_t CATALOG_JSON_SIZE = ${Buffer.byteLength(payload)};\n\nconsteval auto make_catalog_json() {\n  std::array<char, CATALOG_JSON_SIZE> output{};\n  std::size_t offset = 0;\n  for (const std::string_view chunk : CATALOG_JSON_CHUNKS) {\n    for (const char value : chunk) output[offset++] = value;\n  }\n  return output;\n}\n\ninline constexpr auto CATALOG_JSON_STORAGE = make_catalog_json();\ninline constexpr std::string_view CATALOG_JSON{\n    CATALOG_JSON_STORAGE.data(), CATALOG_JSON_STORAGE.size()};\n} // namespace kungfu::sdk::generated::primitive_catalog_v2\n`;
}

function renderFormatStableHeader(catalog) {
  return renderHeader(catalog)
    .replace(
      '\nnamespace kungfu::sdk::generated::primitive_catalog_v2 {',
      '\n// clang-format off\nnamespace kungfu::sdk::generated::primitive_catalog_v2 {',
    )
    .replace(
      '\n} // namespace kungfu::sdk::generated::primitive_catalog_v2\n',
      '\n} // namespace kungfu::sdk::generated::primitive_catalog_v2\n// clang-format on\n',
    );
}

export function expectedOutputs(root = ROOT) {
  const catalog = buildPrimitiveCatalog(root);
  const json = renderCatalog(catalog);
  return new Map([
    [CATALOG_SOURCE, json],
    [CATALOG_ARTIFACT, json],
    [CATALOG_HEADER, renderFormatStableHeader(catalog)],
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
  if (stale.length)
    throw new Error(`stale generated primitive catalog: ${stale.join(', ')}`);
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
