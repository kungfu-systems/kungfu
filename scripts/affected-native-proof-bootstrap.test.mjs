// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ONLY_CLOSURE = [
  'scripts/affected-native-proof.mjs',
  'scripts/dev-delivery-warrant-input.mjs',
  'scripts/project-cut-family-queue-lease.mjs',
  'product/release/affected-native-artifact-lookup.mjs',
  'product/release/affected-native-proof-cli.mjs',
  'framework/spec/format/project-cut-canonical-json.mjs',
];

function copySourceOnlyClosure(destination, omitted = '') {
  for (const relativePath of SOURCE_ONLY_CLOSURE) {
    if (relativePath === omitted) continue;
    const output = path.join(destination, relativePath);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relativePath), output);
  }
}

test('affected-native Warrant bootstrap loads from its source-only closure', async (t) => {
  const destination = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-warrant-bootstrap-'),
  );
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  copySourceOnlyClosure(destination);
  assert.equal(fs.existsSync(path.join(destination, 'node_modules')), false);
  await import(
    `${pathToFileURL(path.join(destination, 'scripts/dev-delivery-warrant-input.mjs')).href}?complete`
  );
});

test('affected-native Warrant bootstrap fails when its source closure is incomplete', async (t) => {
  const destination = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-warrant-bootstrap-missing-'),
  );
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  copySourceOnlyClosure(
    destination,
    'scripts/project-cut-family-queue-lease.mjs',
  );
  await assert.rejects(
    import(
      `${pathToFileURL(path.join(destination, 'scripts/dev-delivery-warrant-input.mjs')).href}?missing`
    ),
    (error) =>
      error?.code === 'ERR_MODULE_NOT_FOUND' &&
      String(error.message).includes('project-cut-family-queue-lease.mjs'),
  );
});

test('protected Project Cut replay materializes its declared Work dependency closure', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/dev-pr-auto-merge.yml'),
    'utf8',
  );
  assert.match(
    workflow,
    /name: Check out protected consumer adapter[\s\S]*name: Install protected Work consumer dependencies[\s\S]*corepack pnpm install --filter '@kungfu-tech\/work\.\.\.' --prod --frozen-lockfile --ignore-scripts[\s\S]*name: Produce exact Project Cut replay proof/u,
  );
});

test('protected Warrant binds repository authority to the PR base for fork heads', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/dev-pr-auto-merge.yml'),
    'utf8',
  );
  assert.match(
    workflow,
    /test "\$GITHUB_REPOSITORY" = "\$\(jq -r '\.base\.repo\.full_name' "\$pull_request"\)"/u,
  );
  assert.match(
    workflow,
    /'\.base\.repo\.full_name == \$repository[\s\S]*and \.head\.sha == \$head/u,
  );
  assert.doesNotMatch(workflow, /\.head\.repo\.full_name == \$repository/u);
});
