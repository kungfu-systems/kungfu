#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = 'framework/layout.manifest.json';
const RELEASE_REGISTRY_PATH = 'framework/release/npm-package-registry.json';
const SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);
const IGNORED_DIRECTORIES = new Set([
  '.cache',
  '.git',
  '.kungfu',
  '.xinfa',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);
const DISTRIBUTIONS = new Set(['npm-package', 'source-only']);
const ROLES = new Set([
  'contract-root',
  'internal-library',
  'repository-tool',
  'runtime-package',
]);
const BOUNDARY_REVIEWS = new Set(['candidate', 'none']);
const RELATIVE_LITERAL = /(['"`])(\.\.?\/[^'"`\r\n\\]+)\1/gu;

function issue(code, message) {
  return { code, message };
}

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function immediateFrameworkDirectories(root) {
  const frameworkRoot = path.join(root, 'framework');
  return fs
    .readdirSync(frameworkRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `framework/${entry.name}`)
    .sort();
}

function sourceFiles(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(path.extname(entry.name))
      )
        files.push(target);
    }
  };
  visit(directory);
  return files.sort();
}

export function discoverFrameworkDependencies({ root = ROOT } = {}) {
  const frameworkRoot = path.join(root, 'framework');
  const directories = immediateFrameworkDirectories(root);
  const known = new Set(directories);
  const dependencies = new Map(
    directories.map((directory) => [directory, new Set()]),
  );

  for (const directory of directories) {
    const ownerRoot = path.join(root, directory);
    for (const file of sourceFiles(ownerRoot)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(RELATIVE_LITERAL)) {
        const target = path.resolve(path.dirname(file), match[2]);
        const relative = path.relative(frameworkRoot, target);
        if (
          !relative ||
          relative === '..' ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        )
          continue;
        const targetDirectory = `framework/${relative.split(path.sep)[0]}`;
        if (targetDirectory !== directory && known.has(targetDirectory))
          dependencies.get(directory).add(targetDirectory);
      }
    }
  }

  return Object.fromEntries(
    [...dependencies.entries()].map(([directory, values]) => [
      directory,
      [...values].sort(),
    ]),
  );
}

export function collectFrameworkLayoutIssues({
  root = ROOT,
  manifest = readJson(root, MANIFEST_PATH),
  releaseRegistry = readJson(root, RELEASE_REGISTRY_PATH),
} = {}) {
  const issues = [];
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const entryPaths = entries.map((entry) => entry.path);
  const actualDirectories = immediateFrameworkDirectories(root);

  if (manifest.schema !== 'kungfu.framework-layout-manifest/v1')
    issues.push(issue('schema', 'unexpected framework layout manifest schema'));
  if (manifest.frameworkRoot !== 'framework')
    issues.push(issue('framework-root', 'frameworkRoot must be framework'));
  if (manifest.releaseRegistry !== RELEASE_REGISTRY_PATH)
    issues.push(
      issue(
        'release-registry',
        `releaseRegistry must reference ${RELEASE_REGISTRY_PATH}`,
      ),
    );
  if (new Set(entryPaths).size !== entryPaths.length)
    issues.push(
      issue('duplicate-path', 'framework entries contain duplicate paths'),
    );
  if (JSON.stringify(entryPaths) !== JSON.stringify([...entryPaths].sort()))
    issues.push(
      issue('path-order', 'framework entries must be sorted by path'),
    );

  const missing = actualDirectories.filter(
    (entry) => !entryPaths.includes(entry),
  );
  const stale = entryPaths.filter(
    (entry) => !actualDirectories.includes(entry),
  );
  if (missing.length)
    issues.push(
      issue(
        'directory-missing',
        `unclassified directories: ${missing.join(', ')}`,
      ),
    );
  if (stale.length)
    issues.push(
      issue('directory-stale', `stale directory entries: ${stale.join(', ')}`),
    );

  const knownPaths = new Set(entryPaths);
  for (const entry of entries) {
    if (!DISTRIBUTIONS.has(entry.distribution))
      issues.push(
        issue(
          'distribution',
          `${entry.path || '<unknown>'} has an invalid distribution`,
        ),
      );
    if (!ROLES.has(entry.role))
      issues.push(
        issue('role', `${entry.path || '<unknown>'} has an invalid role`),
      );
    if (!BOUNDARY_REVIEWS.has(entry.boundaryReview))
      issues.push(
        issue(
          'boundary-review',
          `${entry.path || '<unknown>'} has an invalid boundaryReview`,
        ),
      );
    const declaredDependencies = Array.isArray(entry.dependencies)
      ? entry.dependencies
      : [];
    if (
      JSON.stringify(declaredDependencies) !==
      JSON.stringify([...new Set(declaredDependencies)].sort())
    )
      issues.push(
        issue(
          'dependency-order',
          `${entry.path || '<unknown>'} dependencies must be unique and sorted`,
        ),
      );
    for (const dependency of declaredDependencies) {
      if (!knownPaths.has(dependency))
        issues.push(
          issue(
            'dependency-unknown',
            `${entry.path} declares unknown dependency ${dependency}`,
          ),
        );
      if (dependency === entry.path)
        issues.push(
          issue('dependency-self', `${entry.path} cannot depend on itself`),
        );
    }

    if (typeof entry.path !== 'string') continue;
    const packagePath = path.join(root, entry.path, 'package.json');
    const hasPackage = fs.existsSync(packagePath);
    if (entry.distribution === 'npm-package') {
      if (!hasPackage) {
        issues.push(
          issue('package-missing', `${entry.path} has no package.json`),
        );
        continue;
      }
      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      if (packageJson.name !== entry.packageName)
        issues.push(
          issue(
            'package-name',
            `${entry.path} package name ${packageJson.name || '<missing>'} does not match ${entry.packageName || '<missing>'}`,
          ),
        );
    } else {
      if (hasPackage)
        issues.push(
          issue(
            'source-only-package',
            `${entry.path} is source-only but contains package.json`,
          ),
        );
      if (Object.hasOwn(entry, 'packageName'))
        issues.push(
          issue(
            'source-only-name',
            `${entry.path} is source-only and must not declare packageName`,
          ),
        );
    }
  }

  const registeredFrameworkPackages = (releaseRegistry.packages || [])
    .filter(
      (entry) =>
        entry.kind === 'workspace' &&
        /^framework\/[^/]+\/package\.json$/u.test(entry.source || ''),
    )
    .map((entry) => ({
      name: entry.name,
      path: path.posix.dirname(entry.source),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const declaredFrameworkPackages = entries
    .filter((entry) => entry.distribution === 'npm-package')
    .map((entry) => ({ name: entry.packageName, path: entry.path }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (
    JSON.stringify(registeredFrameworkPackages) !==
    JSON.stringify(declaredFrameworkPackages)
  )
    issues.push(
      issue(
        'release-package-drift',
        'framework npm-package entries must exactly match workspace sources in the npm release registry',
      ),
    );

  const discovered = discoverFrameworkDependencies({ root });
  for (const entry of entries) {
    if (typeof entry.path !== 'string') continue;
    const declared = Array.isArray(entry.dependencies)
      ? entry.dependencies
      : [];
    const actual = discovered[entry.path] || [];
    if (JSON.stringify(declared) !== JSON.stringify(actual))
      issues.push(
        issue(
          'dependency-drift',
          `${entry.path} dependencies declared=${JSON.stringify(declared)} discovered=${JSON.stringify(actual)}`,
        ),
      );
  }

  return issues;
}

export function validateFrameworkLayout(options = {}) {
  const issues = collectFrameworkLayoutIssues(options);
  return { ok: issues.length === 0, issues };
}

function main() {
  if (process.argv.includes('--print-dependencies')) {
    console.log(JSON.stringify(discoverFrameworkDependencies(), null, 2));
    return;
  }
  const manifest = readJson(ROOT, MANIFEST_PATH);
  const result = validateFrameworkLayout({ root: ROOT, manifest });
  if (!result.ok) {
    for (const entry of result.issues)
      console.error(`[framework-layout:${entry.code}] ${entry.message}`);
    process.exitCode = 1;
    return;
  }
  const npmPackageCount = manifest.entries.filter(
    (entry) => entry.distribution === 'npm-package',
  ).length;
  const sourceOnlyCount = manifest.entries.filter(
    (entry) => entry.distribution === 'source-only',
  ).length;
  const edgeCount = manifest.entries.reduce(
    (total, entry) => total + entry.dependencies.length,
    0,
  );
  console.log(
    `framework layout passed: ${manifest.entries.length} directories, ${npmPackageCount} npm packages, ${sourceOnlyCount} source-only roots, ${edgeCount} cross-directory dependencies`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
