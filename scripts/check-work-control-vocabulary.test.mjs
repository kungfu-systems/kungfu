#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY_PATH = path.join(
  ROOT,
  'config',
  'work-control-naming-boundary.json',
);
const LEGACY = /Mission Control|mission-control|kungfu\.mission-control/u;
const NATIVE_FILES = [
  'extensions/work-control/profile.json',
  'extensions/work-control/actions/registry.json',
  'extensions/work-control/assessments/policies.json',
  'extensions/work-control/claims/claims.json',
  'extensions/work-control/collaboration/interface.json',
  'extensions/work-control/reducers/five-questions.json',
  'extensions/work-control/views/registry.json',
  'extensions/work-dashboard/src/view/agent-console-launch.ts',
  'extensions/work-dashboard/src/view/index.tsx',
  'extensions/work-dashboard/src/view/profile-setup.ts',
  'framework/core/src/python/kungfu/agent/action_loop.py',
  'framework/core/src/python/kungfu/assignment_orchestration.py',
  'framework/core/src/python/kungfu/cli/commands/assignment.py',
  'framework/work-lifecycle/kungfu-work-lifecycle-operation-matrix.contract.json',
  'framework/tui/src/work-control-contribution.ts',
];
const FORBIDDEN = /\bMission\b|\bGo\b|kungfu\.mission-control|mission-control/u;
const EXPLICIT_BOUNDARY = /\blegacy\b|\bcompatibility\b|\bAtlas\b|\batlas\b/u;
const PHYSICAL_COMPATIBILITY_PATH =
  /extensions\/mission-control|"extensions"\s*\/\s*"mission-control"|work-control-actions|\.\/mission-control-profile/u;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function trackedFiles() {
  const result = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (result.status !== 0)
    throw new Error(`git ls-files failed: ${result.stderr.trim()}`);
  return result.stdout.split('\n').filter(Boolean);
}

function classificationFor(relative, inventory) {
  return inventory.classifications.find(
    (entry) =>
      (entry.files ?? []).includes(relative) ||
      (entry.prefixes ?? []).some((prefix) => relative.startsWith(prefix)),
  );
}

function sourceOccurrences(inventory) {
  const occurrences = [];
  for (const relative of trackedFiles()) {
    const full = path.join(ROOT, relative);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
    const bytes = fs.readFileSync(full);
    if (bytes.includes(0)) continue;
    const source = bytes.toString('utf8');
    source.split('\n').forEach((line, index) => {
      if (LEGACY.test(line)) {
        occurrences.push({
          path: relative,
          line: index + 1,
          classification: classificationFor(relative, inventory)?.id ?? '',
        });
      }
    });
    if (LEGACY.test(relative) && !LEGACY.test(source)) {
      occurrences.push({
        path: relative,
        line: 0,
        classification: classificationFor(relative, inventory)?.id ?? '',
      });
    }
  }
  return occurrences;
}

function validatePackages(inventory) {
  const names = [];
  for (const relative of trackedFiles().filter((item) =>
    item.endsWith('package.json'),
  )) {
    const value = readJson(path.join(ROOT, relative));
    if (String(value.name ?? '').includes('work-control'))
      names.push(value.name);
    if (LEGACY.test(String(value.name ?? '')))
      throw new Error(`legacy npm package identity: ${relative}`);
  }
  const actual = [...new Set(names)].sort();
  const expected = [...inventory.requiredNpmPackages].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Work Control npm identities differ: ${JSON.stringify(actual)}`,
    );
  }
}

function validateCurrentDiscovery(inventory) {
  const profile = readJson(
    path.join(ROOT, 'extensions', 'work-control', 'profile.json'),
  );
  if (
    profile.id !== inventory.canonical.profileId ||
    profile.title !== inventory.canonical.name
  )
    throw new Error('Work Control Profile identity drifted');

  for (const relative of [
    'framework/core/src/python/kungfu/agent/commands.json',
    'framework/core/src/python/kungfu/agent/kfd3_api.registry.json',
  ]) {
    if (LEGACY.test(fs.readFileSync(path.join(ROOT, relative), 'utf8')))
      throw new Error(
        `legacy vocabulary remains in Agent discovery: ${relative}`,
      );
  }

  const catalog = readJson(
    path.join(
      ROOT,
      'framework',
      'core',
      'src',
      'python',
      'kungfu',
      'agent',
      'cli_surface.catalog.json',
    ),
  );
  const compatibilityRows = (catalog.surfaces ?? []).filter((row) =>
    LEGACY.test(String(row.canonical_path ?? '')),
  );
  if (!compatibilityRows.length)
    throw new Error('hidden v3 CLI compatibility reader is missing');
  for (const row of compatibilityRows) {
    if (
      row.visibility !== 'hidden-internal' ||
      (row.kfd3_api_ids ?? []).length !== 0
    )
      throw new Error(
        `legacy CLI row is discoverable or owns KFD identity: ${row.canonical_path}`,
      );
  }
  const group = compatibilityRows.find(
    (row) => row.canonical_path === 'kungfu profile mission-control',
  );
  if (!group || !/replacement: kungfu work/u.test(group.summary ?? ''))
    throw new Error(
      'legacy CLI alias does not report its Work Control replacement',
    );
}

function walkFiles(root) {
  const result = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) result.push(full);
    }
  };
  visit(root);
  return result;
}

function validateProduct(root, inventory) {
  const issues = [];
  for (const file of walkFiles(root)) {
    const relative = `/${path.relative(root, file).split(path.sep).join('/')}`;
    const bytes = fs.readFileSync(file);
    if (bytes.includes(0)) continue;
    if (!LEGACY.test(bytes.toString('utf8')) && !LEGACY.test(relative))
      continue;
    if (
      !inventory.productCompatibilitySuffixes.some((part) =>
        relative.includes(part),
      )
    )
      issues.push(relative);
  }
  if (issues.length)
    throw new Error(
      `unclassified installed-product legacy vocabulary:\n${issues.join('\n')}`,
    );
}

function checkSource(productRoot = '') {
  const inventory = readJson(INVENTORY_PATH);
  validatePackages(inventory);
  validateCurrentDiscovery(inventory);
  const occurrences = sourceOccurrences(inventory);
  const unclassified = occurrences.filter((item) => !item.classification);
  if (unclassified.length) {
    throw new Error(
      `unclassified legacy vocabulary:\n${unclassified
        .map((item) => `${item.path}:${item.line}`)
        .join('\n')}`,
    );
  }
  if (productRoot) validateProduct(path.resolve(productRoot), inventory);
  return {
    schema: 'kungfu.work-control-naming-check/v1',
    canonicalProfileId: inventory.canonical.profileId,
    occurrenceCount: occurrences.length,
    classifications: Object.fromEntries(
      inventory.classifications.map((entry) => [
        entry.id,
        occurrences.filter((item) => item.classification === entry.id).length,
      ]),
    ),
    productRoot: productRoot ? path.resolve(productRoot) : undefined,
    ok: true,
  };
}

function auditWorkControlVocabulary(root = ROOT) {
  const issues = [];
  for (const relative of NATIVE_FILES) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    source.split('\n').forEach((line, index) => {
      if (
        FORBIDDEN.test(line) &&
        !EXPLICIT_BOUNDARY.test(line) &&
        !PHYSICAL_COMPATIBILITY_PATH.test(line)
      )
        issues.push(`${relative}:${index + 1}: ${line.trim()}`);
    });
  }

  const commands = readJson(
    path.join(root, 'framework/core/src/python/kungfu/agent/commands.json'),
  );
  for (const command of commands.commands ?? []) {
    if (
      /^(?:kungfu work|kungfu profile work-control)(?:\s|$)/u.test(
        command.name ?? '',
      ) &&
      FORBIDDEN.test(JSON.stringify(command))
    )
      issues.push(
        `framework/core/src/python/kungfu/agent/commands.json: native command ${command.name}`,
      );
  }
  return issues;
}

test('native Work Control surfaces do not leak Atlas workflow vocabulary', () => {
  assert.deepEqual(auditWorkControlVocabulary(), []);
});

test('all retained Mission Control vocabulary is classified and non-discoverable', () => {
  const productIndex = process.argv.indexOf('--product-root');
  const report = checkSource(
    productIndex === -1 ? '' : String(process.argv[productIndex + 1] ?? ''),
  );
  assert.equal(report.ok, true);
  assert.equal(report.canonicalProfileId, 'kungfu.work-control');
  assert.ok(report.occurrenceCount > 0);
  assert.ok(report.classifications['explicit-compatibility'] > 0);
  assert.ok(report.classifications['immutable-history'] > 0);
  process.stdout.write(`${JSON.stringify(report)}\n`);
});
