'use strict';

// @kungfu-tech/spec — programmatic entry.
//
// The bundle's authoritative payload is a set of files (manifest.json + the six
// categories + three handbooks); this module only exposes stable locators so a
// consumer can find the contract and, once built, the generated manifest.

const path = require('path');

const pkgRoot = __dirname;

// The manifest contract (the two-repo connection protocol). Always present.
const manifestSchemaPath = path.join(pkgRoot, 'schema', 'manifest.schema.json');

// The generated manifest for the published bundle. Present only after build.
const manifestPath = path.join(pkgRoot, 'dist', 'manifest.json');

module.exports = {
  manifestSchemaPath,
  manifestPath,
};
