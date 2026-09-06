#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// Offline installation of the two workspace packages needed before the full
// toolchain is available. Node still enforces each package's exports; this does
// not register a resolver hook, execute package scripts, or fetch dependencies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const PROOF_BOOTSTRAP_PACKAGES = {
  '@kungfu-tech/product-kungfu': 'product',
  '@kungfu-tech/spec': 'framework/spec',
};

export function installProofBootstrapPackages(root = ROOT) {
  const readManifest = (directory) =>
    JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const manifest = readManifest(root);
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };
  for (const [name, directory] of Object.entries(PROOF_BOOTSTRAP_PACKAGES)) {
    assert.equal(
      dependencies[name],
      'workspace:*',
      `Bootstrap requires a declared workspace dependency: ${name}`,
    );
    const provider = path.join(root, directory);
    assert.equal(
      readManifest(provider).name,
      name,
      `Bootstrap package identity: ${directory}`,
    );
    const destination = path.join(root, 'node_modules', name);
    if (fs.existsSync(destination)) {
      assert.equal(
        fs.realpathSync(destination),
        fs.realpathSync(provider),
        `Refusing to replace an existing package: ${name}`,
      );
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(
      process.platform === 'win32'
        ? provider
        : path.relative(path.dirname(destination), provider),
      destination,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  installProofBootstrapPackages();
  console.log(
    'Installed declared proof bootstrap workspace packages (offline)',
  );
}
