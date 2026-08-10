// SPDX-License-Identifier: Apache-2.0
// @ts-check

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  createSiteExperience,
  verifySiteExperience: verifyExperience,
} = require('./experience.js');

const packageRoot = __dirname;
const siteRoot = path.join(packageRoot, 'dist', 'site');
const bundlePath = path.join(siteRoot, 'site-bundle.json');
const agentIndexPath = path.join(siteRoot, 'agent-index.json');
const kfxSiteRoot = path.join(siteRoot, 'kfx');
const kfxSiteBundlePath = path.join(kfxSiteRoot, 'site-bundle.json');
const kfxSiteManifestPath = path.join(kfxSiteRoot, 'manifest.json');
const adrMapPath = path.join(siteRoot, 'adr-map.json');
const formatManifestPath = path.join(siteRoot, 'format', 'manifest.json');
const formatGuideIndexPath = path.join(
  siteRoot,
  'format',
  'guides',
  'index.json',
);
const schemaPath = path.join(packageRoot, 'schema', 'site-bundle.schema.json');
const experienceSchemaPath = path.join(
  packageRoot,
  'schema',
  'site-experience-config.schema.json',
);

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

function loadKfxSiteBundle() {
  return readJson(kfxSiteBundlePath);
}

function verifyKfxSiteBundle() {
  const bundle = loadKfxSiteBundle();
  const manifest = readJson(kfxSiteManifestPath);
  const { contentRoot: _bundleRoot, ...bundlePreimage } = bundle;
  const { contentRoot: _manifestRoot, ...manifestPreimage } = manifest;
  if (
    sha256(JSON.stringify(canonical(bundlePreimage))) !== bundle.contentRoot
  ) {
    throw new Error('Kungfu KFX Site Bundle content root mismatch');
  }
  if (
    sha256(JSON.stringify(canonical(manifestPreimage))) !== manifest.contentRoot
  ) {
    throw new Error('Kungfu KFX Site Bundle manifest root mismatch');
  }
  const facetOrder = bundle.facets.map(({ id }) => id);
  if (
    JSON.stringify(facetOrder) !== JSON.stringify(bundle.humanReadingOrder) ||
    JSON.stringify(facetOrder) !== JSON.stringify(bundle.agentReadingOrder)
  ) {
    throw new Error('Kungfu KFX Site Bundle reading-order parity mismatch');
  }
  for (const descriptor of manifest.artifacts) {
    const artifact = resolveKfxSitePath(descriptor.path);
    const bytes = fs.readFileSync(artifact);
    if (
      sha256(bytes) !== descriptor.contentRoot ||
      bytes.length !== descriptor.byteLength
    ) {
      throw new Error(
        `Kungfu KFX Site Bundle artifact root mismatch: ${descriptor.path}`,
      );
    }
  }
  return {
    status: 'passing',
    revision: bundle.source.revision,
    sourceRoot: bundle.sourceRoot,
    contentRoot: bundle.contentRoot,
    facets: bundle.facets.length,
    sources: bundle.sources.length,
  };
}

function resolveKfxSitePath(relative) {
  if (!relative || path.isAbsolute(relative)) {
    throw new Error(`Invalid Kungfu KFX Site Bundle path: ${relative}`);
  }
  const resolved = path.resolve(kfxSiteRoot, relative);
  if (!resolved.startsWith(`${kfxSiteRoot}${path.sep}`)) {
    throw new Error(`Kungfu KFX Site Bundle path escapes package: ${relative}`);
  }
  return resolved;
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

function markdownTitle(body) {
  const match = String(body).match(/^#\s+(.+)$/mu);
  if (!match) throw new Error('Kungfu format document has no title');
  return match[1].replaceAll('`', '');
}

function markdownSummary(body) {
  const paragraphs = String(body)
    .replace(/\r\n?/gu, '\n')
    .split(/\n\s*\n/u)
    .map((paragraph) =>
      paragraph
        .split('\n')
        .map((line) => line.replace(/^>\s?/u, '').trim())
        .join(' ')
        .trim(),
    )
    .filter(
      (paragraph) =>
        paragraph &&
        !paragraph.startsWith('#') &&
        !paragraph.startsWith('```') &&
        !paragraph.startsWith('- ') &&
        !paragraph.startsWith('|'),
    );
  return (
    paragraphs[0] ||
    'Read the exact packaged document and its declared evidence boundary.'
  )
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/[*_`]/gu, '');
}

function humanRouteForFormatMarkdown(relative) {
  if (!relative.startsWith('format/') || !relative.endsWith('.md')) {
    throw new Error(`Invalid Kungfu format Markdown route: ${relative}`);
  }
  const withoutExtension = relative.slice(0, -3);
  const route = withoutExtension.endsWith('/index')
    ? withoutExtension.slice(0, -5)
    : `${withoutExtension}/`;
  return `/${route.replace(/^\/+/u, '')}`;
}

function formatDocumentLinkMap(rawPath, documents, bundle) {
  const routeByRawPath = new Map(
    documents.map((document) => [
      document.source.route.replace(/^\//u, ''),
      document.route,
    ]),
  );
  const sourceUrlByPath = new Map(
    bundle.sources.map((source) => [source.path, source.url]),
  );
  const body = fs.readFileSync(resolveSitePath(rawPath), 'utf8');
  const hrefs = [
    ...body.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu),
  ].map((match) => match[1]);
  const linkMap = {};
  for (const href of hrefs) {
    if (
      href.startsWith('/') ||
      href.startsWith('#') ||
      /^https?:\/\//u.test(href)
    ) {
      continue;
    }
    const [target, fragment = ''] = href.split('#', 2);
    const directTarget = path.posix.normalize(
      path.posix.join(path.posix.dirname(rawPath), target),
    );
    const specSourceTarget = path.posix.normalize(
      path.posix.join(
        path.posix.dirname(
          path.posix.join(
            'framework/spec/dist',
            rawPath.replace(/^format\//u, ''),
          ),
        ),
        target,
      ),
    );
    const documentRoute = routeByRawPath.get(directTarget);
    const repositoryTarget = [directTarget, specSourceTarget].find(
      (candidate) =>
        /^(?:docs|tests|framework|crates)\//u.test(candidate) &&
        !candidate.includes('../'),
    );
    const resolved =
      documentRoute ||
      sourceUrlByPath.get(directTarget) ||
      sourceUrlByPath.get(specSourceTarget) ||
      (repositoryTarget
        ? `${bundle.source.repository}/blob/${bundle.source.revision}/${repositoryTarget}`
        : null);
    if (resolved) {
      linkMap[href] = `${resolved}${fragment ? `#${fragment}` : ''}`;
    }
  }
  return linkMap;
}

function readFormatDocumentDescriptor(rawPath, fields = {}) {
  const bytes = fs.readFileSync(resolveSitePath(rawPath));
  const body = bytes.toString('utf8');
  return {
    id: fields.id,
    label: fields.label || markdownTitle(body),
    route: humanRouteForFormatMarkdown(rawPath),
    summary: fields.summary || markdownSummary(body),
    body,
    claimClass: fields.claimClass || 'format-documentation',
    maturity: fields.maturity || 'non-normative-guide',
    topicIds: ['format'],
    source: {
      route: `/${rawPath}`,
      contentRoot: sha256(bytes),
      byteLength: bytes.length,
    },
    navigation: fields.navigation || {},
    linkMap: {},
  };
}

function renderFormatDocumentModels() {
  verifyBundle();
  const bundle = loadBundle();
  const manifest = loadFormatAuthorityManifest();
  const guides = renderFormatGuideModels();
  const guideDescriptorById = new Map(
    bundle.formatAuthority.readerJourney.guides.map((guide) => [
      guide.id,
      guide,
    ]),
  );
  const guideRoutes = new Map(
    guides.map((guide) => [
      guide.id,
      humanRouteForFormatMarkdown(guideDescriptorById.get(guide.id).path),
    ]),
  );
  const documents = guides.map((guide) => {
    const rawPath = guideDescriptorById.get(guide.id).path;
    return readFormatDocumentDescriptor(rawPath, {
      id: `format-guide-${guide.id}`,
      label: guide.title,
      summary: guide.summary,
      claimClass: `reader-${guide.level}`,
      maturity: 'non-normative-guide',
      navigation: {
        ...(guide.navigation.previous
          ? {
              previous: {
                label: guides.find(({ id }) => id === guide.navigation.previous)
                  .title,
                href: guideRoutes.get(guide.navigation.previous),
              },
            }
          : {}),
        ...(guide.navigation.next
          ? {
              next: {
                label: guides.find(({ id }) => id === guide.navigation.next)
                  .title,
                href: guideRoutes.get(guide.navigation.next),
              },
            }
          : {}),
        related: guide.navigation.related.map((id) => ({
          label: guides.find((candidate) => candidate.id === id).title,
          href: guideRoutes.get(id),
        })),
      },
    });
  });
  const overviewPath = `format/${manifest.overview.path}index.md`;
  documents.push(
    readFormatDocumentDescriptor(overviewPath, {
      id: 'format-overview',
      claimClass: 'authority-overview',
      maturity: manifest.overview.status,
      navigation: {
        previous: {
          label: guides.at(-1).title,
          href: guideRoutes.get(guides.at(-1).id),
        },
        next: {
          label: 'Kungfu CLI handbook',
          href: '/format/handbooks/cli/',
        },
        related: [
          {
            label: guides[0].title,
            href: guideRoutes.get(guides[0].id),
          },
        ],
      },
    }),
  );
  const handbookOrder = ['kungfu', 'npm', 'pypi'];
  const handbookLabels = {
    kungfu: 'Kungfu CLI handbook',
    npm: 'Node SDK handbook',
    pypi: 'Python SDK handbook',
  };
  for (const [index, id] of handbookOrder.entries()) {
    const handbook = manifest.handbooks[id];
    const rawPath = `format/${handbook.path}index.md`;
    const previous =
      index === 0
        ? { label: 'Portable format authority', href: '/format/overview/' }
        : {
            label: handbookLabels[handbookOrder[index - 1]],
            href: `/format/${manifest.handbooks[handbookOrder[index - 1]].path}`,
          };
    const next =
      index === handbookOrder.length - 1
        ? {
            label: 'Historical Spec 0.1 draft',
            href: '/format/history/spec-0.1-draft/',
          }
        : {
            label: handbookLabels[handbookOrder[index + 1]],
            href: `/format/${manifest.handbooks[handbookOrder[index + 1]].path}`,
          };
    documents.push(
      readFormatDocumentDescriptor(rawPath, {
        id: `format-handbook-${id}`,
        label: handbookLabels[id],
        claimClass: 'binding-handbook',
        maturity: handbook.status,
        navigation: {
          previous,
          next,
          related: [
            {
              label: guides[0].title,
              href: guideRoutes.get(guides[0].id),
            },
          ],
        },
      }),
    );
  }
  documents.push(
    readFormatDocumentDescriptor(
      `format/${manifest.history.spec_0_1_draft.path}`,
      {
        id: 'format-history-spec-0-1-draft',
        claimClass: 'historical-audit-material',
        maturity: manifest.history.spec_0_1_draft.status,
        navigation: {
          previous: {
            label: 'Python SDK handbook',
            href: '/format/handbooks/python/',
          },
          next: {
            label: guides[0].title,
            href: guideRoutes.get(guides[0].id),
          },
          related: [
            {
              label: 'Portable format authority',
              href: '/format/overview/',
            },
          ],
        },
      },
    ),
  );
  for (const document of documents) {
    document.linkMap = formatDocumentLinkMap(
      document.source.route.replace(/^\//u, ''),
      documents,
      bundle,
    );
    document.contentRoot = sha256(JSON.stringify(canonical(document)));
  }
  return documents;
}

function sourceDocumentFormat(sourcePath) {
  if (sourcePath.endsWith('.md')) return 'markdown';
  if (sourcePath.endsWith('.json')) return 'json';
  return 'code';
}

function sourceDocumentLabel(source, body, format) {
  if (format === 'markdown') return markdownTitle(body);
  if (format === 'json') {
    const value = JSON.parse(body);
    if (typeof value.title === 'string' && value.title.trim()) {
      return value.title;
    }
    if (typeof value.name === 'string' && value.name.trim()) {
      return value.name;
    }
  }
  return source.path;
}

function sourceDocumentLinkMap(source, documents, bundle) {
  if (!source.path.endsWith('.md')) return {};
  const documentBySourcePath = new Map(
    documents.map((document) => [document.authorityPath, document.route]),
  );
  const hrefs = [
    ...source.body.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu),
  ].map((match) => match[1]);
  const linkMap = {};
  for (const href of hrefs) {
    if (
      href.startsWith('/') ||
      href.startsWith('#') ||
      /^https?:\/\//u.test(href)
    ) {
      continue;
    }
    const [target, fragment = ''] = href.split('#', 2);
    const repositoryTarget = path.posix.normalize(
      path.posix.join(path.posix.dirname(source.path), target),
    );
    if (repositoryTarget.includes('../')) continue;
    const resolved =
      documentBySourcePath.get(repositoryTarget) ||
      `${bundle.source.repository}/blob/${bundle.source.revision}/${repositoryTarget}`;
    linkMap[href] = `${resolved}${fragment ? `#${fragment}` : ''}`;
  }
  return linkMap;
}

function renderSourceDocumentModels() {
  verifyBundle();
  const bundle = loadBundle();
  const sources = bundle.sources.map((source) => {
    const bytes = fs.readFileSync(resolveSitePath(source.packagePath));
    return {
      ...structuredClone(source),
      body: bytes.toString('utf8'),
    };
  });
  const documents = sources.map((source, index) => {
    const format = sourceDocumentFormat(source.path);
    const previous = sources[index - 1];
    const next = sources[index + 1];
    const topicIds = bundle.surfaces
      .filter((surface) => surface.sourceIds.includes(source.id))
      .map((surface) => surface.id);
    return {
      id: `authority-${source.id}`,
      label: sourceDocumentLabel(source, source.body, format),
      route: `/docs/authority/${source.id}/`,
      summary:
        format === 'markdown'
          ? markdownSummary(source.body)
          : `Inspect the exact packaged ${source.role} from ${source.path}.`,
      body: source.body,
      format,
      claimClass: source.role,
      maturity: 'pinned-source-authority',
      authorityPath: source.path,
      topicIds,
      source: {
        route: `/${source.packagePath}`,
        contentRoot: source.contentRoot,
        byteLength: source.byteLength,
      },
      navigation: {
        ...(previous
          ? {
              previous: {
                label: previous.path,
                href: `/docs/authority/${previous.id}/`,
              },
            }
          : {}),
        ...(next
          ? {
              next: {
                label: next.path,
                href: `/docs/authority/${next.id}/`,
              },
            }
          : {}),
        related: [
          {
            label: 'Product map',
            href: '/',
          },
        ],
      },
      linkMap: {},
    };
  });
  for (const document of documents) {
    const source = sources.find(
      (candidate) => candidate.path === document.authorityPath,
    );
    document.linkMap = sourceDocumentLinkMap(source, documents, bundle);
    document.contentRoot = sha256(JSON.stringify(canonical(document)));
  }
  return documents;
}

function formatContentType(relative) {
  if (relative.endsWith('.json')) return 'application/json; charset=utf-8';
  if (relative.endsWith('.jsonl')) return 'application/x-ndjson; charset=utf-8';
  if (relative.endsWith('.md')) return 'text/markdown; charset=utf-8';
  return 'application/octet-stream';
}

function renderFormatArtifactFiles() {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      const relative = path
        .relative(siteRoot, absolute)
        .split(path.sep)
        .join('/');
      if (relative.endsWith('.md')) continue;
      const body = fs.readFileSync(absolute);
      files.push({
        route: `/${relative}`,
        contentType: formatContentType(relative),
        body:
          relative.endsWith('.json') || relative.endsWith('.jsonl')
            ? body.toString('utf8')
            : body,
        kind: relative.includes('/vectors/')
          ? 'format-evidence'
          : 'format-machine-artifact',
      });
    }
  };
  visit(path.join(siteRoot, 'format'));
  return files;
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
  for (const source of bundle.sources || []) {
    const bytes = fs.readFileSync(resolveSitePath(source.packagePath));
    if (
      sha256(bytes) !== source.contentRoot ||
      bytes.length !== source.byteLength
    ) {
      throw new Error(`Kungfu packaged source root mismatch: ${source.id}`);
    }
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
          packagePath: source.packagePath,
          contentRoot: source.contentRoot,
          byteLength: source.byteLength,
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
    if (surface.presentation)
      model.presentation = structuredClone(surface.presentation);
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

function sectionItems(values, label) {
  return values.map((body, index) => ({
    heading: `${label} ${String(index + 1).padStart(2, '0')}`,
    body,
  }));
}

function productTechnicalSections(page) {
  const sections = [];
  if (page.formatAuthority) {
    const authority = page.formatAuthority;
    sections.push({
      id: 'format-authority',
      eyebrow: 'Exact packaged Spec authority',
      heading: 'Verify the pickup, status, normative root and retained corpus.',
      items: [
        {
          heading: 'Package pickup',
          body: authority.pickup.coordinate,
        },
        {
          heading: 'Authority status',
          body: `${authority.status}; format namespace ${authority.formatNamespace}; Spec ${authority.specVersion}.`,
        },
        {
          heading: 'Normative root',
          body: authority.normativeRoot,
        },
        {
          heading: 'Retained conformance corpus',
          body: `${authority.conformance.release}; ${authority.conformance.vectorCount} vectors; ${authority.conformance.releaseRoot}.`,
        },
      ],
    });
    sections.push({
      id: 'format-machine-routes',
      eyebrow: 'Rooted machine routes',
      heading: 'Inspect every exact artifact without a monorepo checkout.',
      items: Object.entries(authority.routes).map(([id, descriptor]) => ({
        heading: id,
        body: `${descriptor.path}; ${descriptor.artifactRoot}; ${descriptor.byteLength} bytes.`,
        href: `/${descriptor.path}`,
        actionLabel: 'Open exact JSON',
      })),
    });
    sections.push({
      id: 'format-reader-journey',
      eyebrow: 'Progressive Spec journey',
      heading: 'Open only the guide required for the current task.',
      items: authority.readerJourney.guides.map((guide) => ({
        heading: `${guide.order}. ${guide.title}`,
        body: `${guide.summary} Root: ${guide.contentRoot}.`,
        href: humanRouteForFormatMarkdown(guide.path),
        actionLabel: 'Read the full guide',
      })),
    });
  }
  if (page.adrMap) {
    sections.push({
      id: 'adr-navigation',
      eyebrow: 'Generated decision navigation',
      heading:
        'Keep navigation projections separate from architecture authority.',
      items: [
        {
          heading: 'Projection root',
          body: page.adrMap.contentRoot,
        },
        {
          heading: 'Authority boundary',
          body: page.adrMap.authorityBoundary,
        },
      ],
    });
  }
  if (page.positioning) {
    sections.push({
      id: 'product-positioning',
      eyebrow: 'Product framing',
      heading: 'Move from the outcome to the independently adoptable layers.',
      items: Object.entries(page.positioning).map(([heading, body]) => ({
        heading,
        body,
      })),
    });
  }
  sections.push({
    id: 'upstream-authorities',
    eyebrow: 'Pinned authority',
    heading: 'Audit the exact upstream source roots.',
    items: page.authorities.map((authority) => ({
      heading: authority.path,
      body: `${authority.role}; ${authority.contentRoot}; ${authority.url}.`,
      href: `/docs/authority/${authority.id}/`,
      actionLabel: 'Read packaged authority',
    })),
  });
  return sections;
}

function productExperiencePage(page, documents = []) {
  const reader = page.presentation?.readerExperience;
  const humanSections = reader?.humanSections
    ? structuredClone(reader.humanSections)
    : [
        {
          id: 'capabilities',
          eyebrow: 'What it enables',
          heading: 'Start with the useful outcome.',
          items: sectionItems(page.capabilities, 'Capability'),
        },
      ];
  if (page.id === 'format') {
    const formatDocuments = documents.filter((document) =>
      document.id.startsWith('format-'),
    );
    const guides = formatDocuments.filter((document) =>
      document.id.startsWith('format-guide-'),
    );
    const references = formatDocuments.filter(
      (document) => !document.id.startsWith('format-guide-'),
    );
    humanSections.unshift({
      id: 'format-reader-path',
      eyebrow: 'Choose your path',
      heading: 'Open the exact depth your task needs.',
      body: 'The landing page explains the boundary. The guides carry the complete operational detail without forcing every reader through the full contract.',
      items: [
        {
          heading: 'New to .kungfu',
          body: 'Orient first, then verify one installed authority before reading deeper contracts.',
          href: '/format/guides/',
          actionLabel: 'Start the reader journey',
        },
        {
          heading: 'Building an integration',
          body: 'Go directly to the Node API, Spec CLI, or independent Python reader task guides.',
          href: '/format/guides/api/',
          actionLabel: 'Open integration guides',
        },
        {
          heading: 'Auditing evidence',
          body: 'Inspect conformance outcomes, compatibility axes, exact roots, and retained vectors.',
          href: '/format/guides/conformance/',
          actionLabel: 'Open conformance evidence',
        },
      ],
    });
    humanSections.push(
      {
        id: 'format-guides',
        eyebrow: 'Start here',
        heading: 'Learn the format one task at a time.',
        body: 'Begin with orientation and first verification. Open API, CLI, Python, conformance and reference detail only when your task reaches that layer.',
        items: guides.map((document, index) => ({
          heading: `${index + 1}. ${document.label}`,
          body: document.summary,
          href: document.route,
          actionLabel: index === 0 ? 'Start the journey' : 'Read the guide',
        })),
      },
      {
        id: 'format-reference-library',
        eyebrow: 'Complete library',
        heading: 'Continue into authority, binding and historical context.',
        body: 'These documents retain the broader authority overview, current binding boundaries and explicitly non-normative history.',
        items: references.map((document) => ({
          heading: document.label,
          body: `${document.summary} Status: ${document.maturity}.`,
          href: document.route,
          actionLabel: 'Open document',
        })),
      },
    );
  }
  const authorityDocuments = page.authorities
    .map((authority) =>
      documents.find((document) => document.id === `authority-${authority.id}`),
    )
    .filter(Boolean);
  const authoritySection = {
    id: 'packaged-authority-documents',
    eyebrow: 'Detailed documentation',
    heading: 'Read the complete sources behind this page.',
    body: 'Each page below is generated from exact source bytes packaged with this bundle. The summary remains an entry point, not a substitute for the authority.',
    items: authorityDocuments.map((document) => ({
      heading: document.label,
      body: `${document.summary} Source: ${document.authorityPath}.`,
      href: document.route,
      actionLabel: 'Read full document',
    })),
  };
  humanSections.splice(page.id === 'format' ? 1 : 0, 0, authoritySection);
  return {
    id: page.id,
    label: page.label,
    route: page.route,
    kicker: reader?.kicker || page.label,
    headline: reader?.headline || page.headline,
    summary: reader?.lead || page.summary,
    claimClass: page.claimClass,
    maturity: page.maturity,
    knownLimits: structuredClone(page.knownLimits),
    humanSections,
    technicalSections: productTechnicalSections(page),
    technicalSummary:
      reader?.technicalSummary ||
      'Inspect exact contracts, evidence, authority roots and source boundaries.',
    authorities: structuredClone(page.authorities),
  };
}

function renderSiteExperience(config) {
  verifyBundle();
  const bundle = loadBundle();
  return createSiteExperience(
    config,
    bundle.siteExperienceDefaults,
    bundle.sources,
  );
}

function renderProductSiteExperience(options = {}) {
  verifyBundle();
  const bundle = loadBundle();
  const documents = [
    ...renderFormatDocumentModels(),
    ...renderSourceDocumentModels(),
  ];
  const experienceDocuments = documents.map(
    ({ contentRoot: _contentRoot, ...document }) => document,
  );
  const pages = renderPageModels().map((page) =>
    productExperiencePage(page, experienceDocuments),
  );
  return createSiteExperience(
    {
      contract: 'kungfu.site-experience-config/v1',
      site: {
        id: options.id || 'kungfu-core',
        context: options.context || 'Core Product and Developer Platform',
        canonicalBaseUrl:
          options.canonicalBaseUrl || 'https://core.libkungfu.dev',
        language: options.language || 'en',
      },
      navigation: {
        primary:
          options.primary ||
          pages.filter((page) => page.route !== '/').map((page) => page.id),
        external: options.external || [],
      },
      machineRoutes: options.machineRoutes,
      content: { pages, documents: experienceDocuments },
    },
    bundle.siteExperienceDefaults,
    bundle.sources,
    renderFormatArtifactFiles(),
  );
}

function verifySiteExperience(experience) {
  verifyBundle();
  return verifyExperience(experience);
}

module.exports = {
  adrMapPath,
  agentIndexPath,
  bundlePath,
  formatGuideIndexPath,
  formatManifestPath,
  kfxSiteBundlePath,
  kfxSiteManifestPath,
  kfxSiteRoot,
  experienceSchemaPath,
  loadBundle,
  loadKfxSiteBundle,
  loadFormatAuthorityManifest,
  loadFormatAuthorityRoute,
  loadFormatGuide,
  loadFormatGuideIndex,
  renderFormatGuideModel,
  renderFormatGuideModels,
  renderFormatDocumentModels,
  renderSourceDocumentModels,
  renderPageModel,
  renderPageModels,
  renderProductSiteExperience,
  renderSiteExperience,
  schemaPath,
  siteRoot,
  verifyBundle,
  verifyKfxSiteBundle,
  verifySiteExperience,
};
