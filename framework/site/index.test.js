// SPDX-License-Identifier: Apache-2.0

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

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

test('keeps maturity and authority boundaries explicit', () => {
  const bundle = loadBundle();
  const byId = new Map(bundle.surfaces.map((surface) => [surface.id, surface]));
  assert.equal(byId.get('format').maturity, 'staged');
  assert.equal(byId.get('format').claimClass, 'current-contract');
  assert.equal(byId.get('primitives').maturity, 'qualified-shadow');
  assert.equal(byId.get('products').maturity, 'coming-soon');
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
  assert.equal(result.files, 14);
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
  assert.match(formatPage.body, /Qualified does not mean stable\./);
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
});

test('lets a site supply only content and configuration', () => {
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
    },
  };
  const experience = renderSiteExperience(config);
  assert.equal(verifySiteExperience(experience).pages, 1);
  const html = experience.files.find((file) => file.route === '/').body;
  assert.match(html, /Kungfu UNGFU™/);
  assert.match(html, /Example Surface/);
  assert.match(html, /href="\/agent-index\.json"/);
  assert.match(html, /<details class="kungfu-technical">/);

  const unknownField = structuredClone(config);
  unknownField.content.pages[0].sitePatch = 'downstream override';
  assert.throws(
    () => renderSiteExperience(unknownField),
    /page has unknown fields: sitePatch/,
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
