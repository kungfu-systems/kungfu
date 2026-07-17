// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PACK = path.join(
  ROOT,
  'framework',
  'core',
  'src',
  'python',
  'kungfu',
  'agent',
);

const REQUIRED = [
  'index.json',
  'brief.md',
  'xinfa-context.md',
  'mode-selection.md',
  'commands.json',
  'kfd3_api.registry.json',
  'kfd3_api.schema.json',
  'safety.md',
  'examples/report-mode.md',
  'examples/trace-mode.md',
  'examples/managed-run.md',
  'examples/remote-sync.md',
  'skills/codex/SKILL.md',
  'skills/claude/SKILL.md',
];

/** @type {string[]} */
const failures = [];

function fail(message) {
  failures.push(message);
}

function read(rel) {
  return fs.readFileSync(path.join(PACK, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function exists(rel) {
  return fs.existsSync(path.join(PACK, rel));
}

for (const rel of REQUIRED) {
  if (!exists(rel)) fail(`missing ${rel}`);
}

let index = null;
let commands = null;
let apiRegistry = null;
let apiSchema = null;
try {
  index = readJson('index.json');
} catch (e) {
  fail(`index.json is invalid JSON: ${e instanceof Error ? e.message : e}`);
}
try {
  commands = readJson('commands.json');
} catch (e) {
  fail(`commands.json is invalid JSON: ${e instanceof Error ? e.message : e}`);
}
try {
  apiRegistry = readJson('kfd3_api.registry.json');
} catch (e) {
  fail(
    `kfd3_api.registry.json is invalid JSON: ${e instanceof Error ? e.message : e}`,
  );
}
try {
  apiSchema = readJson('kfd3_api.schema.json');
} catch (e) {
  fail(
    `kfd3_api.schema.json is invalid JSON: ${e instanceof Error ? e.message : e}`,
  );
}

if (index) {
  const docs = new Set((index.documents || []).map((row) => row.path));
  const skills = new Set((index.skills || []).map((row) => row.path));
  for (const rel of REQUIRED) {
    if (rel.startsWith('skills/')) {
      if (!skills.has(rel)) fail(`index.json does not list ${rel}`);
    } else if (!docs.has(rel)) {
      fail(`index.json does not list ${rel}`);
    }
  }
  for (const channel of [
    'electron',
    'standalone-cli',
    'npm',
    'pypi',
    'homebrew',
    'winget',
    'container',
    'kfx',
  ]) {
    if (!(index.installChannels || []).some((row) => row.channel === channel)) {
      fail(`index.json missing install channel ${channel}`);
    }
  }
  const context = index.contextCompiler || {};
  if (context.product !== 'xinfa')
    fail('index.json contextCompiler product is not xinfa');
  if (context.authority !== 'xinfa contract --json')
    fail('index.json contextCompiler has no canonical Xinfa contract help');
  if (context.installedBoundary !== 'read-only-precompiled-atlas')
    fail('index.json does not fail closed on the installed Xinfa boundary');
  if (context.automaticAdmission !== 'coordinator-required')
    fail('index.json overstates automatic Xinfa admission');
}

const brief = exists('brief.md') ? read('brief.md') : '';
const xinfaContext = exists('xinfa-context.md') ? read('xinfa-context.md') : '';
for (const [rel, text] of [
  ['brief.md', brief],
  ['xinfa-context.md', xinfaContext],
]) {
  for (const phrase of [
    './shifu docs inventory --json',
    './shifu docs context',
    'kungfu agent docs --verify --json',
  ]) {
    if (!text.includes(phrase))
      fail(`${rel} missing Xinfa discovery phrase: ${phrase}`);
  }
}
for (const phrase of [
  'xinfa contract --json',
  'xinfa schema task-envelope',
  'coordinator',
  'does not execute Xinfa',
]) {
  if (!xinfaContext.includes(phrase))
    fail(`xinfa-context.md missing authority boundary: ${phrase}`);
}

if (apiRegistry && apiSchema) {
  for (const field of apiSchema.requiredTopLevel || []) {
    if (!(field in apiRegistry))
      fail(`kfd3_api.registry.json missing top-level field ${field}`);
  }
  const ids = new Set();
  for (const [index, row] of (apiRegistry.apis || []).entries()) {
    const id = row.id || `<index:${index}>`;
    if (ids.has(id)) fail(`kfd3_api.registry.json duplicate api id ${id}`);
    ids.add(id);
    for (const field of apiSchema.apiRequiredFields || []) {
      if (!(field in row))
        fail(`kfd3_api.registry.json api ${id} missing field ${field}`);
    }
    if (!(apiSchema.visibility || []).includes(row.visibility))
      fail(
        `kfd3_api.registry.json api ${id} invalid visibility ${row.visibility}`,
      );
    const anchorKind = row.anchor?.kind;
    if (!(apiSchema.anchorKinds || []).includes(anchorKind))
      fail(
        `kfd3_api.registry.json api ${id} invalid anchor kind ${anchorKind}`,
      );
  }
}

if (commands && apiRegistry) {
  if (commands.apiRegistry?.source !== 'kfd3_api.registry.json')
    fail('commands.json does not declare kfd3_api.registry.json as source');
  if (commands.apiRegistry?.registryId !== apiRegistry.registryId)
    fail('commands.json apiRegistry.registryId does not match registry');
  const registryIds = new Set((apiRegistry.apis || []).map((row) => row.id));
  for (const row of commands.commands || []) {
    if (!row.apiId) fail(`commands.json command ${row.name} missing apiId`);
    if (row.apiId && !registryIds.has(row.apiId))
      fail(`commands.json command ${row.name} has unknown apiId ${row.apiId}`);
  }
  const names = new Set((commands.commands || []).map((row) => row.name));
  const registryCommandNames = new Set();
  for (const row of apiRegistry.apis || []) {
    if (!(row.projections || []).includes('commands.json')) continue;
    registryCommandNames.add(row.name);
    for (const alias of row.aliases || []) registryCommandNames.add(alias);
  }
  for (const name of registryCommandNames) {
    if (!names.has(name))
      fail(`commands.json missing registry-projected command ${name}`);
  }
  for (const name of names) {
    if (!registryCommandNames.has(name))
      fail(`commands.json has undeclared command ${name}`);
  }
  for (const mode of [
    'brief',
    'report',
    'atlas-projection',
    'trace',
    'managed-run',
    'remote-sync',
  ]) {
    if (!commands.modes?.[mode]) fail(`commands.json missing mode ${mode}`);
    if (!commands.modes?.[mode]?.maturity)
      fail(`commands.json mode ${mode} missing maturity`);
  }
}

if (apiRegistry) {
  const agentCli = fs.readFileSync(
    path.join(
      ROOT,
      'framework',
      'core',
      'src',
      'python',
      'kungfu',
      'cli',
      'commands',
      'agent.py',
    ),
    'utf8',
  );
  const expectedRuntimeIds = new Set(
    (apiRegistry.apis || [])
      .filter((row) => row.anchor?.kind === 'runtime-click')
      .map((row) => row.id),
  );
  const observedAnchors = new Set(
    [...agentCli.matchAll(/@kfd3_api\("([^"]+)"\)/g)].map((match) => match[1]),
  );
  for (const apiId of expectedRuntimeIds) {
    if (!observedAnchors.has(apiId))
      fail(`agent.py missing @kfd3_api("${apiId}")`);
  }
  for (const apiId of observedAnchors) {
    if (!expectedRuntimeIds.has(apiId))
      fail(`agent.py has stale @kfd3_api("${apiId}")`);
  }
  const commandBlocks = [
    ...agentCli.matchAll(
      /@(?:kfc|agent|mode)\.(?:group|command)[\s\S]*?\ndef\s+([a-zA-Z0-9_]+)\(/g,
    ),
  ];
  for (const block of commandBlocks) {
    if (!block[0].includes('@kfd3_api('))
      fail(`agent.py Click command ${block[1]} has no @kfd3_api anchor`);
  }
}

const safety = exists('safety.md') ? read('safety.md') : '';
for (const term of ['observed', 'reported', 'imported', 'remote']) {
  if (!safety.includes(`**${term}**`)) fail(`safety.md missing ${term} label`);
}
for (const phrase of ['does not grant runtime authority', 'kfx package']) {
  if (!safety.includes(phrase))
    fail(`safety.md missing safety phrase: ${phrase}`);
}

const commandPrefixes = commands
  ? (commands.commands || []).map((row) =>
      row.name
        .split(' --')[0]
        .replace(/ <[^>]+>/g, '')
        .trim(),
    )
  : [];
for (const rel of REQUIRED.filter((p) => p.endsWith('.md'))) {
  const text = read(rel);
  const matches = text.matchAll(/^(kungfu [^\n]+)/gm);
  for (const match of matches) {
    const bare = match[1].trim();
    if (
      bare.startsWith('kungfu agent') ||
      bare.startsWith('kungfu trace') ||
      bare.startsWith('kungfu managed-run') ||
      bare.startsWith('kungfu work') ||
      bare.startsWith('kungfu report') ||
      bare.startsWith('kungfu codex') ||
      bare.startsWith('kungfu remote') ||
      bare.startsWith('kungfu skill') ||
      bare.startsWith('kungfu kfx') ||
      bare.startsWith('kungfu rewind')
    ) {
      const known =
        commandPrefixes.some((prefix) => bare.startsWith(prefix)) ||
        bare.startsWith('kungfu rewind') ||
        bare.startsWith('kungfu work checkpoint') ||
        bare.startsWith('kungfu work ready') ||
        bare.startsWith('kungfu work artifact');
      if (!known) fail(`${rel} references undeclared command: ${match[1]}`);
    }
  }
}

const registry = fs.readFileSync(
  path.join(
    ROOT,
    'framework',
    'core',
    'src',
    'python',
    'kungfu',
    'cli',
    'commands',
    '__registry__.py',
  ),
  'utf8',
);
if (!registry.includes('from . import agent'))
  fail('CLI registry does not import agent');

const setup = fs.readFileSync(
  path.join(ROOT, 'framework', 'core', 'src', 'python', 'setup.py'),
  'utf8',
);
for (const pattern of [
  '*.json',
  '*.md',
  'examples/*.md',
  'skills/*/SKILL.md',
]) {
  if (!setup.includes(pattern))
    fail(`setup.py package_data missing ${pattern}`);
}

const freeze = fs.readFileSync(
  path.join(ROOT, 'framework', 'core', '.gyp', 'run-freeze.js'),
  'utf8',
);
if (!freeze.includes('agentPackDataArgs()')) {
  fail('run-freeze.js does not include agent pack data helper');
}

const gui = fs.readFileSync(
  path.join(ROOT, 'framework', 'gui', 'src', 'main', 'index.ts'),
  'utf8',
);
if (!gui.includes("['agent', 'brief']"))
  fail('GUI menu does not expose agent brief');

const tui = fs.readFileSync(
  path.join(ROOT, 'framework', 'tui', 'src', 'main.tsx'),
  'utf8',
);
if (!tui.includes('kungfu agent brief'))
  fail('TUI does not point to agent brief');

if (failures.length) {
  console.error(failures.map((f) => `- ${f}`).join('\n'));
  process.exit(1);
}

console.log(
  `ok (${REQUIRED.length} files, ${commands?.commands?.length || 0} commands)`,
);
