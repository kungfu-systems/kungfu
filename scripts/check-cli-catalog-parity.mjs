#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACK = path.join(
  ROOT,
  'framework',
  'core',
  'src',
  'python',
  'kungfu',
  'agent',
);
const CLI = path.join(
  ROOT,
  'framework',
  'core',
  'src',
  'python',
  'kungfu',
  'cli',
);

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])]),
    );
  }
  return value;
}

export function contentRoot(value) {
  const canonical = JSON.stringify(ordered(value)).replace(
    /[^\p{ASCII}]/gu,
    (character) => {
      const point = character.codePointAt(0);
      if (point === undefined) return character;
      if (point <= 0xffff) return `\\u${point.toString(16).padStart(4, '0')}`;
      const offset = point - 0x10000;
      const high = 0xd800 + (offset >> 10);
      const low = 0xdc00 + (offset & 0x3ff);
      return `\\u${high.toString(16)}\\u${low.toString(16)}`;
    },
  );
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonical)
    .digest('hex')}`;
}

function canonicalPath(name) {
  if (typeof name !== 'string') return null;
  const tokens = [];
  for (const token of name.split(/\s+/u)) {
    if (/^[-[<{]/u.test(token)) break;
    tokens.push(token.replace(/[;,]$/u, ''));
  }
  return tokens.join(' ');
}

function resolvePath(name, byPath, standaloneRoutes = []) {
  for (const route of standaloneRoutes) {
    const { prefix, target } = route;
    if (
      typeof name === 'string' &&
      typeof prefix === 'string' &&
      typeof target === 'string' &&
      (name === prefix || name.startsWith(`${prefix} `)) &&
      byPath.has(target)
    ) {
      return target;
    }
  }
  const tokens = (canonicalPath(name) || '').split(' ');
  while (tokens.length >= 2) {
    const candidate = tokens.join(' ');
    if (byPath.has(candidate)) return candidate;
    tokens.pop();
  }
  return canonicalPath(name);
}

export function auditCatalogParity({
  catalog,
  registry,
  schema,
  kfd3,
  commands,
  index,
}) {
  const issues = [];
  const fail = (message) => issues.push(message);
  const { catalogRoot: _catalogRoot, ...catalogPreimage } = catalog;
  if (catalog.catalogRoot !== contentRoot(catalogPreimage))
    fail('generated catalog root mismatch');
  if (catalog.registryRoot !== contentRoot(registry))
    fail('generated catalog registry root mismatch');
  if (catalog.schemaRoot !== contentRoot(schema))
    fail('generated catalog schema root mismatch');
  if (catalog.surfaceRoot !== contentRoot(catalog.surfaces || []))
    fail('generated catalog surface root mismatch');
  if (catalog.surfaceRoot !== registry.catalogProjection?.expectedSurfaceRoot)
    fail('generated catalog violates expected surface root');
  const expectedContractRoot = contentRoot({
    schema: 'kungfu.cli-surface-contract/v1',
    version: registry.version,
    registryRoot: catalog.registryRoot,
    schemaRoot: catalog.schemaRoot,
    surfaceRoot: catalog.surfaceRoot,
  });
  if (catalog.contractRoot !== expectedContractRoot)
    fail('generated catalog contract root mismatch');
  if (
    contentRoot(catalog.projection) !== contentRoot(registry.catalogProjection)
  )
    fail('generated catalog projection policy drift');
  if (
    catalog.contractId !== registry.contractId ||
    catalog.version !== registry.version
  )
    fail('generated catalog contract identity drift');

  const ids = new Set();
  const byPath = new Map();
  const linkedApiIds = new Set();
  for (const row of catalog.surfaces || []) {
    const label = row.id || row.canonical_path || '<unknown>';
    if (ids.has(row.id)) fail(`duplicate surface id ${label}`);
    ids.add(row.id);
    for (const field of schema.surfaceRequiredFields || []) {
      if (!(field in row)) fail(`surface ${label} missing ${field}`);
    }
    if (!(schema.owners || []).includes(row.owner))
      fail(`surface ${label} invalid owner ${row.owner}`);
    if (!(schema.maturity || []).includes(row.maturity))
      fail(`surface ${label} invalid maturity ${row.maturity}`);
    if (!(schema.visibility || []).includes(row.visibility))
      fail(`surface ${label} invalid visibility ${row.visibility}`);
    if (!(schema.mutationClasses || []).includes(row.mutation_class))
      fail(`surface ${label} invalid mutation class ${row.mutation_class}`);
    for (const pathName of [row.canonical_path, ...(row.aliases || [])]) {
      if (byPath.has(pathName)) fail(`duplicate surface path ${pathName}`);
      byPath.set(pathName, row);
    }
    for (const apiId of row.kfd3_api_ids || []) linkedApiIds.add(apiId);
  }

  const linkageBySurface = new Map();
  for (const link of catalog.kfd3Linkage || []) {
    if (linkageBySurface.has(link.surfaceId))
      fail(`duplicate KFD-3 linkage ${link.surfaceId}`);
    linkageBySurface.set(link.surfaceId, link);
  }
  for (const row of catalog.surfaces || []) {
    const link = linkageBySurface.get(row.id);
    if (!link) {
      fail(`missing KFD-3 linkage ${row.id}`);
      continue;
    }
    const apiIds = row.kfd3_api_ids || [];
    if (JSON.stringify(link.apiIds) !== JSON.stringify(apiIds))
      fail(`KFD-3 linkage API drift ${row.id}`);
    if (apiIds.length) {
      if (link.state !== 'linked' || link.reason !== null)
        fail(`linked KFD-3 surface has invalid reason ${row.id}`);
    } else if (
      link.state !== 'unlinked' ||
      ![
        'navigation-only',
        'not-agent-visible',
        'no-agent-first-api-declared',
      ].includes(link.reason)
    ) {
      fail(`unlinked KFD-3 surface has no explicit reason ${row.id}`);
    }
  }
  for (const surfaceId of linkageBySurface.keys()) {
    if (!ids.has(surfaceId)) fail(`orphan KFD-3 linkage ${surfaceId}`);
  }

  const apiById = new Map((kfd3.apis || []).map((row) => [row.id, row]));
  for (const row of kfd3.apis || []) {
    if (row.anchor?.kind === 'runtime-click' && !linkedApiIds.has(row.id))
      fail(`orphan runtime KFD-3 API ${row.id}`);
  }
  const expectedCommands = new Map();
  for (const row of kfd3.apis || []) {
    if (!(row.projections || []).includes('commands.json')) continue;
    for (const name of [row.name, ...(row.aliases || [])]) {
      expectedCommands.set(name, row.id);
    }
  }
  const actualCommands = new Map();
  for (const row of commands.commands || []) {
    actualCommands.set(row.name, row.apiId);
    const api = apiById.get(row.apiId);
    if (!api) {
      fail(`commands.json unknown KFD-3 API ${row.apiId}`);
      continue;
    }
    if (row.maturity !== api.maturity)
      fail(`commands.json maturity drift for ${row.name}`);
    const resolved = resolvePath(
      row.name,
      byPath,
      registry.standaloneCatalogRoutes,
    );
    const surface = byPath.get(resolved);
    if (!surface) fail(`commands.json orphan path ${row.name}`);
    else if (!(surface.kfd3_api_ids || []).includes(row.apiId))
      fail(`commands.json link mismatch for ${row.name}`);
  }
  for (const [name, apiId] of expectedCommands) {
    if (actualCommands.get(name) !== apiId)
      fail(`commands.json missing KFD-3 projection ${name}`);
  }
  for (const name of actualCommands.keys()) {
    if (!expectedCommands.has(name))
      fail(`commands.json undeclared projection ${name}`);
  }

  if (
    !(index.documents || []).some(
      (row) => row.path === 'cli_surface.catalog.json',
    )
  )
    fail('agent pack index omits cli_surface.catalog.json');
  return { ok: issues.length === 0, issues, byPath };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function auditPublicReferences(byPath) {
  const issues = [];
  const fail = (message) => issues.push(message);
  const commandPrefixes = [...byPath.keys()];
  const docs = [
    'brief.md',
    'xinfa-context.md',
    'mode-selection.md',
    'safety.md',
    'examples/report-mode.md',
    'examples/trace-mode.md',
    'examples/managed-run.md',
    'examples/remote-sync.md',
    'skills/codex/SKILL.md',
    'skills/claude/SKILL.md',
  ];
  for (const rel of docs) {
    const text = fs.readFileSync(path.join(PACK, rel), 'utf8');
    for (const match of text.matchAll(/^(kungfu [^\n]+)/gmu)) {
      const resolved = resolvePath(match[1], byPath);
      if (!commandPrefixes.includes(resolved))
        fail(`${rel} references undeclared command: ${match[1]}`);
    }
  }
  const gui = fs.readFileSync(
    path.join(ROOT, 'framework', 'gui', 'src', 'main', 'index.ts'),
    'utf8',
  );
  if (!gui.includes("['agent', 'brief']"))
    fail('GUI palette/menu does not declare kungfu agent brief');
  if (!byPath.has('kungfu agent brief'))
    fail('GUI palette/menu command is absent from generated catalog');
  const consoleSource = fs.readFileSync(
    path.join(
      ROOT,
      'framework',
      'api',
      'src',
      'capability',
      'agent-console.ts',
    ),
    'utf8',
  );
  for (const match of consoleSource.matchAll(/['"](kungfu [^'"]+)['"]/gu)) {
    const resolved = resolvePath(match[1], byPath);
    if (!byPath.has(resolved))
      fail(`Agent Console references undeclared command: ${match[1]}`);
  }
  return issues;
}

export function auditRepository() {
  const result = auditCatalogParity({
    catalog: readJson(path.join(PACK, 'cli_surface.catalog.json')),
    registry: readJson(path.join(CLI, 'surface_contract.registry.json')),
    schema: readJson(path.join(CLI, 'surface_contract.schema.json')),
    kfd3: readJson(path.join(PACK, 'kfd3_api.registry.json')),
    commands: readJson(path.join(PACK, 'commands.json')),
    index: readJson(path.join(PACK, 'index.json')),
  });
  const issues = [...result.issues, ...auditPublicReferences(result.byPath)];
  const setup = fs.readFileSync(
    path.join(ROOT, 'framework', 'core', 'src', 'python', 'setup.py'),
    'utf8',
  );
  if (!setup.includes('"*.json"'))
    issues.push('Python package data omits generated JSON catalogs');
  const freeze = fs.readFileSync(
    path.join(ROOT, 'framework', 'core', '.gyp', 'run-freeze.js'),
    'utf8',
  );
  if (!freeze.includes('agentPackDataArgs()'))
    issues.push('frozen CLI does not include the complete Agent pack');
  return { ok: issues.length === 0, issues };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = auditRepository();
  if (!result.ok) {
    console.error(result.issues.map((issue) => `- ${issue}`).join('\n'));
    process.exit(1);
  }
  console.log(
    'ok (generated CLI catalog and all declared consumers are current)',
  );
}
