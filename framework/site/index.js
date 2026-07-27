// SPDX-License-Identifier: Apache-2.0
// @ts-check

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const packageRoot = __dirname;
const siteRoot = path.join(packageRoot, 'dist', 'site');
const bundlePath = path.join(siteRoot, 'site-bundle.json');
const agentIndexPath = path.join(siteRoot, 'agent-index.json');
const adrMapPath = path.join(siteRoot, 'adr-map.json');
const formatManifestPath = path.join(siteRoot, 'format', 'manifest.json');
const formatGuideIndexPath = path.join(
  siteRoot,
  'format',
  'guides',
  'index.json',
);
const schemaPath = path.join(packageRoot, 'schema', 'site-bundle.schema.json');

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

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadBundle() {
  return readJson(bundlePath);
}

function resolveSitePath(relative) {
  if (!relative || path.isAbsolute(relative)) {
    throw new Error(`Invalid Kungfu site bundle path: ${relative}`);
  }
  const resolved = path.resolve(siteRoot, relative);
  if (!resolved.startsWith(`${siteRoot}${path.sep}`)) {
    throw new Error(`Kungfu site bundle path escapes package: ${relative}`);
  }
  return resolved;
}

function loadFormatAuthorityManifest() {
  return readJson(formatManifestPath);
}

function loadFormatAuthorityRoute(routeId) {
  const bundle = loadBundle();
  const descriptor = bundle.formatAuthority?.routes?.[routeId];
  if (!descriptor) {
    throw new Error(`Unknown Kungfu format authority route: ${routeId}`);
  }
  const artifactPath = resolveSitePath(descriptor.path);
  const bytes = fs.readFileSync(artifactPath);
  if (
    sha256(bytes) !== descriptor.artifactRoot ||
    bytes.length !== descriptor.byteLength
  ) {
    throw new Error(`Kungfu format authority route root mismatch: ${routeId}`);
  }
  return {
    descriptor: structuredClone(descriptor),
    value: JSON.parse(bytes.toString('utf8')),
  };
}

function loadFormatGuideIndex() {
  const bundle = loadBundle();
  const descriptor = bundle.formatAuthority?.readerJourney;
  if (!descriptor) throw new Error('Kungfu format reader journey is missing');
  const journeyPath = resolveSitePath(descriptor.path);
  const bytes = fs.readFileSync(journeyPath);
  if (
    sha256(bytes) !== descriptor.contentRoot ||
    bytes.length !== descriptor.byteLength
  ) {
    throw new Error('Kungfu format reader journey root mismatch');
  }
  const value = JSON.parse(bytes.toString('utf8'));
  if (value.schema !== descriptor.schema) {
    throw new Error('Kungfu format reader journey schema mismatch');
  }
  return value;
}

function loadFormatGuide(guideId) {
  const bundle = loadBundle();
  const projected = bundle.formatAuthority?.readerJourney?.guides?.find(
    (guide) => guide.id === guideId,
  );
  if (!projected)
    throw new Error(`Unknown Kungfu format reader guide: ${guideId}`);
  const indexGuide = loadFormatGuideIndex().guides.find(
    (guide) => guide.id === guideId,
  );
  if (
    !indexGuide ||
    `format/${indexGuide.path}` !== projected.path ||
    indexGuide.content_root !== projected.contentRoot ||
    indexGuide.byte_length !== projected.byteLength
  ) {
    throw new Error(`Kungfu format reader guide index drifted: ${guideId}`);
  }
  const guidePath = resolveSitePath(projected.path);
  const bytes = fs.readFileSync(guidePath);
  if (
    sha256(bytes) !== projected.contentRoot ||
    bytes.length !== projected.byteLength
  ) {
    throw new Error(`Kungfu format reader guide root mismatch: ${guideId}`);
  }
  return {
    descriptor: structuredClone(projected),
    body: bytes.toString('utf8'),
  };
}

function verifyBundle() {
  const bundle = loadBundle();
  const { contentRoot: _contentRoot, ...copy } = structuredClone(bundle);
  const contentRoot = sha256(JSON.stringify(canonical(copy)));
  if (contentRoot !== bundle.contentRoot) {
    throw new Error('Kungfu site bundle content root mismatch');
  }
  const adrMapRoot = sha256(fs.readFileSync(adrMapPath));
  if (adrMapRoot !== bundle.adrMap?.contentRoot) {
    throw new Error('Kungfu ADR map content root mismatch');
  }
  const agentIndex = readJson(agentIndexPath);
  if (
    agentIndex.bundleContentRoot !== bundle.contentRoot ||
    agentIndex.sourceRoot !== bundle.sourceRoot
  ) {
    throw new Error('Kungfu agent index is not bound to the site bundle');
  }
  const formatManifestRoot = sha256(fs.readFileSync(formatManifestPath));
  if (formatManifestRoot !== bundle.formatAuthority?.pickup?.manifestRoot) {
    throw new Error('Kungfu format manifest root mismatch');
  }
  const manifest = loadFormatAuthorityManifest();
  if (
    manifest.normative?.root !== bundle.formatAuthority?.normativeRoot ||
    manifest.normative?.status !== bundle.formatAuthority?.status ||
    manifest.package?.name !== bundle.formatAuthority?.package?.name ||
    manifest.package?.version !== bundle.formatAuthority?.package?.version
  ) {
    throw new Error(
      'Kungfu format authority is not bound to the packaged Spec manifest',
    );
  }
  for (const [artifactId, descriptor] of Object.entries(
    manifest.artifacts || {},
  )) {
    const artifactPath = resolveSitePath(`format/${descriptor.path}`);
    const bytes = fs.readFileSync(artifactPath);
    if (
      sha256(bytes) !== descriptor.artifact_root ||
      bytes.length !== descriptor.byte_length
    ) {
      throw new Error(
        `Kungfu packaged Spec artifact root mismatch: ${artifactId}`,
      );
    }
  }
  for (const routeId of Object.keys(bundle.formatAuthority.routes)) {
    loadFormatAuthorityRoute(routeId);
  }
  const vectors = loadFormatAuthorityRoute('vectors').value;
  for (const vector of vectors.vectors || []) {
    const vectorPath = resolveSitePath(
      `format/vectors/${vectors.latest_release}/${vector.path}`,
    );
    const bytes = fs.readFileSync(vectorPath);
    if (
      sha256(bytes) !== vector.byteRoot ||
      bytes.length !== vector.byteLength
    ) {
      throw new Error(`Kungfu retained vector root mismatch: ${vector.id}`);
    }
  }
  if (
    vectors.vectors?.length !==
      bundle.formatAuthority.conformance.vectorCount ||
    vectors.latest_release_root !==
      bundle.formatAuthority.conformance.releaseRoot
  ) {
    throw new Error('Kungfu retained vector conformance summary mismatch');
  }
  const journey = loadFormatGuideIndex();
  const guideIds = new Set(journey.guides.map((guide) => guide.id));
  const levelGuideIds = journey.levels.flatMap((level) => level.guide_ids);
  if (
    guideIds.size !== journey.guides.length ||
    levelGuideIds.length !== journey.guides.length ||
    new Set(levelGuideIds).size !== journey.guides.length ||
    levelGuideIds.some((guideId) => !guideIds.has(guideId))
  ) {
    throw new Error('Kungfu format reader journey coverage mismatch');
  }
  for (const guideId of guideIds) loadFormatGuide(guideId);
  return {
    status: 'passing',
    package: bundle.package,
    sourceRevision: bundle.source.revision,
    sourceRoot: bundle.sourceRoot,
    contentRoot: bundle.contentRoot,
    surfaces: bundle.surfaces.length,
    sources: bundle.sources.length,
    format: {
      manifestRoot: formatManifestRoot,
      normativeRoot: bundle.formatAuthority.normativeRoot,
      specVersion: bundle.formatAuthority.specVersion,
      status: bundle.formatAuthority.status,
      conformance: structuredClone(bundle.formatAuthority.conformance),
      readerGuides: journey.guides.length,
    },
  };
}

function renderPageModels() {
  verifyBundle();
  const bundle = loadBundle();
  const sourceById = new Map(
    bundle.sources.map((source) => [source.id, source]),
  );
  const navigation = bundle.surfaces.map(({ id, label, route }) => ({
    id,
    label,
    route,
  }));
  return bundle.surfaces.map((surface) => {
    const model = {
      contract: 'kungfu.site-page-model/v1',
      id: surface.id,
      route: surface.route,
      label: surface.label,
      headline: surface.headline,
      summary: surface.summary,
      claimClass: surface.claimClass,
      maturity: surface.maturity,
      capabilities: structuredClone(surface.capabilities),
      knownLimits: structuredClone(surface.knownLimits),
      authorities: surface.sourceIds.map((sourceId) => {
        const source = sourceById.get(sourceId);
        if (!source)
          throw new Error(
            `Kungfu site page references unknown source: ${sourceId}`,
          );
        return {
          id: source.id,
          role: source.role,
          path: source.path,
          contentRoot: source.contentRoot,
          url: source.url,
        };
      }),
      navigation: structuredClone(navigation),
      bundle: {
        package: structuredClone(bundle.package),
        sourceRevision: bundle.source.revision,
        sourceRoot: bundle.sourceRoot,
        contentRoot: bundle.contentRoot,
      },
    };
    if (surface.id === 'overview')
      model.positioning = structuredClone(bundle.positioning);
    if (surface.id === 'format')
      model.formatAuthority = structuredClone(bundle.formatAuthority);
    if (surface.id === 'decisions')
      model.adrMap = structuredClone(bundle.adrMap);
    model.contentRoot = sha256(JSON.stringify(canonical(model)));
    return model;
  });
}

function renderPageModel(routeOrId) {
  const page = renderPageModels().find(
    (candidate) => candidate.route === routeOrId || candidate.id === routeOrId,
  );
  if (!page) throw new Error(`Unknown Kungfu site page: ${routeOrId}`);
  return page;
}

function renderFormatGuideModels() {
  verifyBundle();
  const bundle = loadBundle();
  const journey = loadFormatGuideIndex();
  return journey.guides.map((guide) => {
    const loaded = loadFormatGuide(guide.id);
    const model = {
      contract: 'kungfu.site-format-guide-model/v1',
      id: guide.id,
      level: guide.level,
      order: guide.order,
      title: guide.title,
      summary: guide.summary,
      body: loaded.body,
      navigation: {
        previous: guide.previous,
        next: guide.next,
        related: structuredClone(guide.related),
      },
      journey: {
        title: journey.title,
        summary: journey.summary,
        levels: structuredClone(journey.levels),
      },
      bundle: {
        package: structuredClone(bundle.package),
        sourceRevision: bundle.source.revision,
        contentRoot: bundle.contentRoot,
        specPackage: structuredClone(bundle.formatAuthority.package),
        normativeRoot: bundle.formatAuthority.normativeRoot,
      },
    };
    model.contentRoot = sha256(JSON.stringify(canonical(model)));
    return model;
  });
}

function renderFormatGuideModel(guideId) {
  const guide = renderFormatGuideModels().find(
    (candidate) => candidate.id === guideId,
  );
  if (!guide) throw new Error(`Unknown Kungfu format reader guide: ${guideId}`);
  return guide;
}

module.exports = {
  adrMapPath,
  agentIndexPath,
  bundlePath,
  formatGuideIndexPath,
  formatManifestPath,
  loadBundle,
  loadFormatAuthorityManifest,
  loadFormatAuthorityRoute,
  loadFormatGuide,
  loadFormatGuideIndex,
  renderFormatGuideModel,
  renderFormatGuideModels,
  renderPageModel,
  renderPageModels,
  schemaPath,
  siteRoot,
  verifyBundle,
};
