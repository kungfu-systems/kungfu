// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCatalog,
  buildContextEnvelope,
  injectSkillContext,
  parseSkill,
  writeSkillContextFile,
} from '../src/index.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), 'utf8'));
}

const skills = ['minimal', 'with-frontmatter'].map((name) =>
  parseSkill(join(root, 'fixtures', name)),
);
const catalog = buildCatalog(skills);
const envelope = buildContextEnvelope(catalog, {
  source: 'test',
  manager: 'node',
});

assert.deepEqual(catalog, readJson('fixtures/golden/catalog.json'));
assert.deepEqual(envelope, readJson('fixtures/golden/context-node.json'));
assert.equal(
  injectSkillContext('hello', envelope).endsWith('\n\nUser task:\nhello'),
  true,
);
const out = join(mkdtempSync(join(tmpdir(), 'kungfu-skill-')), 'context.json');
writeSkillContextFile(root, {
  source: 'test',
  manager: 'node',
  extraPaths: [
    join(root, 'fixtures', 'minimal'),
    join(root, 'fixtures', 'with-frontmatter'),
  ],
  out,
});
assert.deepEqual(
  readJson('fixtures/golden/context-node.json'),
  JSON.parse(readFileSync(out, 'utf8')),
);
console.log('skill golden fixtures match');
