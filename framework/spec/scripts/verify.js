#!/usr/bin/env node
'use strict';

// verify — SKELETON PLACEHOLDER for the integration drift gate.
//
// When wired, this is the spec bundle's integration gate: it fails the build if
// the aggregated bundle is inconsistent. The intended assertions (each a
// "drift = build fail" check, per the release-topology plan):
//   - dist/manifest.json exists and validates against schema/manifest.schema.json
//   - every categories.*.path and handbooks.*.path referenced by the manifest
//     actually exists in the bundle (all six categories + three handbooks present)
//   - spec_version is well-formed and matches the routed docs_url_base
//   - schema registry / error dictionary / conformance vectors cover what they claim
//   - api-ref pieces were regenerated against the current API (no signature drift)
//   - recipes ran green (recipes live with each binding; results aggregated here)
//
// Per-piece drift gates live in each source package's own `verify`. This gate is
// the final integration check that the pieces cohere before publish.
//
// Until the flows land content, this is a no-op success so it does not block the
// build chain.

const fs = require('fs');
const path = require('path');

const pkgRoot = path.resolve(__dirname, '..');
const schemaPath = path.join(pkgRoot, 'schema', 'manifest.schema.json');

function log(msg) {
  console.log(`[spec:verify] ${msg}`);
}

function main() {
  // The one thing we can already assert: the contract file is present and parseable.
  try {
    JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    log('manifest contract schema present and parseable.');
  } catch (err) {
    console.error(`[spec:verify] FAIL: cannot read/parse ${schemaPath}: ${err.message}`);
    return 1;
  }

  log('skeleton — integration drift gate not yet active. TODO: assert bundle completeness + schema validation.');
  return 0;
}

process.exit(main());
