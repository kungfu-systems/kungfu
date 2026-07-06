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
  'mode-selection.md',
  'commands.json',
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
}

if (commands) {
  const names = new Set((commands.commands || []).map((row) => row.name));
  for (const name of [
    'kungfu agent brief',
    'kungfu agent docs',
    'kungfu agent capabilities --json',
    'kungfu agent choose-mode --json',
    'kungfu agent install-skill --target codex',
    'kungfu agent install-skill --target claude',
    'kungfu trace -- <command>',
    'kungfu managed-run --provider <provider> --prompt <task>',
    'kungfu work create <title> --json',
    'kungfu report run begin --work <work-id> --provider <provider> --json',
    'kungfu report cost --run <run-id> --provider <provider> --json',
    'kungfu report run end --run <run-id> --status <status> --json',
    'kungfu remote add <source-id> --host <host> --home <kf-home> --json',
    'kungfu remote sync <source-id> --json',
    'kungfu skill catalog --json',
    'kungfu kfx install <source>',
  ]) {
    if (!names.has(name)) fail(`commands.json missing command ${name}`);
  }
  for (const mode of [
    'brief',
    'report',
    'trace',
    'managed-run',
    'remote-sync',
  ]) {
    if (!commands.modes?.[mode]) fail(`commands.json missing mode ${mode}`);
    if (!commands.modes?.[mode]?.maturity)
      fail(`commands.json mode ${mode} missing maturity`);
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
      bare.startsWith('kungfu remote') ||
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
for (const pattern of ['*.md', 'examples/*.md', 'skills/*/SKILL.md']) {
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
