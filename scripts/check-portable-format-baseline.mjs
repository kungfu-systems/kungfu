#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Fail-closed gate for the append-only pre-stable v4 format baseline.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { contentRoot } from './check-format-migration-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE_INDEX_PATH =
  'framework/spec/format/compatibility/v4-alpha/index.json';
const MIGRATION_PATH =
  'framework/spec/format/kungfu-format-migration.contract.json';

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function byteRoot(file) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex')}`;
}

export function checkPortableFormatBaseline(root = ROOT) {
  const index = readJson(root, BASELINE_INDEX_PATH);
  assert.equal(index.schema, 'kungfu.portable-format-v4-alpha-index/v1');
  assert.equal(index.formatLine, 'v4-alpha');
  assert.ok(index.releases.length > 0, 'v4 alpha baseline is empty');
  const seenIds = new Set();
  let previousRoot = '';
  let previousRelease = null;
  let latest = null;
  for (const entry of index.releases) {
    assert.equal(
      seenIds.has(entry.id),
      false,
      `duplicate release: ${entry.id}`,
    );
    seenIds.add(entry.id);
    assert.equal(
      entry.previousReleaseRoot,
      previousRoot,
      `${entry.id}: index predecessor drift`,
    );
    const releasePath = path.posix.join(
      path.posix.dirname(BASELINE_INDEX_PATH),
      entry.path,
    );
    const release = readJson(root, releasePath);
    const releaseRoot = contentRoot(release);
    assert.equal(release.releaseId, entry.id, `${entry.id}: identity drift`);
    assert.equal(release.formatLine, 'v4-alpha', `${entry.id}: line drift`);
    assert.equal(
      release.previousReleaseRoot,
      previousRoot,
      `${entry.id}: predecessor drift`,
    );
    assert.equal(releaseRoot, entry.root, `${entry.id}: release root drift`);
    const bindings = new Map(
      release.sourceBindings.map((binding) => [binding.path, binding.root]),
    );
    assert.equal(
      bindings.size,
      release.sourceBindings.length,
      `${entry.id}: duplicate source binding`,
    );
    for (const binding of release.sourceBindings) {
      assert.match(binding.root, /^sha256:[0-9a-f]{64}$/u);
      assert.ok(binding.axis, `${entry.id}: source binding axis is missing`);
    }
    if (previousRelease) {
      const previousBindings = new Map(
        previousRelease.sourceBindings.map((binding) => [
          binding.path,
          binding.root,
        ]),
      );
      const changed = [
        ...new Set([...bindings.keys(), ...previousBindings.keys()]),
      ]
        .filter(
          (source) => bindings.get(source) !== previousBindings.get(source),
        )
        .sort();
      const declared = release.changesFromPrevious
        .map((change) => change.path)
        .sort();
      assert.deepEqual(
        declared,
        changed,
        `${entry.id}: changed authorities lack an explicit successor declaration`,
      );
    } else {
      assert.deepEqual(release.changesFromPrevious, []);
    }
    previousRelease = release;
    previousRoot = releaseRoot;
    if (entry.id === index.latestRelease)
      latest = { entry, release, releaseRoot };
  }
  assert.ok(latest, 'latest v4 alpha release is absent');
  assert.equal(index.latestReleaseRoot, latest.releaseRoot);
  assert.equal(index.latestRelease, index.releases.at(-1).id);
  const migration = readJson(root, MIGRATION_PATH);
  assert.deepEqual(
    latest.release.compatibilityTuple,
    migration.currentTuple,
    'current compatibility tuple has no successor baseline',
  );
  for (const binding of latest.release.sourceBindings) {
    const source = path.join(root, binding.path);
    assert.ok(
      fs.existsSync(source),
      `baseline source is missing: ${binding.path}`,
    );
    assert.equal(
      byteRoot(source),
      binding.root,
      `${binding.path}: current authority changed without a successor baseline`,
    );
  }
  return {
    index: BASELINE_INDEX_PATH,
    release: latest.entry.id,
    releaseRoot: latest.releaseRoot,
    sources: latest.release.sourceBindings.length,
  };
}

function main() {
  const result = checkPortableFormatBaseline();
  console.log(
    `[portable-format-baseline] release=${result.release} root=${result.releaseRoot} sources=${result.sources}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try {
    main();
  } catch (error) {
    console.error(
      `[portable-format-baseline] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
