// SPDX-License-Identifier: Apache-2.0

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  adrMapPath,
  agentIndexPath,
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
  verifyBundle,
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
