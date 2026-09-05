#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const DECLARATION_PATH = path.join(
  PACKAGE_ROOT,
  'src',
  'kfx-site-bundle.source.json',
);
const SCHEMA_PATH = path.join(
  PACKAGE_ROOT,
  'schema',
  'kfx-site-bundle.schema.json',
);
const OUTPUT_ROOT = path.join(PACKAGE_ROOT, 'dist', 'site', 'kfx');
const REPOSITORY = 'https://github.com/kungfu-systems/kungfu';
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const STATUSES = new Set([
  'accepted',
  'experimental',
  'implemented',
  'qualified',
  'staged',
]);
const ARTIFACT_PATHS = Object.freeze({
  bundle: 'site-bundle.json',
  agentIndex: 'agent-index.json',
  humanIndex: 'human-index.json',
  sourceManifest: 'source-manifest.json',
  schema: 'schema/kfx-site-bundle.schema.json',
  manifest: 'manifest.json',
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function rooted(value, field = 'contentRoot') {
  const copy = structuredClone(value);
  delete copy[field];
  return { ...value, [field]: sha256(canonicalJson(copy)) };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertUnique(values, label) {
  assert(
    new Set(values).size === values.length,
    `${label} contains duplicates`,
  );
}

function assertRelativeSourcePath(sourcePath) {
  assert(
    typeof sourcePath === 'string' &&
      /^(?:(?:docs|framework|extensions)\/|product\/release\/npm-package-registry\.json$)/u.test(
        sourcePath,
      ) &&
      !path.isAbsolute(sourcePath) &&
      !sourcePath.split(/[\\/]/u).includes('..') &&
      !sourcePath.startsWith('framework/site/'),
    `invalid or self-authorizing KFX source path: ${sourcePath}`,
  );
  return sourcePath;
}

function assertRevision(revision, expectedRevision) {
  assert(
    REVISION_PATTERN.test(revision),
    `KFX source revision must be an immutable 40-character Git commit: ${revision}`,
  );
  assert(
    !expectedRevision || revision === expectedRevision,
    `KFX source revision is stale: expected ${expectedRevision}, got ${revision}`,
  );
}

function validateDeclaration(declaration) {
  assert(
    declaration?.contract === 'kungfu.kfx-site-bundle-source/v1',
    'unexpected KFX Site Bundle source contract',
  );
  assert(
    declaration.maturity === 'pre-release',
    'KFX Site Bundle declaration maturity must remain pre-release',
  );
  assert(Array.isArray(declaration.sources), 'KFX sources must be an array');
  assert(Array.isArray(declaration.facets), 'KFX facets must be an array');
  assert(declaration.sources.length > 0, 'KFX sources must not be empty');
  assert(declaration.facets.length > 0, 'KFX facets must not be empty');

  const sourceIds = declaration.sources.map(({ id }) => id);
  const sourcePaths = declaration.sources.map(({ path: sourcePath }) =>
    assertRelativeSourcePath(sourcePath),
  );
  const facetIds = declaration.facets.map(({ id }) => id);
  assertUnique(sourceIds, 'KFX source ids');
  assertUnique(sourcePaths, 'KFX source paths');
  assertUnique(facetIds, 'KFX facet ids');
  const sourceIdSet = new Set(sourceIds);

  for (const source of declaration.sources) {
    assert(source.id && source.role, 'KFX source id and role are required');
    assert(
      source.maturity === declaration.maturity,
      `conflicting maturity for KFX source ${source.id}`,
    );
    assert(
      STATUSES.has(source.status),
      `unsupported KFX source status for ${source.id}: ${source.status}`,
    );
    assert(source.nonClaim, `KFX source ${source.id} requires a non-claim`);
  }
  for (const facet of declaration.facets) {
    assert(
      facet.id && facet.title && facet.summary,
      'KFX facet copy is required',
    );
    assert(
      facet.maturity === declaration.maturity,
      `conflicting maturity for KFX facet ${facet.id}`,
    );
    assert(
      STATUSES.has(facet.status),
      `unsupported KFX facet status for ${facet.id}: ${facet.status}`,
    );
    assert(facet.nonClaim, `KFX facet ${facet.id} requires a non-claim`);
    assert(
      Array.isArray(facet.sourceIds) && facet.sourceIds.length > 0,
      `KFX facet ${facet.id} requires source bindings`,
    );
    assertUnique(facet.sourceIds, `KFX facet ${facet.id} source bindings`);
    for (const sourceId of facet.sourceIds) {
      assert(
        sourceIdSet.has(sourceId),
        `KFX facet ${facet.id} references unknown source ${sourceId}`,
      );
    }
  }

  for (const [audience, readingOrder] of [
    ['human', declaration.humanReadingOrder],
    ['Agent', declaration.agentReadingOrder],
  ]) {
    assert(Array.isArray(readingOrder), `${audience} reading order is missing`);
    assertUnique(readingOrder, `${audience} reading order`);
    assert(
      JSON.stringify(readingOrder) === JSON.stringify(facetIds),
      `${audience} reading order diverges from the declared facet order`,
    );
  }
  assert(
    JSON.stringify(declaration.humanReadingOrder) ===
      JSON.stringify(declaration.agentReadingOrder),
    'human and Agent reading orders diverge',
  );
  assert(
    Array.isArray(declaration.nonClaims) && declaration.nonClaims.length > 0,
    'KFX Site Bundle global non-claims are missing',
  );
}

function projectSources(declaration, revision, sourceLoader) {
  return declaration.sources.map((source) => {
    const bytes = Buffer.from(sourceLoader(source.path));
    assert(bytes.length > 0, `declared KFX source is empty: ${source.path}`);
    return {
      id: source.id,
      role: source.role,
      maturity: source.maturity,
      status: source.status,
      path: source.path,
      revision,
      coordinate: `${REPOSITORY}/blob/${revision}/${source.path}`,
      contentRoot: sha256(bytes),
      byteLength: bytes.length,
      nonClaim: source.nonClaim,
    };
  });
}

function sourceSetRoot(sources) {
  return sha256(
    canonicalJson(
      sources.map(
        ({
          id,
          role,
          maturity,
          status,
          path: sourcePath,
          revision,
          contentRoot,
          byteLength,
          nonClaim,
        }) => ({
          id,
          role,
          maturity,
          status,
          path: sourcePath,
          revision,
          contentRoot,
          byteLength,
          nonClaim,
        }),
      ),
    ),
  );
}

function readingIndex(contract, audience, declaration, facets, binding) {
  return rooted({
    contract,
    audience,
    sourceRevision: binding.revision,
    sourceRoot: binding.sourceRoot,
    bundleContentRoot: binding.bundleContentRoot,
    readingOrder: declaration[`${audience}ReadingOrder`].map((id) => {
      const facet = facets.find((candidate) => candidate.id === id);
      return {
        id: facet.id,
        title: facet.title,
        summary: facet.summary,
        maturity: facet.maturity,
        status: facet.status,
        nonClaim: facet.nonClaim,
        sourceIds: facet.authorities.map(({ id: sourceId }) => sourceId),
      };
    }),
    nonClaims: declaration.nonClaims,
  });
}

export function compileKfxSiteBundle({
  declaration,
  schema,
  packageVersion,
  revision,
  expectedRevision = revision,
  sourceLoader,
}) {
  validateDeclaration(declaration);
  assertRevision(revision, expectedRevision);
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: false,
  });
  const validateSchema = ajv.compile(schema);
  const sources = projectSources(declaration, revision, sourceLoader);
  const sourceRoot = sourceSetRoot(sources);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const facets = declaration.facets.map((facet) => ({
    id: facet.id,
    title: facet.title,
    summary: facet.summary,
    maturity: facet.maturity,
    status: facet.status,
    nonClaim: facet.nonClaim,
    authorities: facet.sourceIds.map((sourceId) =>
      structuredClone(sourceById.get(sourceId)),
    ),
  }));
  const bundle = rooted({
    contract: 'kungfu.kfx-site-bundle/v1',
    schemaVersion: 1,
    package: { name: '@kungfu-tech/site', version: packageVersion },
    source: {
      repository: REPOSITORY,
      revision,
      coordinatePolicy: 'exact-git-commit-and-path/v1',
      rootProtocol: 'sha256:opaque-bytes/v1',
      authorityBoundary:
        'Tracked KFX, KFD, Work, Warrant, capability, lifecycle, and Release Passport sources retain semantic and runtime authority.',
    },
    sourceRoot,
    value: declaration.value,
    facets,
    humanReadingOrder: declaration.humanReadingOrder,
    agentReadingOrder: declaration.agentReadingOrder,
    sources,
    artifacts: ARTIFACT_PATHS,
    nonClaims: declaration.nonClaims,
  });
  assert(
    validateSchema(bundle),
    `KFX Site Bundle schema mismatch: ${ajv.errorsText(validateSchema.errors, { separator: '; ' })}`,
  );

  const sourceManifest = rooted({
    contract: 'kungfu.kfx-site-source-manifest/v1',
    repository: REPOSITORY,
    revision,
    coordinatePolicy: 'exact-git-commit-and-path/v1',
    rootProtocol: 'sha256:opaque-bytes/v1',
    sourceRoot,
    sources,
  });
  const binding = {
    revision,
    sourceRoot,
    bundleContentRoot: bundle.contentRoot,
  };
  const agentIndex = readingIndex(
    'kungfu.kfx-site-agent-index/v1',
    'agent',
    declaration,
    facets,
    binding,
  );
  const humanIndex = readingIndex(
    'kungfu.kfx-site-human-index/v1',
    'human',
    declaration,
    facets,
    binding,
  );
  const schemaBytes = jsonBytes(schema);
  const artifactValues = {
    [ARTIFACT_PATHS.bundle]: bundle,
    [ARTIFACT_PATHS.agentIndex]: agentIndex,
    [ARTIFACT_PATHS.humanIndex]: humanIndex,
    [ARTIFACT_PATHS.sourceManifest]: sourceManifest,
  };
  const artifactBytes = Object.fromEntries(
    Object.entries(artifactValues).map(([artifactPath, value]) => [
      artifactPath,
      jsonBytes(value),
    ]),
  );
  artifactBytes[ARTIFACT_PATHS.schema] = schemaBytes;
  const manifest = rooted({
    contract: 'kungfu.kfx-site-artifact-manifest/v1',
    sourceRevision: revision,
    sourceRoot,
    bundleContentRoot: bundle.contentRoot,
    artifacts: Object.entries(artifactBytes).map(([artifactPath, bytes]) => ({
      path: artifactPath,
      contentRoot: sha256(bytes),
      byteLength: bytes.length,
    })),
    nonClaims: declaration.nonClaims,
  });
  artifactValues[ARTIFACT_PATHS.manifest] = manifest;
  artifactBytes[ARTIFACT_PATHS.manifest] = jsonBytes(manifest);
  return { artifactBytes, artifactValues };
}

function readArtifact(outputRoot, relative) {
  const target = path.resolve(outputRoot, relative);
  assert(
    target.startsWith(`${path.resolve(outputRoot)}${path.sep}`),
    `KFX artifact path escapes output root: ${relative}`,
  );
  assert(
    fs.existsSync(target),
    `missing KFX Site Bundle artifact: ${relative}`,
  );
  return fs.readFileSync(target);
}

export function verifyKfxSiteBundle({
  outputRoot,
  declaration,
  schema,
  revision,
  expectedRevision = revision,
  sourceLoader,
}) {
  validateDeclaration(declaration);
  assertRevision(revision, expectedRevision);
  const bundle = JSON.parse(readArtifact(outputRoot, ARTIFACT_PATHS.bundle));
  const agentIndex = JSON.parse(
    readArtifact(outputRoot, ARTIFACT_PATHS.agentIndex),
  );
  const humanIndex = JSON.parse(
    readArtifact(outputRoot, ARTIFACT_PATHS.humanIndex),
  );
  const sourceManifest = JSON.parse(
    readArtifact(outputRoot, ARTIFACT_PATHS.sourceManifest),
  );
  const manifest = JSON.parse(
    readArtifact(outputRoot, ARTIFACT_PATHS.manifest),
  );
  const projectedSchemaBytes = readArtifact(outputRoot, ARTIFACT_PATHS.schema);
  assert(
    projectedSchemaBytes.equals(jsonBytes(schema)),
    'KFX schema projection drifted',
  );

  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: false,
  });
  const validateSchema = ajv.compile(schema);
  assert(
    validateSchema(bundle),
    `KFX Site Bundle schema mismatch: ${ajv.errorsText(validateSchema.errors, { separator: '; ' })}`,
  );
  assert(
    rooted(bundle).contentRoot === bundle.contentRoot,
    'KFX bundle content root mismatch',
  );
  assert(
    rooted(agentIndex).contentRoot === agentIndex.contentRoot,
    'KFX Agent index content root mismatch',
  );
  assert(
    rooted(humanIndex).contentRoot === humanIndex.contentRoot,
    'KFX human index content root mismatch',
  );
  assert(
    rooted(sourceManifest).contentRoot === sourceManifest.contentRoot,
    'KFX source manifest content root mismatch',
  );
  assert(
    rooted(manifest).contentRoot === manifest.contentRoot,
    'KFX artifact manifest content root mismatch',
  );

  const sources = projectSources(declaration, revision, sourceLoader);
  const sourceRoot = sourceSetRoot(sources);
  assert(sourceRoot === bundle.sourceRoot, 'KFX bundle source root mismatch');
  assert(
    sourceRoot === sourceManifest.sourceRoot,
    'KFX source manifest root mismatch',
  );
  assert(
    JSON.stringify(sources) === JSON.stringify(bundle.sources) &&
      JSON.stringify(sources) === JSON.stringify(sourceManifest.sources),
    'KFX projected source order or content drifted',
  );
  assert(
    bundle.source.revision === revision &&
      sourceManifest.revision === revision &&
      manifest.sourceRevision === revision,
    'KFX source revision binding drifted',
  );
  assert(
    agentIndex.bundleContentRoot === bundle.contentRoot &&
      humanIndex.bundleContentRoot === bundle.contentRoot &&
      manifest.bundleContentRoot === bundle.contentRoot,
    'KFX indexes or manifest are not bound to the exact bundle',
  );
  assert(
    agentIndex.sourceRoot === sourceRoot &&
      humanIndex.sourceRoot === sourceRoot &&
      manifest.sourceRoot === sourceRoot,
    'KFX indexes or manifest are not bound to the exact source set',
  );
  const facetIds = bundle.facets.map(({ id }) => id);
  const humanOrder = humanIndex.readingOrder.map(({ id }) => id);
  const agentOrder = agentIndex.readingOrder.map(({ id }) => id);
  assert(
    JSON.stringify(facetIds) === JSON.stringify(bundle.humanReadingOrder) &&
      JSON.stringify(facetIds) === JSON.stringify(bundle.agentReadingOrder) &&
      JSON.stringify(facetIds) === JSON.stringify(humanOrder) &&
      JSON.stringify(facetIds) === JSON.stringify(agentOrder),
    'KFX human and Agent reading-order parity drifted',
  );
  for (const descriptor of manifest.artifacts) {
    const bytes = readArtifact(outputRoot, descriptor.path);
    assert(
      sha256(bytes) === descriptor.contentRoot &&
        bytes.length === descriptor.byteLength,
      `KFX artifact content drifted: ${descriptor.path}`,
    );
  }
  return {
    status: 'passing',
    revision,
    sourceRoot,
    contentRoot: bundle.contentRoot,
    sources: sources.length,
    facets: facetIds.length,
    artifacts: manifest.artifacts.length + 1,
  };
}

function git(repoRoot, ...args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function repositorySourceLoader(repoRoot, revision) {
  return (sourcePath) => {
    const absolute = path.resolve(
      repoRoot,
      assertRelativeSourcePath(sourcePath),
    );
    assert(
      absolute.startsWith(`${path.resolve(repoRoot)}${path.sep}`) &&
        fs.existsSync(absolute),
      `declared KFX source is missing: ${sourcePath}`,
    );
    const workingBytes = fs.readFileSync(absolute);
    let committedBytes;
    try {
      committedBytes = execFileSync(
        'git',
        ['show', `${revision}:${sourcePath}`],
        {
          cwd: repoRoot,
          encoding: 'buffer',
          maxBuffer: 64 * 1024 * 1024,
        },
      );
    } catch {
      throw new Error(
        `KFX source is absent from exact revision: ${sourcePath}`,
      );
    }
    assert(
      workingBytes.equals(committedBytes),
      `KFX source content is dirty or stale at ${sourcePath}`,
    );
    return workingBytes;
  };
}

function assertControlFileAtRevision(repoRoot, revision, absolute) {
  const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
  const committed = execFileSync('git', ['show', `${revision}:${relative}`], {
    cwd: repoRoot,
    encoding: 'buffer',
  });
  assert(
    fs.readFileSync(absolute).equals(committed),
    `KFX bundle control file is dirty or stale: ${relative}`,
  );
}

function loadInputs() {
  return {
    declaration: JSON.parse(fs.readFileSync(DECLARATION_PATH, 'utf8')),
    schema: JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')),
    packageVersion: JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ).version,
  };
}

function writeArtifacts(outputRoot, artifactBytes) {
  fs.rmSync(outputRoot, { recursive: true, force: true });
  for (const [relative, bytes] of Object.entries(artifactBytes)) {
    const target = path.join(outputRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
}

function main() {
  const command = process.argv[2];
  assert(
    command === 'generate' || command === 'verify',
    'usage: node framework/site/scripts/kfx-site-bundle.mjs <generate|verify>',
  );
  const revision = git(REPO_ROOT, 'rev-parse', 'HEAD');
  assertRevision(revision, revision);
  assertControlFileAtRevision(REPO_ROOT, revision, DECLARATION_PATH);
  assertControlFileAtRevision(REPO_ROOT, revision, SCHEMA_PATH);
  const input = loadInputs();
  const sourceLoader = repositorySourceLoader(REPO_ROOT, revision);
  if (command === 'generate') {
    const compiled = compileKfxSiteBundle({
      ...input,
      revision,
      expectedRevision: revision,
      sourceLoader,
    });
    writeArtifacts(OUTPUT_ROOT, compiled.artifactBytes);
  }
  const receipt = verifyKfxSiteBundle({
    outputRoot: OUTPUT_ROOT,
    declaration: input.declaration,
    schema: input.schema,
    revision,
    expectedRevision: revision,
    sourceLoader,
  });
  console.log(
    `[site:kfx:${command}] ${receipt.status}; revision=${receipt.revision}; sources=${receipt.sources}; facets=${receipt.facets}; sourceRoot=${receipt.sourceRoot}; contentRoot=${receipt.contentRoot}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) main();

export { ARTIFACT_PATHS, OUTPUT_ROOT, canonicalJson, jsonBytes, sha256 };
