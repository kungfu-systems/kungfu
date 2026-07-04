#!/usr/bin/env node
'use strict';

// verify — integration drift gate for the spec bundle (minimal, active).
//
// WALKING SKELETON scope: this asserts the bundle is internally coherent and
// matches the manifest contract. It is intentionally a focused structural check
// (not full JSON-Schema validation via ajv yet — that is a follow-up) but it is
// REAL: it fails the build if the produced bundle drifts from the contract.
//
// Checks:
//   1. dist/manifest.json exists and parses
//   2. required top-level keys present; const/format invariants hold
//   3. all six categories + three handbooks declared, each with required fields
//   4. every path the manifest references actually exists in the bundle
//   5. spec_version is consistently routed into docs_url_base
// @ts-check

const fs = require('fs');
const path = require('path');

const pkgRoot = path.resolve(__dirname, '..');
const distDir = path.join(pkgRoot, 'dist');
const schemaPath = path.join(pkgRoot, 'schema', 'manifest.schema.json');
const manifestPath = path.join(distDir, 'manifest.json');

/** @type {string[]} */
const failures = [];
/**
 * @param {unknown} cond
 * @param {string} msg
 */
function check(cond, msg) {
  if (!cond) failures.push(msg);
}

function main() {
  // Contract file must always be present.
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  } catch (err) {
    console.error(
      `[spec:verify] FAIL: cannot read/parse manifest schema: ${/** @type {Error} */ (err).message}`,
    );
    return 1;
  }

  if (!fs.existsSync(manifestPath)) {
    console.error(
      '[spec:verify] FAIL: dist/manifest.json missing — run build (aggregate) first.',
    );
    return 1;
  }

  let m;
  try {
    m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    console.error(
      `[spec:verify] FAIL: dist/manifest.json does not parse: ${/** @type {Error} */ (err).message}`,
    );
    return 1;
  }

  // 2. required top-level keys + invariants (driven by the schema where cheap).
  for (const key of schema.required) {
    check(key in m, `manifest missing required key: ${key}`);
  }
  check(
    m.manifest_version === '1',
    `manifest_version must be "1", got ${JSON.stringify(m.manifest_version)}`,
  );
  check(
    m.package && m.package.name === '@kungfu-tech/spec',
    'package.name must be @kungfu-tech/spec',
  );
  check(
    /^[0-9]+\.[0-9]+$/.test(m.spec_version || ''),
    `spec_version malformed: ${m.spec_version}`,
  );
  check(
    /^[a-z][a-z0-9]*(:[a-z0-9-]+)+$/.test(m.format_namespace || ''),
    `format_namespace must be a domain-free id: ${m.format_namespace}`,
  );
  check(
    !/[a-z]+\.[a-z]+/.test(m.format_namespace || ''),
    `format_namespace must not embed a domain: ${m.format_namespace}`,
  );

  // 5. spec_version routed into docs_url_base.
  check(
    typeof m.docs_url_base === 'string' &&
      m.docs_url_base.includes(`/spec/${m.spec_version}/`),
    `docs_url_base must route /spec/${m.spec_version}/: ${m.docs_url_base}`,
  );

  // optional overview: if declared, its path must exist.
  if (m.overview) {
    check(
      m.overview.path && m.overview.source_package,
      'overview missing path/source_package',
    );
    if (m.overview.path) {
      check(
        fs.existsSync(path.join(distDir, m.overview.path)),
        `overview path not in bundle: ${m.overview.path}`,
      );
    }
  }

  // 3 + 4. all six categories present, each path exists.
  const catKeys = Object.keys(schema.properties.categories.properties);
  for (const k of catKeys) {
    const entry = (m.categories || {})[k];
    check(
      entry && entry.path && entry.source_package,
      `category ${k} missing path/source_package`,
    );
    if (entry && entry.path) {
      check(
        fs.existsSync(path.join(distDir, entry.path)),
        `category ${k} path not in bundle: ${entry.path}`,
      );
    }
  }

  // 3 + 4. all three handbooks present, each path exists.
  const hbKeys = Object.keys(schema.properties.handbooks.properties);
  for (const k of hbKeys) {
    const entry = (m.handbooks || {})[k];
    check(
      entry &&
        entry.path &&
        entry.binding_version &&
        entry.docs_url &&
        entry.api_ref_source,
      `handbook ${k} missing required fields`,
    );
    if (entry && entry.path) {
      check(
        fs.existsSync(path.join(distDir, entry.path)),
        `handbook ${k} path not in bundle: ${entry.path}`,
      );
    }
  }

  if (failures.length) {
    console.error('[spec:verify] FAIL — bundle drifts from contract:');
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }

  console.log(
    `[spec:verify] OK — spec ${m.spec_version} bundle coheres with the manifest contract`,
  );
  console.log(
    `[spec:verify] ${catKeys.length} categories + ${hbKeys.length} handbooks present; all referenced paths exist.`,
  );
  return 0;
}

process.exit(main());
