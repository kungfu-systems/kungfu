// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCatalog,
  buildContextEnvelope,
  buildSkillManagerView,
  injectSkillContext,
  parseSkill,
  writeSkillContextFile,
  writeSkillManagerViewFile,
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

const home = mkdtempSync(join(tmpdir(), 'kungfu-skill-manager-'));
const rewindInspectorRoot = join(home, 'extensions', 'rewind-inspector');
mkdirSync(rewindInspectorRoot, { recursive: true });
writeFileSync(
  join(rewindInspectorRoot, 'package.json'),
  `${JSON.stringify(
    {
      name: '@kungfu-tech/kfx-view-rewind-inspector',
      version: '4.0.0-alpha.0',
      kungfuConfig: {
        key: 'rewind-inspector',
        config: { view: { title: 'Rewind', capabilities: [] } },
      },
    },
    null,
    2,
  )}\n`,
  'utf8',
);
const codexHome = join(home, '.codex');
const claudeHome = join(home, '.claude');
const codexSkill = join(codexHome, 'skills', 'trace-helper');
const codexSystemSkill = join(codexHome, 'skills', '.system', 'trace-helper');
const claudeSkill = join(claudeHome, 'skills', 'review-helper');
const repoSkill = join(home, 'project', '.agents', 'skills', 'trace-helper');
mkdirSync(codexSkill, { recursive: true });
mkdirSync(codexSystemSkill, { recursive: true });
mkdirSync(claudeSkill, { recursive: true });
mkdirSync(repoSkill, { recursive: true });
writeFileSync(
  join(codexSkill, 'SKILL.md'),
  '# Trace Helper\n\nInspect a local trace.\n',
  'utf8',
);
writeFileSync(
  join(codexSystemSkill, 'SKILL.md'),
  '---\nkey: trace-helper\ndescription: System trace helper.\n---\n# Trace Helper\n',
  'utf8',
);
writeFileSync(
  join(claudeSkill, 'SKILL.md'),
  '---\nkey: review-helper\ndescription: Review a local change.\n---\n# Review Helper\n',
  'utf8',
);
writeFileSync(
  join(repoSkill, 'SKILL.md'),
  '---\nkey: trace-helper\ndescription: Repo-local trace helper.\n---\n# Trace Helper\n',
  'utf8',
);
const managerView = buildSkillManagerView(home, {
  extraPaths: [
    join(root, 'fixtures', 'minimal'),
    join(root, 'fixtures', 'with-frontmatter'),
  ],
  env: {},
  homeDir: home,
  cwd: join(home, 'project'),
});
assert.equal(managerView.schema, 'kungfu.skill-manager/v1');
assert.deepEqual(managerView.summary, {
  skills: 2,
  dependencies: 2,
  resolved: 1,
  unresolved: 1,
  unresolvedRequired: 1,
  kfxKeys: ['journal-manager', 'rewind-inspector'],
  unresolvedKfxKeys: ['journal-manager'],
});
assert.equal(
  managerView.skills.find((skill) => skill.key === 'minimal')
    ?.hasUnresolvedRequiredDependencies,
  false,
);
assert.equal(
  managerView.skills.find((skill) => skill.key === 'trace-failure-investigator')
    ?.hasUnresolvedRequiredDependencies,
  true,
);
assert.equal(
  managerView.agentInventory.schema,
  'kungfu.agent-skill-inventory/v1',
);
assert.equal(managerView.agentInventory.summary.targets, 4);
assert.equal(managerView.agentInventory.summary.effective, 4);
assert.equal(managerView.agentInventory.summary.shadowed, 1);
assert.equal(
  managerView.agentInventory.targets
    .flatMap((target) => target.skills)
    .find((skill) => skill.key === 'trace-helper' && !skill.effective)
    ?.shadowedBy?.endsWith(join('trace-helper', 'SKILL.md')),
  true,
);
const managerOut = join(home, 'manager.json');
writeSkillManagerViewFile(home, {
  extraPaths: [
    join(root, 'fixtures', 'minimal'),
    join(root, 'fixtures', 'with-frontmatter'),
  ],
  env: {},
  homeDir: home,
  cwd: join(home, 'project'),
  out: managerOut,
});
assert.deepEqual(
  JSON.parse(JSON.stringify(managerView)),
  JSON.parse(readFileSync(managerOut, 'utf8')),
);
console.log('skill golden fixtures match');
