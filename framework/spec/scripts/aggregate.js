#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0
// Assemble the installed Spec bundle from committed generated authorities.
// @ts-check

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  artifactInventory,
  buildArtifacts,
  checkArtifacts,
  renderArtifacts,
  renderJson,
  sha256,
} = require('./generate.js');

const pkgRoot = path.resolve(__dirname, '..');
const generatedRoot = path.join(pkgRoot, 'generated');
const distDir = path.join(pkgRoot, 'dist');

/**
 * @typedef {{
 *   id: string,
 *   level: string,
 *   order: number,
 *   title: string,
 *   summary: string,
 *   path: string,
 *   previous: string|null,
 *   next: string|null,
 *   related?: string[],
 *   byte_length?: number,
 *   content_root?: string
 * }} ReaderJourneyGuide
 */

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   purpose: string,
 *   guide_ids: string[]
 * }} ReaderJourneyLevel
 */

/**
 * @typedef {{
 *   schema: string,
 *   title: string,
 *   summary: string,
 *   levels: ReaderJourneyLevel[],
 *   guides: ReaderJourneyGuide[]
 * }} ReaderJourneySource
 */

/** @param {string} message */
function log(message) {
  console.log(`[spec:aggregate] ${message}`);
}

/** @param {string} relative */
function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(pkgRoot, relative), 'utf8'));
}

/** @param {string} relative @param {string|Buffer} bytes */
function write(relative, bytes) {
  const target = path.join(distDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: pkgRoot })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

/**
 * @param {Record<string, any>} inventory
 * @param {string} artifactPath
 * @param {string} sourcePackage
 * @param {string} status
 */
function descriptor(inventory, artifactPath, sourcePackage, status) {
  const generated = JSON.parse(
    fs.readFileSync(path.join(generatedRoot, artifactPath), 'utf8'),
  );
  const item = inventory[artifactPath];
  return {
    path: artifactPath,
    source_package: sourcePackage,
    status,
    schema: generated.schema,
    protocol: 'sha256:opaque-bytes/v1',
    media_type: item.media_type,
    byte_length: item.byte_length,
    artifact_root: item.root,
    source_roots: generated.projection.sources,
  };
}

/** @param {{name:string, version:string}} pkg */
function buildReaderJourney(pkg) {
  const source = /** @type {ReaderJourneySource} */ (
    readJson('docs/reader-journey.json')
  );
  if (source.schema !== 'kungfu.spec.reader-journey-source/v1')
    throw new Error('unexpected reader journey source contract');
  const guideIds = new Set(source.guides.map((guide) => guide.id));
  if (guideIds.size !== source.guides.length)
    throw new Error('reader journey contains duplicate guide ids');
  const orders = new Set(source.guides.map((guide) => guide.order));
  if (orders.size !== source.guides.length)
    throw new Error('reader journey contains duplicate guide order values');
  const levelIds = new Set(source.levels.map((level) => level.id));
  for (const guide of source.guides) {
    if (!levelIds.has(guide.level))
      throw new Error(`reader journey guide has unknown level: ${guide.id}`);
    for (const linked of [
      guide.previous,
      guide.next,
      ...(guide.related || []),
    ]) {
      if (linked !== null && !guideIds.has(linked))
        throw new Error(
          `reader journey guide ${guide.id} links unknown guide ${linked}`,
        );
    }
    const sourcePath = path.join(pkgRoot, 'docs', guide.path);
    if (!fs.existsSync(sourcePath))
      throw new Error(`reader journey guide is missing: ${guide.id}`);
    let bytes = fs.readFileSync(sourcePath);
    if (guide.id === 'reference')
      bytes = Buffer.from(
        bytes
          .toString('utf8')
          .replace('](../overview.md)', '](../overview/index.md)'),
      );
    if (!/^guides\/[a-z0-9-]+\.md$/u.test(guide.path))
      throw new Error(`reader journey guide path is invalid: ${guide.id}`);
    write(guide.path, bytes);
    guide.byte_length = bytes.length;
    guide.content_root = sha256(bytes);
  }
  for (const level of source.levels) {
    for (const guideId of level.guide_ids) {
      const guide = source.guides.find((entry) => entry.id === guideId);
      if (!guide || guide.level !== level.id)
        throw new Error(
          `reader journey level ${level.id} does not own ${guideId}`,
        );
    }
  }
  const levelGuideIds = source.levels.flatMap((level) => level.guide_ids);
  if (
    levelGuideIds.length !== source.guides.length ||
    new Set(levelGuideIds).size !== source.guides.length
  ) {
    throw new Error(
      'reader journey levels must cover every guide exactly once',
    );
  }
  const journey = {
    schema: 'kungfu.spec.reader-journey/v1',
    package: { name: pkg.name, version: pkg.version },
    title: source.title,
    summary: source.summary,
    levels: source.levels,
    guides: source.guides.sort((left, right) => left.order - right.order),
  };
  const bytes = renderJson(journey);
  write('guides/index.json', bytes);
  return {
    descriptor: {
      path: 'guides/index.json',
      source_package: 'framework/spec',
      status: 'non-normative-guide',
      schema: journey.schema,
      protocol: 'sha256:opaque-bytes/v1',
      byte_length: Buffer.byteLength(bytes),
      content_root: sha256(bytes),
    },
    guideCount: journey.guides.length,
  };
}

function main() {
  const meta = readJson('spec.meta.json');
  const pkg = readJson('package.json');
  const rendered = renderArtifacts(buildArtifacts());
  checkArtifacts(rendered);
  const inventory = artifactInventory(rendered);
  const specVersion = meta.spec_version;
  const docsUrlBase = `${meta.docs_url_host}/spec/${specVersion}/`;

  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  for (const [relative] of rendered)
    write(relative, fs.readFileSync(path.join(generatedRoot, relative)));

  const retainedVectorRoot = path.resolve(
    pkgRoot,
    'format',
    'conformance',
    'portable-format-vectors',
  );
  for (const entry of fs.readdirSync(retainedVectorRoot, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory() || !/^v[1-9][0-9]*$/u.test(entry.name)) continue;
    const bytesRoot = path.join(retainedVectorRoot, entry.name, 'bytes');
    if (fs.existsSync(bytesRoot))
      fs.cpSync(bytesRoot, path.join(distDir, 'vectors', entry.name, 'bytes'), {
        recursive: true,
      });
  }
  fs.cpSync(
    path.join(pkgRoot, 'conformance', 'unknown-record'),
    path.join(distDir, 'history', 'synthetic-unknown-record'),
    { recursive: true },
  );

  write(
    'overview/index.md',
    fs
      .readFileSync(path.join(pkgRoot, 'docs', 'overview.md'), 'utf8')
      .replace('](guides/index.md)', '](../guides/index.md)')
      .replace('](handbooks/cli.md)', '](../handbooks/cli/index.md)')
      .replace('](handbooks/node.md)', '](../handbooks/node/index.md)')
      .replace('](handbooks/python.md)', '](../handbooks/python/index.md)'),
  );
  write(
    'history/spec-0.1-draft.md',
    fs.readFileSync(path.join(pkgRoot, 'docs', 'format-spec.md')),
  );
  for (const [name, source] of Object.entries({
    cli: 'docs/handbooks/cli.md',
    node: 'docs/handbooks/node.md',
    python: 'docs/handbooks/python.md',
  }))
    write(
      `handbooks/${name}/index.md`,
      fs.readFileSync(path.join(pkgRoot, source)),
    );
  const readerJourney = buildReaderJourney(pkg);

  const artifacts = {
    authority: descriptor(
      inventory,
      'authority.json',
      'framework/spec/format',
      'current-pre-release-authority',
    ),
    schema_registry: descriptor(
      inventory,
      'registry.json',
      'authority-owner-set',
      'current-pre-release-authority',
    ),
    error_dictionary: descriptor(
      inventory,
      'errors.json',
      'framework/spec/format',
      'current',
    ),
    capabilities: descriptor(
      inventory,
      'capabilities.json',
      'framework/spec/format',
      'current',
    ),
    reader_matrix: descriptor(
      inventory,
      'reader-matrix.json',
      'framework/spec/format',
      'current',
    ),
    compatibility: descriptor(
      inventory,
      'compatibility.json',
      'framework/spec/format',
      'current',
    ),
    migration: descriptor(
      inventory,
      'migration.json',
      'framework/spec/format',
      'current',
    ),
    conformance_vectors: descriptor(
      inventory,
      'vectors/index.json',
      'framework/spec/format',
      'qualified-retained-corpus',
    ),
  };

  const normativePreimage = {
    schema: 'kungfu.spec.normative-root/v1',
    format_namespace: meta.format_namespace,
    spec_version: specVersion,
    reproducibility: 'canonical-json-sorted-keys-utf8-lf/v1',
    artifacts: Object.fromEntries(
      Object.entries(artifacts).map(([id, value]) => [
        id,
        { path: value.path, root: value.artifact_root },
      ]),
    ),
  };

  const manifest = {
    manifest_version: '1',
    format_namespace: meta.format_namespace,
    spec_version: specVersion,
    package: { name: pkg.name, version: pkg.version },
    normative: {
      status: 'pre-release',
      root_protocol: 'sha256:canonical-json/v1',
      root: sha256(renderJson(normativePreimage)),
      reproducibility: 'canonical-json-sorted-keys-utf8-lf/v1',
      preimage: normativePreimage,
      non_claims: [
        'The standalone portable format is not declared stable.',
        'Package semver is not a format compatibility algorithm.',
        'The historical Spec 0.1 prose is not normative.',
        'The package is a projection and does not replace its owning sources.',
      ],
    },
    provenance: {
      kungfu_version: pkg.version,
      git_commit: gitCommit(),
    },
    docs_url_base: docsUrlBase,
    overview: {
      path: 'overview/',
      source_package: 'framework/spec',
      status: 'non-normative-guide',
    },
    reader_journey: readerJourney.descriptor,
    artifacts,
    categories: {
      format_spec: artifacts.authority,
      schema_registry: artifacts.schema_registry,
      error_dictionary: artifacts.error_dictionary,
      capabilities: artifacts.capabilities,
      conformance_vectors: artifacts.conformance_vectors,
      conformance_map: artifacts.compatibility,
    },
    handbooks: {
      kungfu: {
        path: 'handbooks/cli/',
        binding_version: pkg.version,
        docs_url: `${docsUrlBase}handbooks/cli/`,
        api_ref_source: 'developer/toolchain',
        status: 'non-normative-binding-guide',
      },
      pypi: {
        path: 'handbooks/python/',
        binding_version: pkg.version,
        docs_url: `${docsUrlBase}handbooks/python/`,
        api_ref_source: 'framework/core',
        status: 'non-normative-binding-guide',
      },
      npm: {
        path: 'handbooks/node/',
        binding_version: pkg.version,
        docs_url: `${docsUrlBase}handbooks/node/`,
        api_ref_source: 'framework/api',
        status: 'non-normative-binding-guide',
      },
    },
    history: {
      spec_0_1_draft: {
        path: 'history/spec-0.1-draft.md',
        status: 'historical-non-normative',
      },
      synthetic_unknown_record: {
        path: 'history/synthetic-unknown-record/',
        status: 'historical-non-normative-fixture',
      },
    },
  };
  write('manifest.json', renderJson(manifest));

  log(
    `built deterministic Spec ${specVersion} authority bundle (${Object.keys(artifacts).length} rooted artifacts)`,
  );
  log(`published ${readerJourney.guideCount} progressive reader guides`);
  log(`normative root ${manifest.normative.root}`);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(
      `[spec:aggregate] FAIL — ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

module.exports = { descriptor, main };
