#!/usr/bin/env node
'use strict';

// aggregate — SKELETON PLACEHOLDER (no content generation yet).
//
// This is the integration/aggregation step of the spec bundle. When wired, it
// collects the generated pieces produced by the source packages (each owns its
// own generator + drift gate) into a single published bundle, then emits
// dist/manifest.json conforming to schema/manifest.schema.json.
//
// Ownership (per the release-topology decision) — this package DOES NOT generate
// these; it only aggregates the outputs and writes the manifest:
//   categories.schema_registry     <- framework/core   (from longfist)
//   categories.error_dictionary    <- framework/core   (from error defs)
//   categories.conformance_vectors <- framework/core   (from reference impl)
//   categories.capabilities        <- framework/core
//   handbooks.kungfu (CLI-ref)     <- developer/toolchain
//   handbooks.npm    (node-ref)    <- framework/api     (from TS types)
//   handbooks.pypi   (py-ref)      <- python binding    (via introspection)
//   categories.format_spec         <- framework/spec    (this package: prose)
//   categories.conformance_map     <- framework/spec    (this package)
//
// spec_version (the authoritative format contract, currently "1.0") is declared
// HERE and is independent of the lerna package version.

const fs = require('fs');
const path = require('path');

const pkgRoot = path.resolve(__dirname, '..');
const distDir = path.join(pkgRoot, 'dist');

function log(msg) {
  console.log(`[spec:aggregate] ${msg}`);
}

function main() {
  log('skeleton — aggregation not yet implemented.');
  log('contract lives in schema/manifest.schema.json; reference instance in schema/manifest.example.json.');
  log('TODO(core/toolchain/node/python flows): drop generated pieces; TODO(spec flow): assemble dist/manifest.json.');

  // Ensure dist exists so downstream steps have a stable target directory.
  fs.mkdirSync(distDir, { recursive: true });

  // Intentionally a no-op success while the six flows fill in content.
  return 0;
}

process.exit(main());
