// SPDX-License-Identifier: Apache-2.0

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Ajv2020 = require('ajv/dist/2020');

const {
  adrMapPath,
  agentIndexPath,
  experienceSchemaPath,
  formatGuideIndexPath,
  formatManifestPath,
  loadBundle,
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
  verifyBundle,
  verifySiteExperience,
} = require('./index.js');

test('publishes one integrity-bound human and agent product map', () => {
  const result = verifyBundle();
  assert.equal(result.status, 'passing');
  assert.equal(result.package.name, '@kungfu-tech/site');
  assert.ok(result.surfaces >= 10);
  assert.ok(result.sources >= 10);
  assert.ok(fs.existsSync(schemaPath));
  assert.ok(fs.existsSync(agentIndexPath));
  assert.ok(fs.existsSync(adrMapPath));
  assert.ok(fs.existsSync(formatManifestPath));
  assert.ok(fs.existsSync(formatGuideIndexPath));
  assert.ok(fs.existsSync(experienceSchemaPath));
  assert.equal(result.format.status, 'pre-release');
  assert.equal(result.format.conformance.status, 'qualified-retained-corpus');
  const experienceSchema = JSON.parse(
    fs.readFileSync(experienceSchemaPath, 'utf8'),
  );
  assert.doesNotThrow(() =>
    new Ajv2020({ strict: true, validateFormats: false }).compile(
      experienceSchema,
    ),
  );
});

test('projects a progressive format journey without flattening guide bodies', () => {
  const bundle = loadBundle();
  const journey = loadFormatGuideIndex();
  assert.deepEqual(
    journey.levels.map(({ id }) => id),
    ['orientation', 'quickstart', 'task-guides', 'evidence', 'reference'],
  );
  assert.deepEqual(
    journey.guides.map(({ id }) => id),
    [
      'start',
      'quickstart',
      'api',
      'cli',
      'python-reader',
      'conformance',
      'reference',
    ],
  );
  assert.equal(
    bundle.formatAuthority.readerJourney.entryGuideId,
    journey.guides[0].id,
  );
  assert.equal(
    bundle.machineEntries.formatReaderJourney,
    'format/guides/index.json',
  );
  assert.equal(
    Object.hasOwn(renderPageModel('/format/').formatAuthority, 'body'),
    false,
  );
  const guide = loadFormatGuide('quickstart');
  assert.match(guide.body, /First success/);
  assert.throws(
    () => loadFormatGuide('../missing'),
    /Unknown Kungfu format reader guide/,
  );
});

test('renders integrity-bound guide models in declared reading order', () => {
  const models = renderFormatGuideModels();
  assert.equal(models.length, 7);
  assert.deepEqual(
    models.map(({ id }) => id),
    [
      'start',
      'quickstart',
      'api',
      'cli',
      'python-reader',
      'conformance',
      'reference',
    ],
  );
  for (const model of models) {
    assert.equal(model.contract, 'kungfu.site-format-guide-model/v1');
    assert.match(model.contentRoot, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(model.body.startsWith('# '));
    assert.deepEqual(renderFormatGuideModel(model.id), model);
  }
  assert.equal(renderFormatGuideModel('start').navigation.next, 'quickstart');
  assert.equal(renderFormatGuideModel('reference').navigation.next, null);
  assert.throws(
    () => renderFormatGuideModel('missing'),
    /Unknown Kungfu format reader guide/,
  );
});

test('renders every packaged format document as a rooted progressive page', () => {
  const documents = renderFormatDocumentModels();
  assert.equal(documents.length, 12);
  assert.deepEqual(
    documents.map(({ route }) => route),
    [
      '/format/guides/',
      '/format/guides/quickstart/',
      '/format/guides/api/',
      '/format/guides/cli/',
      '/format/guides/python-reader/',
      '/format/guides/conformance/',
      '/format/guides/reference/',
      '/format/overview/',
      '/format/handbooks/cli/',
      '/format/handbooks/node/',
      '/format/handbooks/python/',
      '/format/history/spec-0.1-draft/',
    ],
  );
  for (const document of documents) {
    assert.match(document.contentRoot, /^sha256:[0-9a-f]{64}$/u);
    assert.match(document.source.contentRoot, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(document.body.startsWith('# '));
    assert.ok(document.source.route.endsWith('.md'));
  }
  assert.equal(
    documents[0].linkMap['quickstart.md'],
    '/format/guides/quickstart/',
  );
  assert.match(
    documents.find(({ id }) => id === 'format-overview').linkMap[
      '../../../docs/concepts/product-layers.md'
    ],
    /^https:\/\/github\.com\/kungfu-systems\/kungfu\/blob\//u,
  );
});

test('renders every declared product authority from packaged exact bytes', () => {
  const bundle = loadBundle();
  const documents = renderSourceDocumentModels();
  assert.equal(documents.length, bundle.sources.length);
  assert.equal(documents.length, 30);
  assert.deepEqual(
    new Set(documents.map(({ format }) => format)),
    new Set(['markdown', 'json', 'code']),
  );
  for (const source of bundle.sources) {
    const document = documents.find(
      ({ id }) => id === `authority-${source.id}`,
    );
    assert.ok(document, `missing authority document ${source.id}`);
    assert.equal(document.authorityPath, source.path);
    assert.equal(document.source.route, `/${source.packagePath}`);
    assert.equal(document.source.contentRoot, source.contentRoot);
    assert.equal(document.source.byteLength, source.byteLength);
  }
});

test('keeps maturity and authority boundaries explicit', () => {
  const bundle = loadBundle();
  const byId = new Map(bundle.surfaces.map((surface) => [surface.id, surface]));
  assert.equal(byId.get('format').maturity, 'staged');
  assert.equal(byId.get('format').claimClass, 'current-contract');
  assert.equal(byId.get('primitives').maturity, 'qualified-shadow');
  assert.equal(byId.get('products').maturity, 'qualified');
  assert.match(bundle.adrMap.authorityBoundary, /navigation-only/);
  assert.ok(
    bundle.nonClaims.some(
      (entry) => entry.includes('Spec 0.1') && entry.includes('non-normative'),
    ),
  );
  assert.ok(!JSON.stringify(bundle).includes('pre-normative'));
});

test('projects exact package-local format authority routes', () => {
  const bundle = loadBundle();
  const manifest = loadFormatAuthorityManifest();
  assert.equal(bundle.formatAuthority.package.name, '@kungfu-tech/spec');
  assert.equal(
    bundle.formatAuthority.pickup.coordinate,
    `${manifest.package.name}@${manifest.package.version}`,
  );
  assert.equal(bundle.formatAuthority.normativeRoot, manifest.normative.root);
  assert.equal(bundle.formatAuthority.status, manifest.normative.status);
  assert.deepEqual(Object.keys(bundle.formatAuthority.routes), [
    'overview',
    'readerContract',
    'versionMatrix',
    'registry',
    'vectors',
  ]);
  for (const routeId of Object.keys(bundle.formatAuthority.routes)) {
    const route = loadFormatAuthorityRoute(routeId);
    assert.equal(route.value.schema, route.descriptor.schema);
  }
  assert.throws(
    () => loadFormatAuthorityRoute('../manifest'),
    /Unknown Kungfu format authority route/,
  );
});

test('rejects retained vector drift without any monorepo authority fallback', () => {
  const isolatedRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-site-format-'),
  );
  fs.copyFileSync(
    path.join(__dirname, 'index.js'),
    path.join(isolatedRoot, 'index.js'),
  );
  fs.copyFileSync(
    path.join(__dirname, 'experience.js'),
    path.join(isolatedRoot, 'experience.js'),
  );
  fs.cpSync(path.join(__dirname, 'dist'), path.join(isolatedRoot, 'dist'), {
    recursive: true,
  });
  const isolated = require(path.join(isolatedRoot, 'index.js'));
  const vectors = isolated.loadFormatAuthorityRoute('vectors').value;
  const vectorPath = path.join(
    isolated.siteRoot,
    'format',
    'vectors',
    vectors.latest_release,
    vectors.vectors[0].path,
  );
  fs.appendFileSync(vectorPath, Buffer.from([0]));
  assert.throws(() => isolated.verifyBundle(), /retained vector root mismatch/);
});

test('rejects packaged product-authority drift without source-tree fallback', () => {
  const isolatedRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-site-source-'),
  );
  fs.copyFileSync(
    path.join(__dirname, 'index.js'),
    path.join(isolatedRoot, 'index.js'),
  );
  fs.copyFileSync(
    path.join(__dirname, 'experience.js'),
    path.join(isolatedRoot, 'experience.js'),
  );
  fs.cpSync(path.join(__dirname, 'dist'), path.join(isolatedRoot, 'dist'), {
    recursive: true,
  });
  const isolated = require(path.join(isolatedRoot, 'index.js'));
  const source = isolated.loadBundle().sources[0];
  fs.appendFileSync(
    path.join(isolated.siteRoot, source.packagePath),
    '\nchanged\n',
  );
  assert.throws(() => isolated.verifyBundle(), /packaged source root mismatch/);
});

test('exposes the complete product route hierarchy', () => {
  const routes = loadBundle().surfaces.map((surface) => surface.route);
  assert.deepEqual(routes, [
    '/',
    '/format/',
    '/primitives/',
    '/runtime/',
    '/abi/',
    '/sdk/',
    '/extensions/',
    '/products/',
    '/qualification/',
    '/decisions/',
    '/horizons/',
  ]);
});

test('renders one integrity-bound page model for every human route', () => {
  const bundle = loadBundle();
  const pages = renderPageModels();
  assert.equal(pages.length, bundle.surfaces.length);
  assert.deepEqual(
    pages.map(({ route }) => route),
    bundle.surfaces.map(({ route }) => route),
  );
  for (const page of pages) {
    assert.equal(page.contract, 'kungfu.site-page-model/v1');
    assert.match(page.contentRoot, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(page.bundle.contentRoot, bundle.contentRoot);
    assert.equal(page.navigation.length, pages.length);
    assert.ok(page.authorities.length > 0);
    assert.equal(JSON.stringify(page).includes('undefined'), false);
    assert.deepEqual(renderPageModel(page.route), page);
    assert.deepEqual(renderPageModel(page.id), page);
  }
  assert.equal(
    renderPageModel('/format/').formatAuthority.normativeRoot,
    bundle.formatAuthority.normativeRoot,
  );
  assert.equal(
    renderPageModel('/decisions/').adrMap.contentRoot,
    bundle.adrMap.contentRoot,
  );
  assert.throws(() => renderPageModel('/missing/'), /Unknown Kungfu site page/);
});

test('generates a complete human-first product site with KFD-3 co-reading', () => {
  const experience = renderProductSiteExperience();
  const result = verifySiteExperience(experience);
  assert.equal(result.status, 'passing');
  assert.equal(result.pages, 11);
  assert.equal(result.documents, 42);
  assert.equal(result.files, 126);
  assert.equal(result.machineEntry, '/agent-index.json');
  assert.equal(experience.brand.signature, 'Kungfu UNGFU™');
  assert.equal(experience.brand.productName, 'Kungfu');
  assert.equal(experience.kfd3.standard, 'KFD-3');
  assert.equal(experience.kfd3.authorities.length, 2);
  assert.ok(
    experience.kfd3.authorities.every((authority) =>
      /^sha256:[0-9a-f]{64}$/u.test(authority.contentRoot),
    ),
  );
  assert.equal(experience.navigation.machineEntriesInPrimary, false);
  assert.ok(
    !experience.navigation.primary.some((entry) => entry.route === '/'),
  );
  assert.ok(
    experience.navigation.primary.every(
      (entry) => !Object.values(experience.machineEntries).includes(entry.href),
    ),
  );

  const formatPage = experience.files.find((file) => file.route === '/format/');
  assert.match(
    formatPage.body,
    /\.kungfu is a portable, verifiable record of real work\./,
  );
  assert.match(formatPage.body, /Human first · Agent co-reading/);
  assert.match(formatPage.body, /KFD-3 machine entry/);
  assert.match(
    formatPage.body,
    /<aside class="kungfu-sidebar-desktop" aria-label="Topic navigation">/,
  );
  assert.match(formatPage.body, /<details class="kungfu-sidebar-mobile">/);
  assert.match(formatPage.body, /<span>Browse topics<\/span>/);
  assert.match(
    formatPage.body,
    /<nav class="kungfu-topic-tree" aria-label="Product themes">/,
  );
  assert.match(
    formatPage.body,
    /<details class="kungfu-topic-node" open data-current-topic="true">\s*<summary>\.kungfu<\/summary>/,
  );
  assert.match(
    formatPage.body,
    /href="\/format\/" aria-current="page">\.kungfu<\/a>/,
  );
  assert.match(
    formatPage.body,
    /href="\/format\/" aria-current="page">Overview<\/a>/,
  );
  assert.match(formatPage.body, /href="\/format\/guides\/"/);
  assert.match(
    formatPage.body,
    /@media\(max-width:960px\)\{\.kungfu-page-layout\{grid-template-columns:1fr/,
  );
  assert.match(
    formatPage.body,
    /\.kungfu-brand>span:first-child\{flex:0 0 auto\}/,
  );
  assert.match(
    formatPage.body,
    /@media\(max-width:760px\).*\.kungfu-brand\{display:grid;gap:2px\}/,
  );
  assert.match(
    formatPage.body,
    /\.kungfu-reader-item h3,.kungfu-reader-item p\{margin:0;overflow-wrap:anywhere\}/,
  );
  assert.match(formatPage.body, /Qualified does not mean stable\./);
  assert.match(formatPage.body, /Start the journey/);
  assert.match(formatPage.body, /href="\/format\/guides\/"/);
  assert.match(formatPage.body, /Exact packaged Spec authority/);
  assert.ok(
    formatPage.body.indexOf('Human first · Agent co-reading') <
      formatPage.body.indexOf('Why it exists'),
  );
  assert.ok(
    formatPage.body.indexOf('Why it exists') <
      formatPage.body.indexOf('<details class="kungfu-technical">'),
  );
  assert.doesNotMatch(
    formatPage.body,
    /<details class="kungfu-technical" open/u,
  );

  const agentIndex = JSON.parse(
    experience.files.find((file) => file.route === '/agent-index.json').body,
  );
  const manifest = JSON.parse(
    experience.files.find((file) => file.route === '/manifest.json').body,
  );
  assert.deepEqual(agentIndex.brand, experience.brand);
  assert.deepEqual(agentIndex.navigation, experience.navigation);
  assert.deepEqual(manifest.brand, experience.brand);
  assert.deepEqual(manifest.navigation, experience.navigation);
  assert.equal(agentIndex.readingOrder.length, 11);
  assert.equal(agentIndex.documents.length, 42);
  assert.equal(agentIndex.packagedArtifacts.length, 28);
  assert.equal(agentIndex.navigation.tree.length, 11);
  assert.equal(agentIndex.navigation.tree[0].id, agentIndex.navigation.home.id);
  assert.equal(agentIndex.navigation.tree[0].children[0].label, 'Overview');
  const formatTopic = agentIndex.navigation.tree.find(
    (topic) => topic.id === 'format',
  );
  assert.equal(formatTopic.children[0].route, '/format/');
  assert.ok(
    formatTopic.children.some(
      (child) => child.route === '/format/guides/conformance/',
    ),
  );
  const humanRoutes = new Set(
    experience.files
      .filter((file) => ['human-page', 'human-document'].includes(file.kind))
      .map((file) => file.route),
  );
  for (const topic of agentIndex.navigation.tree) {
    assert.ok(topic.children.length > 0);
    for (const child of topic.children) {
      assert.ok(humanRoutes.has(child.route), child.route);
    }
  }
  assert.equal(manifest.documents.length, 42);
  assert.equal(manifest.packagedArtifacts.length, 28);

  const conformance = experience.files.find(
    (file) => file.route === '/format/guides/conformance/',
  );
  assert.equal(conformance.kind, 'human-document');
  assert.match(conformance.body, /<table>/);
  assert.match(conformance.body, /<pre><code class="language-sh">/);
  assert.match(conformance.body, /href="\/format\/guides\/reference\/"/);
  assert.match(
    conformance.body,
    /href="\/format\/" aria-current="page">\.kungfu<\/a>/,
  );
  assert.match(
    conformance.body,
    /href="\/format\/guides\/conformance\/" aria-current="page">/,
  );
  assert.doesNotMatch(
    conformance.body,
    /<details class="kungfu-technical" open/u,
  );
  assert.ok(
    experience.files.some(
      (file) =>
        file.route === '/format/guides/conformance.md' &&
        file.kind === 'source-document',
    ),
  );
  const abiPage = experience.files.find((file) => file.route === '/abi/');
  assert.match(abiPage.body, /Detailed documentation/);
  assert.match(abiPage.body, /href="\/docs\/authority\/abi-guide\/"/);
  const abiGuide = experience.files.find(
    (file) => file.route === '/docs/authority/abi-guide/',
  );
  assert.match(abiGuide.body, /Consume the KFD-7 libkungfu ABI/);
  assert.match(
    abiGuide.body,
    /<details class="kungfu-topic-node" open data-current-topic="true">\s*<summary>Native ABI<\/summary>/,
  );
  assert.match(
    abiGuide.body,
    /href="\/docs\/authority\/abi-guide\/" aria-current="page">Consume the KFD-7 libkungfu ABI/,
  );
  assert.deepEqual(
    agentIndex.documents.find(
      (document) => document.id === 'authority-abi-guide',
    ).topicIds,
    ['abi', 'sdk'],
  );
  assert.ok(
    experience.files.some(
      (file) =>
        file.route === '/sources/abi-guide/libkungfu-abi-consumer.md' &&
        file.kind === 'source-document',
    ),
  );
  assert.ok(
    experience.files.some(
      (file) =>
        file.route === '/format/vectors/index.json' &&
        file.kind === 'format-evidence',
    ),
  );
  assert.ok(
    experience.files.some(
      (file) =>
        file.route ===
          '/format/vectors/v1/bytes/journal-v1-unknown-carrier.bin' &&
        file.kind === 'format-evidence',
    ),
  );
});

test('lets a site supply only content and configuration', () => {
  const documentBody =
    '# Detailed guide\n\nStart with the outcome.\n\n```sh\nexample --verify\n```\n';
  const config = {
    contract: 'kungfu.site-experience-config/v1',
    site: {
      id: 'example-site',
      context: 'Example Surface',
      canonicalBaseUrl: 'https://example.test',
    },
    navigation: {
      external: [{ label: 'Source', href: 'https://example.test/source' }],
    },
    content: {
      pages: [
        {
          id: 'home',
          label: 'Home',
          route: '/',
          kicker: 'Human orientation',
          headline: 'Understand the outcome before the contract.',
          summary: 'One concise first screen stays paired with exact evidence.',
          claimClass: 'site-synthesis',
          maturity: 'staged',
          knownLimits: ['This fixture is not a product release.'],
          humanSections: [
            {
              id: 'orientation',
              heading: 'Start with the human question.',
              body: 'The renderer owns order and disclosure, not upstream truth.',
            },
          ],
          technicalSections: [
            {
              id: 'evidence',
              heading: 'Inspect exact evidence.',
              items: [
                {
                  heading: 'Root',
                  body: 'sha256:opaque-example',
                },
              ],
            },
          ],
        },
      ],
      documents: [
        {
          id: 'detailed-guide',
          label: 'Detailed guide',
          route: '/guides/detailed/',
          summary: 'A complete task guide supplied as rooted Markdown.',
          body: documentBody,
          claimClass: 'task-guide',
          maturity: 'staged',
          source: {
            route: '/guides/detailed.md',
            contentRoot: `sha256:${createHash('sha256')
              .update(documentBody)
              .digest('hex')}`,
            byteLength: Buffer.byteLength(documentBody),
          },
          navigation: {
            previous: { label: 'Home', href: '/' },
          },
        },
      ],
    },
  };
  const experience = renderSiteExperience(config);
  const receipt = verifySiteExperience(experience);
  assert.equal(receipt.pages, 1);
  assert.equal(receipt.documents, 1);
  assert.equal(experience.navigation.tree.length, 1);
  assert.deepEqual(
    experience.navigation.tree[0].children.map(({ route }) => route),
    ['/', '/guides/detailed/'],
  );
  const html = experience.files.find((file) => file.route === '/').body;
  assert.match(html, /Kungfu UNGFU™/);
  assert.match(html, /Example Surface/);
  assert.match(html, /href="\/agent-index\.json"/);
  assert.match(html, /<details class="kungfu-technical">/);
  const document = experience.files.find(
    (file) => file.route === '/guides/detailed/',
  );
  assert.match(document.body, /<h1>Detailed guide<\/h1>/);
  assert.match(document.body, /<pre><code class="language-sh">/);
  assert.ok(
    experience.files.some(
      (file) =>
        file.route === '/guides/detailed.md' && file.body === documentBody,
    ),
  );

  const unknownField = structuredClone(config);
  unknownField.content.pages[0].sitePatch = 'downstream override';
  assert.throws(
    () => renderSiteExperience(unknownField),
    /page has unknown fields: sitePatch/,
  );

  const unknownTopic = structuredClone(config);
  unknownTopic.content.documents[0].topicIds = ['missing-topic'];
  assert.throws(
    () => renderSiteExperience(unknownTopic),
    /references unknown topic: missing-topic/,
  );

  const protocolRelativeNavigation = structuredClone(config);
  protocolRelativeNavigation.navigation.external[0].href =
    '//untrusted.example';
  assert.throws(
    () => renderSiteExperience(protocolRelativeNavigation),
    /external navigation must be HTTP\(S\)/,
  );
});

test('fails closed when a generated experience file is changed', () => {
  const experience = renderProductSiteExperience();
  const tampered = structuredClone(experience);
  tampered.files.find((file) => file.route === '/').body += '\nchanged\n';
  assert.throws(() => verifySiteExperience(tampered), /file root mismatch/);
});
