#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0
// Generate the committed, deterministic machine projection of the portable
// format authorities. The source contracts remain the semantic owners.
// @ts-check

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const pkgRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const generatedRoot = path.join(pkgRoot, 'generated');

const sourcePaths = {
  specMeta: 'framework/spec/spec.meta.json',
  composition:
    'framework/spec/format/kungfu-portable-format-authority.contract.json',
  reader: 'framework/spec/format/kungfu-required-reader.contract.json',
  migration: 'framework/spec/format/kungfu-format-migration.contract.json',
  vectorIndex:
    'framework/spec/format/conformance/portable-format-vectors/index.json',
  baselineIndex: 'framework/spec/format/compatibility/v4-alpha/index.json',
};

/** @param {unknown} value @returns {any} */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

/** @param {unknown} value */
function renderJson(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

/** @param {Buffer|string} value */
function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/**
 * Git declares the portable-format JSON authorities as canonical LF text, but
 * a Windows checkout may still expose CRLF bytes when runner-global settings
 * or an older worktree predate that declaration. Normalize only these JSON
 * text inputs so their opaque-byte roots and committed projections remain
 * independent of the checkout host.
 *
 * @param {string} value
 */
function normalizeLf(value) {
  return value.replace(/\r\n?/g, '\n');
}

/** @param {string} relative */
function readSource(relative) {
  const absolute = path.join(repoRoot, relative);
  const worktreeBytes = fs.readFileSync(absolute);
  const bytes = relative.endsWith('.json')
    ? Buffer.from(normalizeLf(worktreeBytes.toString('utf8')), 'utf8')
    : worktreeBytes;
  let value = null;
  if (relative.endsWith('.json')) value = JSON.parse(bytes.toString('utf8'));
  return {
    path: relative,
    root: sha256(bytes),
    value,
  };
}

/** @param {Array<{path:string,root:string}>} sources */
function sourceBinding(sources) {
  const unique = new Map(sources.map((source) => [source.path, source]));
  return {
    root_protocol: 'sha256:opaque-bytes/v1',
    sources: [...unique.values()].map(({ path: sourcePath, root }) => ({
      path: sourcePath,
      root,
    })),
  };
}

function buildArtifacts() {
  const specMeta = readSource(sourcePaths.specMeta);
  const composition = readSource(sourcePaths.composition);
  const reader = readSource(sourcePaths.reader);
  const migration = readSource(sourcePaths.migration);
  const vectorIndex = readSource(sourcePaths.vectorIndex);
  const baselineIndex = readSource(sourcePaths.baselineIndex);
  const baselineReleasePath = path.posix.join(
    path.posix.dirname(sourcePaths.baselineIndex),
    baselineIndex.value.releases.find(
      /** @param {{id:string}} release */
      (release) => release.id === baselineIndex.value.latestRelease,
    ).path,
  );
  const baselineRelease = readSource(baselineReleasePath);
  const vectorReleasePath = path.posix.join(
    path.posix.dirname(sourcePaths.vectorIndex),
    vectorIndex.value.releases.find(
      /** @param {{id:string}} release */
      (release) => release.id === vectorIndex.value.latestRelease,
    ).path,
  );
  const vectorRelease = readSource(vectorReleasePath);

  /** @param {string} schema @param {Array<any>} sources @param {object} data */
  const artifact = (schema, sources, data) => ({
    schema,
    projection: {
      generator: 'framework/spec/scripts/generate.js',
      policy: 'canonical-json-sorted-keys-utf8-lf/v1',
      ...sourceBinding(sources),
    },
    ...data,
  });

  const authority = artifact(
    'kungfu.spec.generated-authority/v1',
    [composition, specMeta],
    {
      id: composition.value.id,
      format_namespace: specMeta.value.format_namespace,
      spec_version: specMeta.value.spec_version,
      status: composition.value.status,
      boundary: composition.value.boundary,
      terminology: composition.value.terminology,
      version_axes: composition.value.versionAxes,
      compatibility: composition.value.compatibility,
      readers: composition.value.readers,
      non_claims: composition.value.nonClaims,
    },
  );

  const registrySources = [
    composition,
    ...composition.value.authorities.map(
      /** @param {{source:string}} owner */
      (owner) => readSource(owner.source),
    ),
  ];
  const registry = artifact('kungfu.spec.schema-registry/v1', registrySources, {
    id: 'kungfu-portable-authority-registry',
    status: 'current-pre-release-authority',
    entries: composition.value.authorities.map(
      /** @param {any} owner */
      (owner) => {
        const source = registrySources.find(
          (candidate) => candidate.path === owner.source,
        );
        return {
          protocol_id: owner.protocolId,
          source: owner.source,
          source_root: source.root,
          source_role: owner.sourceRole,
          identity_domain: owner.identityDomain,
          version_axis: owner.versionAxis,
          compatibility_owner: owner.compatibilityOwner,
        };
      },
    ),
  });

  const errors = artifact(
    'kungfu.spec.error-dictionary/v1',
    [reader, migration],
    {
      id: 'kungfu-portable-format-errors',
      status: 'current',
      dictionaries: [
        {
          owner: reader.value.schema,
          errors: reader.value.errorDictionary,
        },
        {
          owner: migration.value.schema,
          errors: migration.value.errorDictionary,
        },
      ],
    },
  );

  const capabilities = artifact('kungfu.spec.capabilities/v1', [reader], {
    id: 'kungfu-required-reader-capabilities',
    status: 'current',
    outcomes: reader.value.outcomes,
    capabilities: reader.value.capabilities,
    material_states: reader.value.materialStates,
  });

  const readerMatrix = artifact('kungfu.spec.reader-matrix/v1', [reader], {
    id: 'kungfu-required-reader-matrix',
    status: 'current',
    rule: reader.value.rule,
    profiles: reader.value.readerProfiles,
  });

  const compatibility = artifact(
    'kungfu.spec.compatibility-map/v1',
    [composition, reader, migration, baselineIndex, baselineRelease],
    {
      id: 'kungfu-portable-format-compatibility',
      status: 'current',
      tuple_contract: migration.value.compatibilityTuple,
      current_tuple: migration.value.currentTuple,
      reader_outcomes: migration.value.readerOutcomeMap,
      composition_rule: composition.value.compatibility.rule,
      v4_alpha_baseline: {
        format_line: baselineIndex.value.formatLine,
        latest_release: baselineIndex.value.latestRelease,
        latest_release_root: baselineIndex.value.latestReleaseRoot,
        append_policy: baselineIndex.value.appendPolicy,
        stability: baselineRelease.value.stability,
        source_bindings: baselineRelease.value.sourceBindings,
      },
      non_claims: [
        ...composition.value.nonClaims,
        ...migration.value.nonClaims,
      ],
    },
  );

  const migrationGraph = artifact(
    'kungfu.spec.migration-graph/v1',
    [migration],
    {
      id: migration.value.id,
      status: migration.value.status,
      rule: migration.value.rule,
      graph: migration.value.migrationGraph,
      operation: migration.value.migrationOperation,
      repair: migration.value.repair,
      non_claims: migration.value.nonClaims,
    },
  );

  const vectors = artifact(
    'kungfu.spec.vector-index/v1',
    [vectorIndex, vectorRelease],
    {
      id: vectorIndex.value.id,
      status: 'qualified-retained-corpus',
      append_policy: vectorIndex.value.appendPolicy,
      latest_release: vectorIndex.value.latestRelease,
      latest_release_root: vectorIndex.value.latestReleaseRoot,
      release: {
        path: vectorRelease.path,
        source_root: vectorRelease.root,
        declared_root: vectorIndex.value.latestReleaseRoot,
        previous_release_root: vectorRelease.value.previousReleaseRoot,
      },
      authority: vectorRelease.value.authority,
      historical_fixture_classification:
        vectorRelease.value.historicalFixtureClassification,
      vectors: vectorRelease.value.vectors,
    },
  );

  return new Map([
    ['authority.json', authority],
    ['registry.json', registry],
    ['errors.json', errors],
    ['capabilities.json', capabilities],
    ['reader-matrix.json', readerMatrix],
    ['compatibility.json', compatibility],
    ['migration.json', migrationGraph],
    ['vectors/index.json', vectors],
  ]);
}

/** @param {Map<string,unknown>} artifacts */
function renderArtifacts(artifacts) {
  return new Map(
    [...artifacts].map(([relative, value]) => [relative, renderJson(value)]),
  );
}

/** @param {Map<string,string>} rendered @param {string} [root] */
function writeArtifacts(rendered, root = generatedRoot) {
  fs.mkdirSync(root, { recursive: true });
  for (const [relative, bytes] of rendered) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
}

/** @param {Map<string,string>} rendered @param {string} [root] */
function checkArtifacts(rendered, root = generatedRoot) {
  const failures = [];
  for (const [relative, expected] of rendered) {
    const target = path.join(root, relative);
    if (!fs.existsSync(target))
      failures.push(`${relative}: missing; run generate`);
    else if (normalizeLf(fs.readFileSync(target, 'utf8')) !== expected)
      failures.push(`${relative}: generated artifact drift; run generate`);
  }
  const expectedPaths = new Set(rendered.keys());
  if (fs.existsSync(root)) {
    /** @param {string} directory @param {string} [prefix] */
    const walk = (directory, prefix = '') => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = path.posix.join(prefix, entry.name);
        if (entry.isDirectory())
          walk(path.join(directory, entry.name), relative);
        else if (entry.isFile() && !expectedPaths.has(relative))
          failures.push(`${relative}: unowned generated artifact`);
      }
    };
    walk(root);
  }
  if (failures.length)
    throw new Error(`generated authority drift:\n- ${failures.join('\n- ')}`);
}

/** @param {Map<string,string>} rendered */
function artifactInventory(rendered) {
  return Object.fromEntries(
    [...rendered]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([relative, bytes]) => [
        relative,
        {
          path: relative,
          root: sha256(bytes),
          byte_length: Buffer.byteLength(bytes),
          media_type: 'application/json',
        },
      ]),
  );
}

function main(argv = process.argv.slice(2)) {
  const mode = argv[0] || '--check';
  if (!['--write', '--check'].includes(mode) || argv.length > 1) {
    console.error('usage: node scripts/generate.js [--write|--check]');
    return 2;
  }
  const rendered = renderArtifacts(buildArtifacts());
  if (mode === '--write') {
    writeArtifacts(rendered);
    console.log(
      `[spec:generate] wrote ${rendered.size} deterministic authority artifacts`,
    );
  } else {
    checkArtifacts(rendered);
    console.log(
      `[spec:generate] OK — ${rendered.size} committed artifacts match their authorities`,
    );
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(
      `[spec:generate] FAIL — ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

module.exports = {
  artifactInventory,
  buildArtifacts,
  canonical,
  checkArtifacts,
  main,
  normalizeLf,
  renderArtifacts,
  renderJson,
  sha256,
  writeArtifacts,
};
