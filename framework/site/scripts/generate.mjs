#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  ADR_MAP_PATH,
  AGENT_INDEX_PATH,
  BUNDLE_PATH,
  DIST_ROOT,
  PACKAGE_ROOT,
  REPO_ROOT,
  SOURCE_PATH,
  assertRelativeSourcePath,
  canonicalJson,
  fileRoot,
  internalContentRoot,
  readJson,
  sha256,
  writeJson,
} from './lib.mjs';

const MATURITIES = new Set([
  'coming-soon',
  'implemented',
  'qualified',
  'staged',
  'qualified-shadow',
  'pre-normative',
  'historical-proof',
  'current-focus',
  'future-derivative',
  'not-claimed',
]);
const CLAIM_CLASSES = new Set([
  'product-framing',
  'current-contract',
  'implemented-source',
  'qualified-source',
  'pre-normative',
  'historical-proof',
  'future-horizon',
  'not-claimed',
]);
const SOURCE_ROLES = new Set([
  'semantic-authority',
  'machine-contract',
  'qualification-evidence',
  'navigation-projection',
  'release-policy',
  'product-framing',
]);
const REPOSITORY = 'https://github.com/kungfu-systems/kungfu';

function git(...args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
}

function assertUnique(items, field, label) {
  const values = items.map((item) => item[field]);
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicate ${field}`);
  }
}

function validateSourceDeclaration(source) {
  if (source.contract !== 'kungfu.site-bundle-source/v1') {
    throw new Error('unexpected site bundle source contract');
  }
  assertUnique(source.sources, 'id', 'sources');
  assertUnique(source.surfaces, 'id', 'surfaces');
  assertUnique(source.surfaces, 'route', 'surfaces');
  assertUnique(source.adoptionLayers, 'id', 'adoptionLayers');
  const sourceIds = new Set(source.sources.map((entry) => entry.id));
  for (const entry of source.sources) {
    if (!SOURCE_ROLES.has(entry.role)) {
      throw new Error(`source ${entry.id} has invalid role ${entry.role}`);
    }
    assertRelativeSourcePath(entry.path);
  }
  for (const [kind, entries] of [
    ['surface', source.surfaces],
    ['adoption layer', source.adoptionLayers],
  ]) {
    for (const entry of entries) {
      if (!MATURITIES.has(entry.maturity)) {
        throw new Error(
          `${kind} ${entry.id} has invalid maturity ${entry.maturity}`,
        );
      }
      if (kind === 'surface' && !CLAIM_CLASSES.has(entry.claimClass)) {
        throw new Error(
          `${kind} ${entry.id} has invalid claim class ${entry.claimClass}`,
        );
      }
      if (!entry.sourceIds?.length) {
        throw new Error(`${kind} ${entry.id} has no sourceIds`);
      }
      for (const sourceId of entry.sourceIds) {
        if (!sourceIds.has(sourceId)) {
          throw new Error(
            `${kind} ${entry.id} references unknown source ${sourceId}`,
          );
        }
      }
    }
  }
  for (const sourceId of source.positioning.sourceIds || []) {
    if (!sourceIds.has(sourceId)) {
      throw new Error(`positioning references unknown source ${sourceId}`);
    }
  }
}

function main() {
  const source = readJson(SOURCE_PATH);
  const pkg = readJson(path.join(PACKAGE_ROOT, 'package.json'));
  validateSourceDeclaration(source);
  const revision =
    process.env.KUNGFU_SITE_SOURCE_REVISION || git('rev-parse', 'HEAD');
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error(
      `source revision must be a 40-character Git SHA: ${revision}`,
    );
  }
  const treeDirty = git('status', '--porcelain=v1').length > 0;
  const sources = source.sources.map((entry) => {
    const absolute = assertRelativeSourcePath(entry.path);
    return {
      ...entry,
      contentRoot: fileRoot(absolute),
      url: `${REPOSITORY}/blob/${revision}/${entry.path}`,
    };
  });
  const sourceRoot = sha256(
    canonicalJson(
      sources.map(({ id, path: sourcePath, role, contentRoot }) => ({
        id,
        path: sourcePath,
        role,
        contentRoot,
      })),
    ),
  );
  const adrSource = sources.find((entry) => entry.id === 'adr-map');
  if (!adrSource) throw new Error('adr-map source is required');
  const adrMap = readJson(path.resolve(REPO_ROOT, adrSource.path));
  if (adrMap.schema !== 'kungfu.adr-navigation-projection/v1') {
    throw new Error('unexpected ADR navigation projection contract');
  }
  fs.rmSync(DIST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(DIST_ROOT, { recursive: true });
  writeJson(ADR_MAP_PATH, adrMap);
  const bundle = {
    contract: 'kungfu.site-bundle/v1',
    schemaVersion: 1,
    package: {
      name: pkg.name,
      version: pkg.version,
    },
    source: {
      repository: REPOSITORY,
      revision,
      treeDirty,
      authorityPolicy:
        'composition-only; exact upstream paths and content roots remain authoritative',
      reproducible: true,
    },
    sourceRoot,
    positioning: Object.fromEntries(
      Object.entries(source.positioning).filter(([key]) => key !== 'sourceIds'),
    ),
    adoptionLayers: source.adoptionLayers,
    surfaces: source.surfaces,
    sources,
    adrMap: {
      contract: adrMap.schema,
      path: 'adr-map.json',
      contentRoot: fileRoot(ADR_MAP_PATH),
      summary: adrMap.summary,
      authorityBoundary:
        'Only ADR-frontmatter relations are authoritative; domains and nearby links are deterministic navigation-only projections.',
    },
    machineEntries: {
      bundle: 'site-bundle.json',
      agentIndex: 'agent-index.json',
      adrMap: 'adr-map.json',
      schema: 'schema/site-bundle.schema.json',
    },
    nonClaims: source.nonClaims,
  };
  bundle.contentRoot = internalContentRoot(bundle);
  writeJson(BUNDLE_PATH, bundle);
  const sourceById = new Map(sources.map((entry) => [entry.id, entry]));
  const agentIndex = {
    contract: 'kungfu.site-agent-index/v1',
    package: bundle.package,
    sourceRevision: revision,
    sourceRoot,
    bundleContentRoot: bundle.contentRoot,
    promise: bundle.positioning.promise,
    firstReleaseOutcome: bundle.positioning.firstReleaseOutcome,
    readingOrder: bundle.surfaces.map((surface) => ({
      id: surface.id,
      route: surface.route,
      headline: surface.headline,
      claimClass: surface.claimClass,
      maturity: surface.maturity,
      knownLimits: surface.knownLimits,
      authorities: surface.sourceIds.map((id) => {
        const authority = sourceById.get(id);
        return {
          id,
          role: authority.role,
          path: authority.path,
          contentRoot: authority.contentRoot,
          url: authority.url,
        };
      }),
    })),
    nonClaims: bundle.nonClaims,
    machineEntries: bundle.machineEntries,
  };
  writeJson(AGENT_INDEX_PATH, agentIndex);
  console.log(
    `[site:generate] ${bundle.surfaces.length} surfaces, ${sources.length} exact sources, contentRoot=${bundle.contentRoot}`,
  );
}

main();
