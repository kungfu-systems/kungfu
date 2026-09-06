#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parse } from 'yaml';
import {
  moduleReferences,
  pythonPackageReferences,
  workflowCommands,
} from './package-boundary-references.mjs';
export { moduleReferences } from './package-boundary-references.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE = /\.(?:[cm]?[jt]sx?|py)$/u;
const SKIP = new Set([
  '.git',
  '.kungfu',
  '.xinfa',
  'node_modules',
  'dist',
  'build',
  'out',
  '.cache',
  'coverage',
  '__pycache__',
  'target',
]);

function inside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

export function workspacePackages(root) {
  const config = parse(
    fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'),
  );
  const directories = new Set(['.']);
  for (const pattern of config.packages) {
    if (pattern.startsWith('!'))
      throw new Error(
        'Package boundary discovery requires explicit positive workspace patterns',
      );
    for (const directory of fs.globSync(pattern, { cwd: root }))
      directories.add(directory);
  }
  return [...directories].sort().flatMap((directory) => {
    const absolute = path.resolve(root, directory);
    const manifest = path.join(absolute, 'package.json');
    if (!fs.existsSync(manifest)) return [];
    return [
      {
        directory,
        absolute,
        manifest: JSON.parse(fs.readFileSync(manifest, 'utf8')),
      },
    ];
  });
}

function ownerOf(packages, file) {
  return packages
    .filter((pkg) => inside(pkg.absolute, file))
    .sort((a, b) => b.absolute.length - a.absolute.length)[0];
}

function sourceFiles(root, packages) {
  const files = [];
  function visit(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (SKIP.has(item.name)) continue;
      const target = path.join(directory, item.name);
      if (item.isDirectory()) visit(target);
      else if (
        item.isFile() &&
        (SOURCE.test(item.name) ||
          /^tsconfig.*\.json$/u.test(item.name) ||
          (target.startsWith(path.join(root, '.github')) &&
            /\.ya?ml$/u.test(item.name)))
      )
        files.push(target);
    }
  }
  for (const directory of [
    '.github',
    'framework',
    'developer',
    'extensions',
    'product',
    'examples',
    'scripts',
    'tests',
    'crates',
    ...packages
      .map((pkg) => pkg.directory)
      .filter((directory) => directory !== '.'),
  ]) {
    const absolute = path.join(root, directory);
    if (fs.existsSync(absolute)) visit(absolute);
  }
  for (const item of fs.readdirSync(root)) {
    if (SOURCE.test(item) || /^tsconfig.*\.json$/u.test(item))
      files.push(path.join(root, item));
  }
  return [...new Set(files)].sort();
}

function exportTargets(value) {
  if (typeof value === 'string') return [value];
  if (value === null) return [];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (typeof value === 'object')
    return Object.values(value).flatMap(exportTargets);
  return [];
}

export function publicTargets(pkg, subpath) {
  const exports = pkg.manifest.exports;
  if (exports === undefined) {
    // Legacy main is a public root. Deep imports require an explicit export.
    return subpath === '.' && pkg.manifest.main ? [pkg.manifest.main] : [];
  }
  if (typeof exports === 'string' || exports === null || Array.isArray(exports))
    return subpath === '.' ? exportTargets(exports) : [];
  if (Object.keys(exports).every((key) => !key.startsWith('.')))
    return subpath === '.' ? exportTargets(exports) : [];
  if (Object.hasOwn(exports, subpath)) return exportTargets(exports[subpath]);
  const patterns = Object.keys(exports)
    .filter((key) => key.includes('*'))
    .sort((a, b) => b.indexOf('*') - a.indexOf('*') || b.length - a.length);
  for (const pattern of patterns) {
    const [start, end] = pattern.split('*');
    if (subpath.startsWith(start) && subpath.endsWith(end)) {
      const middle = subpath.slice(
        start.length,
        subpath.length - end.length || undefined,
      );
      return exportTargets(exports[pattern]).map((target) =>
        target.replaceAll('*', middle),
      );
    }
  }
  return [];
}

function packageName(specifier) {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
}

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
function report(context, code, file, reference, message) {
  context.issues.push({
    code,
    file: path.relative(context.root, file).split(path.sep).join('/'),
    line: reference.line,
    specifier: reference.specifier,
    message,
  });
}
function declared(owner, name) {
  return DEPENDENCY_SECTIONS.some((section) =>
    Object.hasOwn(owner.manifest[section] || {}, name),
  );
}
function inspectPath(context, owner, file, reference, base) {
  const { specifier, kind } = reference;
  const target = specifier.startsWith('file:')
    ? fileURLToPath(specifier)
    : path.resolve(base, specifier);
  // A checkout coordinate is not a module import. Imported directory paths
  // remain checked: those carry the module kind instead of url.
  if (
    kind === 'url' &&
    fs.existsSync(target) &&
    fs.statSync(target).isDirectory()
  )
    return;
  const other = ownerOf(context.packages, target);
  if (other && other !== owner && inside(context.root, target))
    report(
      context,
      kind === 'alias' ? 'source-alias' : 'cross-package-path',
      file,
      reference,
      `Use a declared public entrypoint of ${other.manifest.name}`,
    );
}
function inspectPackage(context, owner, file, reference) {
  const { specifier, kind } = reference;
  if (kind === 'url') return;
  const name = packageName(specifier);
  const target = context.names.get(name);
  if (!target) return;
  context.references.push({
    file: path.relative(context.root, file),
    owner: owner.manifest.name,
    target: name,
    specifier,
  });
  if (owner !== target && !declared(owner, name))
    report(
      context,
      'undeclared-workspace-dependency',
      file,
      reference,
      `${owner.manifest.name} must declare ${name}`,
    );
  const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`;
  if (
    subpath.includes('/../') ||
    subpath.endsWith('/..') ||
    subpath.includes('/node_modules/')
  )
    report(
      context,
      'private-package-entry',
      file,
      reference,
      'Package specifiers may not traverse the package boundary',
    );
  else if (publicTargets(target, subpath).length === 0)
    report(
      context,
      'private-package-entry',
      file,
      reference,
      `${name} does not export ${subpath}`,
    );
}
function inspect(context, file, reference, base = path.dirname(file)) {
  const owner = ownerOf(context.packages, file);
  if (!owner) return;
  const { specifier } = reference;
  if (reference.kind === 'executable' && !specifier.startsWith('@')) {
    inspectPath(context, owner, file, reference, owner.absolute);
    return;
  }
  if (
    specifier.startsWith('.') ||
    path.isAbsolute(specifier) ||
    specifier.startsWith('file:')
  )
    inspectPath(context, owner, file, reference, base);
  else inspectPackage(context, owner, file, reference);
}
function inspectNodeScript(context, pkg, file, command) {
  const executables = new Set();
  for (const match of command.matchAll(
    /(?:^|\s)node(?:js)?(?:\.exe)?\s+(?:--[^\s]+\s+)*['"]?([^\s'";]+\.(?:[cm]?js|tsx?))/gu,
  )) {
    executables.add(match[1]);
    inspect(
      context,
      file,
      { line: 1, specifier: match[1], kind: 'executable' },
      pkg.absolute,
    );
  }
  // In test mode every positional file is an executable input, not just the first.
  for (const match of command.matchAll(
    /(?:^|[;&]\s*)node\s+--test\s+([^;&]+)/gu,
  )) {
    for (const argument of match[1].matchAll(
      /(?:^|\s)([^\s'";]+\.(?:[cm]?js|tsx?))/gu,
    )) {
      if (executables.has(argument[1])) continue;
      executables.add(argument[1]);
      inspect(
        context,
        file,
        { line: 1, specifier: argument[1], kind: 'executable' },
        pkg.absolute,
      );
    }
  }
  return executables;
}
function inspectFilteredScript(context, pkg, file, command) {
  for (const match of command.matchAll(
    /--filter\s+(@[\w.-]+\/[\w.-]+)(?:\s+run\s+([\w:.-]+))?/gu,
  )) {
    const target = context.names.get(match[1]);
    if (
      target &&
      match[2] &&
      !Object.hasOwn(target.manifest.scripts || {}, match[2])
    )
      report(
        context,
        'missing-package-task',
        file,
        { line: 1, specifier: `${match[1]}#${match[2]}` },
        'The provider must declare the consumed npm task',
      );
    if (target && target !== pkg && !declared(pkg, match[1]))
      report(
        context,
        'undeclared-workspace-dependency',
        file,
        { line: 1, specifier: match[1] },
        `${pkg.manifest.name} must declare its package task dependency`,
      );
  }
  for (const match of command.matchAll(
    /--filter\s+(@[\w.-]+\/[\w.-]+)\s+exec\s+([^;&]+)/gu,
  )) {
    const target = context.names.get(match[1]);
    if (!target) continue;
    for (const argument of match[2].matchAll(/(?:^|\s)(\.\.\/[^\s'";]+)/gu))
      inspectPath(
        context,
        target,
        file,
        { line: 1, specifier: argument[1], kind: 'executable' },
        target.absolute,
      );
  }
}
function inspectScripts(
  context,
  pkg,
  file,
  commands = Object.values(pkg.manifest.scripts || {}),
) {
  for (const command of commands) {
    const executables = inspectNodeScript(context, pkg, file, command);
    inspectFilteredScript(context, pkg, file, command);
    for (const match of command.matchAll(
      /scripts\/run-project-cut-entry\.mjs\s+(@[\w.-]+\/[\w./-]+)/gu,
    ))
      inspect(
        context,
        file,
        { line: 1, specifier: match[1], kind: 'module' },
        pkg.absolute,
      );
    for (const match of command.matchAll(/(?:^|\s)(\.\.\/[^\s'";]+)/gu)) {
      if (executables.has(match[1])) continue;
      inspect(
        context,
        file,
        { line: 1, specifier: match[1], kind: 'module' },
        pkg.absolute,
      );
    }
  }
}
function inspectManifest(context, pkg) {
  const file = path.join(pkg.absolute, 'package.json');
  for (const target of exportTargets(pkg.manifest.exports)) {
    if (
      !target.startsWith('./') ||
      !inside(pkg.absolute, path.resolve(pkg.absolute, target)) ||
      target.split('/').includes('node_modules')
    )
      report(
        context,
        'invalid-export-target',
        file,
        { line: 1, specifier: target },
        'Exports must stay inside the owning package',
      );
  }
  inspectScripts(context, pkg, file);
}
function inspectConfig(context, file, source) {
  const parsed = ts.parseConfigFileTextToJson(file, source);
  if (parsed.error) {
    report(
      context,
      'invalid-config',
      file,
      { line: 1 },
      ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'),
    );
    return;
  }
  const config = parsed.config;
  for (const value of [config.extends].flat().filter(Boolean))
    inspect(context, file, { specifier: value, kind: 'module', line: 1 });
  const base = path.resolve(
    path.dirname(file),
    config.compilerOptions?.baseUrl || '.',
  );
  for (const values of Object.values(config.compilerOptions?.paths || {})) {
    for (const value of values)
      inspect(
        context,
        file,
        {
          specifier: value.startsWith('.') ? value : `./${value}`,
          kind: 'alias',
          line: 1,
        },
        base,
      );
  }
}
export function collectPackageBoundaryIssues({ root = ROOT } = {}) {
  root = path.resolve(root);
  const packages = workspacePackages(root);
  const context = {
    root,
    packages,
    names: new Map(packages.map((pkg) => [pkg.manifest.name, pkg])),
    issues: [],
    references: [],
  };
  for (const pkg of packages) inspectManifest(context, pkg);
  for (const file of sourceFiles(root, packages)) {
    const source = fs.readFileSync(file, 'utf8');
    if (/^tsconfig.*\.json$/u.test(path.basename(file)))
      inspectConfig(context, file, source);
    else if (/\.ya?ml$/u.test(file))
      inspectScripts(
        context,
        ownerOf(packages, file),
        file,
        workflowCommands(source),
      );
    else
      for (const reference of file.endsWith('.py')
        ? pythonPackageReferences(source)
        : moduleReferences(source, file))
        inspect(context, file, reference);
  }
  return {
    schema: 'kungfu.package-boundary-check/v1',
    ok: context.issues.length === 0,
    packageCount: packages.length,
    referenceCount: context.references.length,
    issues: context.issues,
    references: context.references,
  };
}

// Reproduce the installed dependency graph before a fixture is made read-only.
// Workspace links stay in the fixture; external dependencies use the installed
// package's real directory, including its transitive package-manager links.
export function installFixturePackages(sourceRoot, fixtureRoot = sourceRoot) {
  const packages = workspacePackages(sourceRoot);
  const providers = new Map(
    packages.map((pkg) => [pkg.manifest.name, pkg.directory]),
  );
  for (const pkg of packages) {
    const dependencies = Object.assign(
      {},
      ...[
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ].map((section) => pkg.manifest[section]),
    );
    for (const name of Object.keys(dependencies)) {
      const link = path.join(fixtureRoot, pkg.directory, 'node_modules', name);
      if (fs.existsSync(link)) continue;
      const installed = path.join(pkg.absolute, 'node_modules', name);
      const target = providers.has(name)
        ? path.join(fixtureRoot, providers.get(name))
        : fs.existsSync(installed)
          ? fs.realpathSync(installed)
          : null;
      if (!target) continue;
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(
        process.platform === 'win32'
          ? target
          : path.relative(path.dirname(link), target),
        link,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = collectPackageBoundaryIssues();
  if (process.argv.includes('--json'))
    console.log(JSON.stringify(result, null, 2));
  else {
    for (const row of result.issues)
      console.error(
        `${row.file}:${row.line} [${row.code}] ${row.specifier}: ${row.message}`,
      );
    console.log(
      `package boundaries: ${result.ok ? 'passed' : 'failed'}, ${result.packageCount} packages, ${result.issues.length} issues`,
    );
  }
  process.exitCode = result.ok ? 0 : 1;
}
