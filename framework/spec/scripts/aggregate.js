#!/usr/bin/env node
'use strict';

// aggregate — build the spec bundle into dist/ and emit dist/manifest.json.
//
// WALKING SKELETON: this produces a REAL, schema-valid, consumable bundle with
// MINIMAL content, to prove the publish -> consume -> render pipeline end to end.
// Real hand-written prose today: overview (home), format_spec, and the three
// handbooks (kungfu/python/node). The machine categories carry seed entries or
// stubs; their real generators (framework/core etc.) replace them later
// (drift = build fail once that flow lands). Ownership is recorded in the
// manifest so nothing is silently faked.
// @ts-check

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const pkgRoot = path.resolve(__dirname, '..');
const distDir = path.join(pkgRoot, 'dist');

/** @param {string} msg */
function log(msg) {
  console.log(`[spec:aggregate] ${msg}`);
}

/**
 * @param {string} p
 * @returns {any}
 */
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * @param {string} rel
 * @param {unknown} obj
 */
function writeJson(rel, obj) {
  const abs = path.join(distDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(obj, null, 2) + '\n');
}

/**
 * @param {string} rel
 * @param {string} text
 */
function writeText(rel, text) {
  const abs = path.join(distDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
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

// Marks content that a later flow will replace with generated output.
const PENDING = '(minimal reference; content grows in its owning flow)';

function main() {
  const meta = readJson(path.join(pkgRoot, 'spec.meta.json'));
  const pkg = readJson(path.join(pkgRoot, 'package.json'));

  const specVersion = meta.spec_version;
  const docsUrlBase = `${meta.docs_url_host}/spec/${specVersion}/`;

  // Clean/prepare dist.
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  /**
   * @param {string} srcRel
   * @param {string} distRel
   */
  const copyDoc = (srcRel, distRel) =>
    writeText(distRel, fs.readFileSync(path.join(pkgRoot, srcRel), 'utf8'));

  // --- overview: real landing prose (framework/spec owns this) ---
  copyDoc('docs/overview.md', 'overview/index.md');

  // --- format_spec: real minimal prose (framework/spec owns this) ---
  copyDoc('docs/format-spec.md', 'format-spec/index.md');

  // --- machine categories: minimal, with a couple of real seed entries so a
  //     consumer renders real rows rather than empty pages. Real generators
  //     (framework/core) replace these; note marks them as seed. ---
  writeJson('registry.json', {
    spec_version: specVersion,
    note: PENDING,
    schemas: [],
  });
  writeJson('errors.json', {
    spec_version: specVersion,
    note: `seed entries; full dictionary ${PENDING}`,
    errors: [
      {
        code: 'E_PAYLOAD_MISSING',
        meaning: 'Referenced payload is absent from the blob store.',
        next: 'Distinguish redacted vs lost vs not-yet-written via the three-state marker.',
      },
      {
        code: 'E_HASH_MISMATCH',
        meaning: 'Recomputed payload hash does not match the event reference.',
        next: 'Treat the payload as tampered or corrupted; the manifest commitment is authoritative.',
      },
      {
        code: 'E_SCHEMA_UNKNOWN',
        meaning: 'Event type has no entry in the schema registry.',
        next: 'Upgrade the registry, or read the event as opaque with its raw type tag.',
      },
    ],
  });
  writeJson('capabilities.json', {
    spec_version: specVersion,
    note: `seed entries; full table ${PENDING}`,
    capabilities: [
      {
        id: 'append_only',
        since: '0.1',
        summary: 'Committed events are never rewritten or reordered.',
      },
      {
        id: 'recorded_causality',
        since: '0.1',
        summary: 'Each event carries its causal parent at write time.',
      },
      {
        id: 'runtime_free_read',
        since: '0.1',
        summary:
          'A bundle can be opened and verified without the producing runtime.',
      },
    ],
  });
  writeJson('vectors/index.json', {
    spec_version: specVersion,
    note: PENDING,
    vectors: [],
  });
  writeJson('conformance.json', {
    spec_version: specVersion,
    note: PENDING,
    implements: [],
  });

  // --- three handbooks: real minimal recipes (copied from docs/handbooks) ---
  const handbooks = {
    kungfu: {
      dir: 'handbooks/cli',
      src: 'docs/handbooks/cli.md',
      api_ref_source: 'developer/toolchain',
    },
    pypi: {
      dir: 'handbooks/python',
      src: 'docs/handbooks/python.md',
      api_ref_source: 'framework/core',
    },
    npm: {
      dir: 'handbooks/node',
      src: 'docs/handbooks/node.md',
      api_ref_source: 'framework/api',
    },
  };
  for (const h of Object.values(handbooks)) {
    copyDoc(h.src, `${h.dir}/index.md`);
  }

  // --- manifest: the connection protocol (schema-valid) ---
  const manifest = {
    manifest_version: '1',
    format_namespace: meta.format_namespace,
    spec_version: specVersion,
    package: { name: pkg.name, version: pkg.version },
    provenance: {
      kungfu_version: pkg.version,
      git_commit: gitCommit(),
      generated_at: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
    },
    docs_url_base: docsUrlBase,
    overview: { path: 'overview/', source_package: 'framework/spec' },
    categories: {
      format_spec: { path: 'format-spec/', source_package: 'framework/spec' },
      schema_registry: {
        path: 'registry.json',
        source_package: 'framework/core',
      },
      error_dictionary: {
        path: 'errors.json',
        source_package: 'framework/core',
      },
      capabilities: {
        path: 'capabilities.json',
        source_package: 'framework/core',
      },
      conformance_vectors: {
        path: 'vectors/',
        source_package: 'framework/core',
      },
      conformance_map: {
        path: 'conformance.json',
        source_package: 'framework/spec',
      },
    },
    handbooks: {
      kungfu: {
        path: 'handbooks/cli/',
        binding_version: pkg.version,
        docs_url: `${docsUrlBase}handbooks/cli/`,
        api_ref_source: handbooks.kungfu.api_ref_source,
      },
      pypi: {
        path: 'handbooks/python/',
        binding_version: pkg.version,
        docs_url: `${docsUrlBase}handbooks/python/`,
        api_ref_source: handbooks.pypi.api_ref_source,
      },
      npm: {
        path: 'handbooks/node/',
        binding_version: pkg.version,
        docs_url: `${docsUrlBase}handbooks/node/`,
        api_ref_source: handbooks.npm.api_ref_source,
      },
    },
  };
  writeJson('manifest.json', manifest);

  log(
    `built spec ${specVersion} bundle -> dist/ (package ${pkg.name}@${pkg.version})`,
  );
  log(
    'overview + format_spec + 3 handbooks = real minimal prose; machine categories = seed/stub.',
  );
  return 0;
}

process.exit(main());
