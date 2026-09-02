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
const BOUNDARY_REVIEWS = new Set(['candidate', 'complete', 'none']);
const BOUNDARY_DISPOSITIONS = new Set([
  'embedded-public-protocol',
  'repository-stable',
]);
const DEEP_IMPORT_POLICY = 'stable-entrypoints-with-exact-legacy-ratchet';
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

function repositoryPath(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function isSafeRepositoryPath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !path.posix.isAbsolute(value) &&
    !value.includes('\\') &&
    !value
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  );
}

function skipLineComment(source, index) {
  const end = source.indexOf('\n', index + 2);
  return end === -1 ? source.length : end;
}

function skipBlockComment(source, index) {
  const end = source.indexOf('*/', index + 2);
  return end === -1 ? source.length : end + 2;
}

function scanQuotedString(source, index) {
  const quote = source[index];
  let value = '';
  let cursor = index + 1;
  while (cursor < source.length && source[cursor] !== quote) {
    if (source[cursor] === '\\' && cursor + 1 < source.length) {
      value += source.slice(cursor, cursor + 2);
      cursor += 2;
    } else {
      value += source[cursor];
      cursor += 1;
    }
  }
  return { next: cursor + 1, token: { kind: 'string', value } };
}

function skipTemplateLiteral(source, index) {
  let cursor = index + 1;
  while (cursor < source.length) {
    if (source[cursor] === '\\') cursor += 2;
    else if (source[cursor] === '`') return cursor + 1;
    else cursor += 1;
  }
  return cursor;
}

function scanWord(source, index) {
  let cursor = index + 1;
  while (cursor < source.length && /[A-Za-z0-9_$]/u.test(source[cursor]))
    cursor += 1;
  return {
    next: cursor,
    token: { kind: 'word', value: source.slice(index, cursor) },
  };
}

function javascriptTokens(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/u.test(character)) index += 1;
    else if (source.startsWith('//', index))
      index = skipLineComment(source, index);
    else if (source.startsWith('/*', index))
      index = skipBlockComment(source, index);
    else if (character === '"' || character === "'") {
      const scanned = scanQuotedString(source, index);
      tokens.push(scanned.token);
      index = scanned.next;
    } else if (character === '`') index = skipTemplateLiteral(source, index);
    else if (/[A-Za-z_$]/u.test(character)) {
      const scanned = scanWord(source, index);
      tokens.push(scanned.token);
      index = scanned.next;
    } else {
      tokens.push({ kind: 'punctuation', value: character });
      index += 1;
    }
  }
  return tokens;
}

function callSpecifier(tokens, tokenIndex) {
  if (
    tokens[tokenIndex + 1]?.value === '(' &&
    tokens[tokenIndex + 2]?.kind === 'string'
  )
    return tokens[tokenIndex + 2].value;
  return '';
}

function fromSpecifier(tokens, tokenIndex) {
  for (let cursor = tokenIndex + 1; cursor < tokens.length; cursor += 1) {
    if (tokens[cursor].value === ';') return '';
    if (
      tokens[cursor].kind === 'word' &&
      tokens[cursor].value === 'from' &&
      tokens[cursor + 1]?.kind === 'string'
    )
      return tokens[cursor + 1].value;
  }
  return '';
}

function tokenSpecifier(tokens, tokenIndex) {
  const token = tokens[tokenIndex];
  if (token.kind !== 'word') return '';
  if (token.value === 'require') return callSpecifier(tokens, tokenIndex);
  if (token.value !== 'import' && token.value !== 'export') return '';
  return (
    callSpecifier(tokens, tokenIndex) ||
    (tokens[tokenIndex + 1]?.kind === 'string'
      ? tokens[tokenIndex + 1].value
      : fromSpecifier(tokens, tokenIndex))
  );
}

function importSpecifiers(source) {
  const tokens = javascriptTokens(source);
  const specifiers = [];
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const specifier = tokenSpecifier(tokens, tokenIndex);
    if (specifier) specifiers.push(specifier);
  }
  return specifiers.filter((specifier) => /^\.\.?\//u.test(specifier));
}

function completedBoundaries(root, manifest) {
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  return entries
    .filter((entry) => entry.boundaryReview === 'complete' && entry.boundary)
    .map((entry) => ({
      path: entry.path,
      root: path.resolve(root, entry.path),
      stableEntrypoints: new Set(entry.boundary.stableEntrypoints || []),
    }));
}

function importedBoundary(root, file, specifier, boundary) {
  const target = path.resolve(path.dirname(file), specifier);
  if (
    target !== boundary.root &&
    !target.startsWith(`${boundary.root}${path.sep}`)
  )
    return null;
  if (file === boundary.root || file.startsWith(`${boundary.root}${path.sep}`))
    return null;
  const targetPath = repositoryPath(root, target);
  return {
    importer: repositoryPath(root, file),
    target: targetPath,
    kind: boundary.stableEntrypoints.has(targetPath) ? 'stable' : 'deep',
  };
}

function sortBoundaryImports(imports) {
  for (const values of Object.values(imports))
    values.sort((left, right) => {
      const leftKey = `${left.importer}\0${left.target}`;
      const rightKey = `${right.importer}\0${right.target}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  return imports;
}

export function discoverBoundaryImports({ root = ROOT, manifest } = {}) {
  const boundaries = completedBoundaries(root, manifest);
  const imports = Object.fromEntries(
    boundaries.map((entry) => [entry.path, []]),
  );
  if (boundaries.length === 0) return imports;

  for (const file of sourceFiles(root)) {
    for (const specifier of importSpecifiers(fs.readFileSync(file, 'utf8'))) {
      for (const boundary of boundaries) {
        const imported = importedBoundary(root, file, specifier, boundary);
        if (imported) imports[boundary.path].push(imported);
      }
    }
  }
  return sortBoundaryImports(imports);
}

function boundaryCycles(entries) {
  const completed = new Set(
    entries
      .filter((entry) => entry.boundaryReview === 'complete')
      .map((entry) => entry.path),
  );
  const graph = new Map(
    entries
      .filter((entry) => completed.has(entry.path))
      .map((entry) => [
        entry.path,
        (entry.dependencies || []).filter((dependency) =>
          completed.has(dependency),
        ),
      ]),
  );
  const cycles = [];
  const visited = new Set();
  const active = [];
  const visit = (node) => {
    const activeIndex = active.indexOf(node);
    if (activeIndex !== -1) {
      cycles.push([...active.slice(activeIndex), node]);
      return;
    }
    if (visited.has(node)) return;
    active.push(node);
    for (const dependency of graph.get(node) || []) visit(dependency);
    active.pop();
    visited.add(node);
  };
  for (const node of [...graph.keys()].sort()) visit(node);
  return cycles;
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
    if (entry.boundaryReview === 'complete') {
      const boundary = entry.boundary;
      if (entry.distribution !== 'source-only')
        issues.push(
          issue(
            'boundary-distribution',
            `${entry.path} completed boundary must remain source-only`,
          ),
        );
      if (
        !boundary ||
        typeof boundary !== 'object' ||
        Array.isArray(boundary)
      ) {
        issues.push(
          issue(
            'boundary-missing',
            `${entry.path} completed boundary has no decision`,
          ),
        );
      } else {
        if (!BOUNDARY_DISPOSITIONS.has(boundary.disposition))
          issues.push(
            issue(
              'boundary-disposition',
              `${entry.path} has an invalid boundary disposition`,
            ),
          );
        if (boundary.deepImportPolicy !== DEEP_IMPORT_POLICY)
          issues.push(
            issue(
              'deep-import-policy',
              `${entry.path} must use ${DEEP_IMPORT_POLICY}`,
            ),
          );
        for (const field of ['stableEntrypoints', 'consumers']) {
          const values = Array.isArray(boundary[field]) ? boundary[field] : [];
          if (field === 'stableEntrypoints' && values.length === 0)
            issues.push(
              issue(
                'boundary-entrypoint',
                `${entry.path} must declare at least one stable entrypoint`,
              ),
            );
          if (
            !Array.isArray(boundary[field]) ||
            JSON.stringify(values) !==
              JSON.stringify([...new Set(values)].sort())
          )
            issues.push(
              issue(
                `boundary-${field === 'consumers' ? 'consumer' : 'entrypoint'}-order`,
                `${entry.path} ${field} must be unique and sorted`,
              ),
            );
          for (const value of values) {
            if (!isSafeRepositoryPath(value)) {
              issues.push(
                issue(
                  `boundary-${field === 'consumers' ? 'consumer' : 'entrypoint'}-path`,
                  `${entry.path} declares invalid ${field} path ${String(value)}`,
                ),
              );
              continue;
            }
            if (
              field === 'stableEntrypoints' &&
              value !== entry.path &&
              !value.startsWith(`${entry.path}/`)
            )
              issues.push(
                issue(
                  'boundary-entrypoint-scope',
                  `${entry.path} entrypoint is outside its boundary: ${value}`,
                ),
              );
            if (!fs.existsSync(path.join(root, value)))
              issues.push(
                issue(
                  `boundary-${field === 'consumers' ? 'consumer' : 'entrypoint'}-missing`,
                  `${entry.path} declares missing ${field} path ${value}`,
                ),
              );
          }
        }
        const legacy = Array.isArray(boundary.legacyDeepImports)
          ? boundary.legacyDeepImports
          : [];
        const legacyKeys = legacy.map(
          (entryValue) => `${entryValue?.importer}\0${entryValue?.target}`,
        );
        if (
          !Array.isArray(boundary.legacyDeepImports) ||
          JSON.stringify(legacyKeys) !==
            JSON.stringify([...new Set(legacyKeys)].sort())
        )
          issues.push(
            issue(
              'legacy-deep-import-order',
              `${entry.path} legacyDeepImports must be unique and sorted`,
            ),
          );
        for (const legacyImport of legacy) {
          if (
            !isSafeRepositoryPath(legacyImport?.importer) ||
            !isSafeRepositoryPath(legacyImport?.target)
          ) {
            issues.push(
              issue(
                'legacy-deep-import-path',
                `${entry.path} has an invalid legacy deep-import entry`,
              ),
            );
            continue;
          }
          if (!legacyImport.target.startsWith(`${entry.path}/`))
            issues.push(
              issue(
                'legacy-deep-import-scope',
                `${entry.path} legacy target is outside its boundary: ${legacyImport.target}`,
              ),
            );
          for (const field of ['importer', 'target']) {
            if (!fs.existsSync(path.join(root, legacyImport[field])))
              issues.push(
                issue(
                  'legacy-deep-import-missing',
                  `${entry.path} legacy ${field} is missing: ${legacyImport[field]}`,
                ),
              );
          }
        }
      }
    } else if (Object.hasOwn(entry, 'boundary')) {
      issues.push(
        issue(
          'boundary-unreviewed',
          `${entry.path} cannot declare a boundary before review is complete`,
        ),
      );
    }
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

  for (const cycle of boundaryCycles(entries))
    issues.push(
      issue(
        'boundary-cycle',
        `completed boundary dependency cycle: ${cycle.join(' -> ')}`,
      ),
    );

  const boundaryImports = discoverBoundaryImports({ root, manifest });
  for (const entry of entries.filter(
    (candidate) =>
      candidate.boundaryReview === 'complete' && candidate.boundary,
  )) {
    const actual = boundaryImports[entry.path] || [];
    const duplicateKeys = actual
      .map((value) => `${value.importer}\0${value.target}`)
      .filter((value, index, values) => values.indexOf(value) !== index);
    if (duplicateKeys.length)
      issues.push(
        issue(
          'deep-import-duplicate',
          `${entry.path} has duplicate static imports: ${[...new Set(duplicateKeys)].join(', ')}`,
        ),
      );
    for (const imported of actual) {
      if (
        !(entry.boundary.consumers || []).some(
          (consumer) =>
            imported.importer === consumer ||
            imported.importer.startsWith(`${consumer}/`),
        )
      )
        issues.push(
          issue(
            'boundary-consumer-drift',
            `${entry.path} has undeclared consumer ${imported.importer}`,
          ),
        );
    }
    const actualDeep = actual
      .filter((value) => value.kind === 'deep')
      .map(({ importer, target }) => ({ importer, target }));
    const declaredDeep = Array.isArray(entry.boundary.legacyDeepImports)
      ? entry.boundary.legacyDeepImports
      : [];
    if (JSON.stringify(actualDeep) !== JSON.stringify(declaredDeep))
      issues.push(
        issue(
          'legacy-deep-import-drift',
          `${entry.path} legacy deep imports declared=${JSON.stringify(declaredDeep)} discovered=${JSON.stringify(actualDeep)}`,
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

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.includes('--print-boundary-imports')) {
    const manifest = readJson(ROOT, MANIFEST_PATH);
    console.log(JSON.stringify(discoverBoundaryImports({ manifest }), null, 2));
  } else main();
}
