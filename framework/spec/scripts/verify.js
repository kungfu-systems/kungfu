#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0
// Full manifest-schema, content-root, source-root, vector, and drift gate.
// @ts-check

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020').default;
const {
  buildArtifacts,
  checkArtifacts,
  renderArtifacts,
  renderJson,
  sha256,
} = require('./generate.js');

const pkgRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const distDir = path.join(pkgRoot, 'dist');
const schemaPath = path.join(pkgRoot, 'schema', 'manifest.schema.json');
const examplePath = path.join(pkgRoot, 'schema', 'manifest.example.json');
const manifestPath = path.join(distDir, 'manifest.json');

/**
 * @typedef {{
 *   id: string,
 *   path: string,
 *   content_root: string,
 *   byte_length: number,
 *   previous: string|null,
 *   next: string|null,
 *   related: string[]
 * }} ReaderJourneyGuide
 */

/**
 * @typedef {{
 *   schema: string,
 *   guides: ReaderJourneyGuide[],
 *   levels: Array<{guide_ids: string[]}>
 * }} ReaderJourney
 */

/** @param {string} file */
function json(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** @param {string} root @param {string} relative */
function inside(root, relative) {
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
    throw new Error(`path escapes bundle: ${relative}`);
  return resolved;
}

/** @param {Buffer|string} bytes */
function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * @param {string} id
 * @param {any} artifact
 * @param {any} manifest
 * @param {(condition: unknown, message: string) => void} check
 * @param {string[]} failures
 */
function verifySpecArtifact(id, artifact, manifest, check, failures) {
  let file;
  try {
    file = inside(distDir, artifact.path);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    return;
  }
  if (!fs.existsSync(file)) {
    failures.push(`artifact ${id} is missing: ${artifact.path}`);
    return;
  }
  const bytes = fs.readFileSync(file);
  check(
    digest(bytes) === artifact.artifact_root,
    `artifact ${id} root drifted`,
  );
  check(
    bytes.length === artifact.byte_length,
    `artifact ${id} byte_length drifted`,
  );
  let generated;
  try {
    generated = JSON.parse(bytes.toString('utf8'));
  } catch {
    failures.push(`artifact ${id} is not valid JSON`);
    return;
  }
  check(
    generated.schema === artifact.schema,
    `artifact ${id} schema identity drifted`,
  );
  check(
    JSON.stringify(generated.projection?.sources) ===
      JSON.stringify(artifact.source_roots),
    `artifact ${id} source bindings drifted`,
  );
  for (const source of artifact.source_roots) {
    try {
      const sourceFile = inside(repoRoot, source.path);
      check(fs.existsSync(sourceFile), `artifact ${id} source is missing`);
      if (fs.existsSync(sourceFile))
        check(
          digest(fs.readFileSync(sourceFile)) === source.root,
          `artifact ${id} source root drifted: ${source.path}`,
        );
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  const preimage = manifest.normative.preimage.artifacts[id];
  check(
    preimage?.path === artifact.path &&
      preimage?.root === artifact.artifact_root,
    `artifact ${id} is not exactly bound into the normative preimage`,
  );
}

/**
 * @param {any} manifest
 * @param {(condition: unknown, message: string) => void} check
 * @param {string[]} failures
 */
function verifySpecArtifacts(manifest, check, failures) {
  for (const [id, artifact] of Object.entries(manifest.artifacts)) {
    verifySpecArtifact(id, artifact, manifest, check, failures);
  }
}

/**
 * @param {ReaderJourneyGuide} guide
 * @param {Set<string>} guideIds
 * @param {(condition: unknown, message: string) => void} check
 */
function verifyReaderGuide(guide, guideIds, check) {
  const guidePath = inside(distDir, guide.path);
  const bytes = fs.readFileSync(guidePath);
  check(
    digest(bytes) === guide.content_root,
    `reader guide root drifted: ${guide.id}`,
  );
  check(
    bytes.length === guide.byte_length,
    `reader guide byte_length drifted: ${guide.id}`,
  );
  for (const linked of [guide.previous, guide.next, ...(guide.related || [])])
    check(
      linked === null || guideIds.has(linked),
      `reader guide ${guide.id} links unknown guide ${linked}`,
    );
  const markdown = bytes.toString('utf8');
  for (const match of markdown.matchAll(/\]\(([^)]+)\)/gu)) {
    const target = match[1].split('#', 1)[0];
    if (!target || /^[a-z]+:/iu.test(target)) continue;
    const linkedPath = path.resolve(path.dirname(guidePath), target);
    check(
      (linkedPath === distDir ||
        linkedPath.startsWith(`${distDir}${path.sep}`)) &&
        fs.existsSync(linkedPath),
      `reader guide ${guide.id} has broken link: ${target}`,
    );
  }
}

/**
 * @param {any} manifest
 * @param {(condition: unknown, message: string) => void} check
 * @param {string[]} failures
 */
function verifyReaderJourney(manifest, check, failures) {
  try {
    const journeyPath = inside(distDir, manifest.reader_journey.path);
    const journeyBytes = fs.readFileSync(journeyPath);
    check(
      digest(journeyBytes) === manifest.reader_journey.content_root,
      'reader journey index root drifted',
    );
    check(
      journeyBytes.length === manifest.reader_journey.byte_length,
      'reader journey index byte_length drifted',
    );
    const journey = /** @type {ReaderJourney} */ (
      JSON.parse(journeyBytes.toString('utf8'))
    );
    check(
      journey.schema === manifest.reader_journey.schema,
      'reader journey schema drifted',
    );
    const guideIds = new Set(journey.guides.map((guide) => guide.id));
    check(
      guideIds.size === journey.guides.length,
      'reader journey contains duplicate guide ids',
    );
    check(
      journey.levels.flatMap((level) => level.guide_ids).length ===
        journey.guides.length,
      'reader journey levels do not cover every guide exactly once',
    );
    for (const guide of journey.guides)
      verifyReaderGuide(guide, guideIds, check);
  } catch (error) {
    failures.push(
      `reader journey verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function main() {
  /** @type {string[]} */
  const failures = [];
  /** @param {unknown} condition @param {string} message */
  const check = (condition, message) => {
    if (!condition) failures.push(message);
  };

  let schema;
  let manifest;
  try {
    schema = json(schemaPath);
    manifest = json(manifestPath);
  } catch (error) {
    console.error(
      `[spec:verify] FAIL — ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  try {
    checkArtifacts(renderArtifacts(buildArtifacts()));
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  try {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      validateFormats: false,
    });
    const validate = ajv.compile(schema);
    if (!validate(manifest))
      for (const error of validate.errors || [])
        failures.push(
          `manifest schema ${error.instancePath || '/'} ${error.message || 'failed'}`,
        );
    const example = json(examplePath);
    if (!validate(example))
      for (const error of validate.errors || [])
        failures.push(
          `manifest example ${error.instancePath || '/'} ${error.message || 'failed'}`,
        );
  } catch (error) {
    failures.push(
      `manifest schema compilation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  check(
    manifest.docs_url_base.includes(`/spec/${manifest.spec_version}/`),
    'docs_url_base does not route the exact spec_version',
  );
  check(
    manifest.categories.format_spec.artifact_root ===
      manifest.artifacts.authority.artifact_root,
    'format_spec must route the generated composition authority',
  );
  for (const [category, artifact] of Object.entries({
    format_spec: 'authority',
    schema_registry: 'schema_registry',
    error_dictionary: 'error_dictionary',
    capabilities: 'capabilities',
    conformance_vectors: 'conformance_vectors',
    conformance_map: 'compatibility',
  }))
    check(
      JSON.stringify(manifest.categories[category]) ===
        JSON.stringify(manifest.artifacts[artifact]),
      `category ${category} does not route its exact rooted artifact`,
    );
  check(
    manifest.history.spec_0_1_draft.status === 'historical-non-normative',
    'Spec 0.1 prose must remain explicitly historical and non-normative',
  );
  check(
    !JSON.stringify(manifest.normative).includes('generated_at') &&
      !JSON.stringify(manifest.normative).includes('platform'),
    'mutable build provenance entered the normative root',
  );
  check(
    manifest.normative.root === sha256(renderJson(manifest.normative.preimage)),
    'normative root does not match its canonical preimage',
  );

  verifySpecArtifacts(manifest, check, failures);

  const registry = json(path.join(distDir, 'registry.json'));
  const errors = json(path.join(distDir, 'errors.json'));
  const capabilities = json(path.join(distDir, 'capabilities.json'));
  const readerMatrix = json(path.join(distDir, 'reader-matrix.json'));
  const compatibility = json(path.join(distDir, 'compatibility.json'));
  const migration = json(path.join(distDir, 'migration.json'));
  const vectors = json(path.join(distDir, 'vectors', 'index.json'));
  check(registry.entries.length > 0, 'schema registry is empty');
  check(
    registry.entries.every(
      /** @param {{protocol_id:string,source:string,source_root:string}} entry */
      (entry) =>
        entry.protocol_id &&
        entry.source &&
        /^sha256:[0-9a-f]{64}$/.test(entry.source_root),
    ),
    'schema registry contains an unrooted authority',
  );
  check(
    errors.dictionaries.every(
      /** @param {{errors:Array<unknown>}} entry */
      (entry) => entry.errors.length > 0,
    ),
    'error dictionary contains an empty owner table',
  );
  check(capabilities.capabilities.length > 0, 'capability table is empty');
  check(readerMatrix.profiles.length > 0, 'required-reader matrix is empty');
  check(
    Object.keys(compatibility.current_tuple).length > 0,
    'compatibility tuple is empty',
  );
  check(migration.graph.edges.length > 0, 'migration graph is empty');
  check(vectors.vectors.length > 0, 'retained vector index is empty');
  check(
    ![registry, errors, capabilities, readerMatrix, compatibility, migration]
      .map((value) => JSON.stringify(value))
      .some((text) => /walking skeleton|minimal reference|pending/i.test(text)),
    'a generated authority artifact still presents skeleton semantics',
  );

  for (const vector of vectors.vectors) {
    const vectorFile = inside(
      distDir,
      path.posix.join('vectors', vectors.latest_release, vector.path),
    );
    check(fs.existsSync(vectorFile), `vector is missing: ${vector.id}`);
    if (fs.existsSync(vectorFile)) {
      const bytes = fs.readFileSync(vectorFile);
      check(
        bytes.length === vector.byteLength,
        `vector length drifted: ${vector.id}`,
      );
      check(
        digest(bytes) === vector.byteRoot,
        `vector root drifted: ${vector.id}`,
      );
    }
  }

  for (const [id, history] of Object.entries(manifest.history))
    check(
      fs.existsSync(inside(distDir, history.path)),
      `historical artifact is missing: ${id}`,
    );
  for (const [id, handbook] of Object.entries(manifest.handbooks))
    check(
      fs.existsSync(inside(distDir, handbook.path)),
      `handbook is missing: ${id}`,
    );
  check(
    fs.existsSync(inside(distDir, manifest.overview.path)),
    'overview is missing',
  );
  verifyReaderJourney(manifest, check, failures);

  if (failures.length) {
    console.error('[spec:verify] FAIL — authority bundle gate failed:');
    for (const failure of failures) console.error(`  - ${failure}`);
    return 1;
  }
  console.log(
    `[spec:verify] OK — ${Object.keys(manifest.artifacts).length} rooted artifacts, ${registry.entries.length} authorities, ${vectors.vectors.length} retained vectors`,
  );
  console.log(`[spec:verify] normative root ${manifest.normative.root}`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { main };
