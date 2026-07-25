#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function isTrackedTest(relative) {
  return (
    relative.endsWith('.test.mjs') || /(?:^|\/)test_[^/]+\.py$/.test(relative)
  );
}

function isRunnerSource(relative) {
  return (
    relative === 'scripts/check.mjs' ||
    relative === 'scripts/source-acceptance.mjs' ||
    relative === 'crates/xinfa/tooling/task.mjs' ||
    /^scripts\/run[^/]*\.mjs$/.test(relative) ||
    /^tests\/fixtures\/.*\/run\.mjs$/.test(relative) ||
    /^tests\/qualification\/.*\/run\.mjs$/.test(relative) ||
    /^framework\/core\/tests\/qualification\/.*\/run\.mjs$/.test(relative) ||
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(relative)
  );
}

function includesPath(source, candidate) {
  if (!candidate || candidate === '.') return false;
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_.-])${escaped}($|[^A-Za-z0-9_.-])`).test(
    source,
  );
}

function commandCoversTest(command, packageDir, testPath, basenameIsUnique) {
  const relative = path.posix.relative(packageDir || '.', testPath);
  const basename = path.posix.basename(testPath);
  if (
    includesPath(command, testPath) ||
    (relative !== basename && includesPath(command, relative)) ||
    (basenameIsUnique && includesPath(command, basename))
  )
    return true;

  const directory = path.posix.dirname(relative);
  if (
    testPath.endsWith('.test.mjs') &&
    includesPath(command, `${directory}/*.test.mjs`)
  )
    return true;

  return (
    /(?:^|\s)pytest(?:\s|$)/.test(command) &&
    testPath.endsWith('.py') &&
    directory !== '.' &&
    includesPath(command, directory)
  );
}

function runnerCoversTest(text, testPath, basenameIsUnique) {
  const explicitPaths = [];
  for (const match of text.matchAll(/path\.join\(([\s\S]*?)\)/g)) {
    const argumentsList = match[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (
      argumentsList.length > 0 &&
      argumentsList.every((part) => /^(['"])[^'"]+\1$/.test(part))
    ) {
      explicitPaths.push(
        argumentsList.map((part) => part.slice(1, -1)).join('/'),
      );
    }
  }
  const searchable = `${text}\n${explicitPaths.join('\n')}`;
  return (
    includesPath(searchable, testPath) ||
    (basenameIsUnique &&
      includesPath(searchable, path.posix.basename(testPath)))
  );
}

/**
 * @param {{
 *   trackedFiles: string[],
 *   packageScripts: {path: string, scripts: Record<string, string>}[],
 *   runnerSources: {path: string, text: string}[],
 * }} input
 */
export function inspectTestManifest(input) {
  const tests = input.trackedFiles.filter(isTrackedTest).sort();
  const registrations = new Map();
  const basenameCounts = new Map();
  for (const testPath of tests) {
    const basename = path.posix.basename(testPath);
    basenameCounts.set(basename, (basenameCounts.get(basename) || 0) + 1);
  }

  for (const testPath of tests) {
    const basename = path.posix.basename(testPath);
    const basenameIsUnique = basenameCounts.get(basename) === 1;
    const sources = [];
    for (const pkg of input.packageScripts) {
      const packageDir = path.posix.dirname(pkg.path);
      for (const [name, command] of Object.entries(pkg.scripts || {})) {
        if (commandCoversTest(command, packageDir, testPath, basenameIsUnique))
          sources.push(`${pkg.path}#scripts.${name}`);
      }
    }
    for (const runner of input.runnerSources) {
      if (runnerCoversTest(runner.text, testPath, basenameIsUnique))
        sources.push(runner.path);
    }
    registrations.set(testPath, [...new Set(sources)].sort());
  }

  return {
    tests,
    registrations,
    missing: tests.filter(
      (testPath) => (registrations.get(testPath) || []).length === 0,
    ),
  };
}

function manifestFiles(root) {
  // Include index entries plus non-ignored worktree additions. This makes the
  // gate fail closed both before and during pre-commit instead of hiding a new
  // test until its first commit.
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
    .split(/\r?\n/)
    .filter(Boolean);
}

function inspectRepository(root = ROOT) {
  const tracked = manifestFiles(root);
  const packageScripts = tracked
    .filter(
      (relative) =>
        relative === 'package.json' || relative.endsWith('/package.json'),
    )
    .map((relative) => ({
      path: relative,
      scripts: JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'))
        .scripts,
    }));
  const runnerSources = tracked.filter(isRunnerSource).map((relative) => ({
    path: relative,
    text: fs.readFileSync(path.join(root, relative), 'utf8'),
  }));
  return inspectTestManifest({
    trackedFiles: tracked,
    packageScripts,
    runnerSources,
  });
}

function main() {
  const result = inspectRepository();
  if (result.missing.length > 0) {
    console.error(
      `[test-manifest] ${result.missing.length} repository test(s) have no package-script or runner registration:`,
    );
    for (const relative of result.missing) console.error(`  ${relative}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `[test-manifest] ${result.tests.length} repository tests are registered`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
