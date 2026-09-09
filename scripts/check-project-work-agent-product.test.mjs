#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_PATH = path.join(
  ROOT,
  'product',
  'contracts',
  'project-work-agent.contract.json',
);
const CATALOG_PATH = path.join(
  ROOT,
  'framework',
  'core',
  'src',
  'python',
  'kungfu',
  'agent',
  'cli_surface.catalog.json',
);
const CLI_REGISTRY_PATH = path.join(
  ROOT,
  'framework',
  'core',
  'src',
  'python',
  'kungfu',
  'cli',
  'surface_contract.registry.json',
);
const FORBIDDEN_FIRST_LAYER_NOUNS = [
  'Initiative',
  'Assignment',
  'Portfolio',
  'Mission',
  'Profile',
  'Workspace',
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function quotedPublicCopy(source) {
  return source
    .split('\n')
    .flatMap((line) => [...(line.match(/'[^'\n]*'|"[^"\n]*"/gu) ?? [])])
    .join('\n');
}

function assertRequiredCopy(requiredCopy) {
  for (const [relative, required] of Object.entries(requiredCopy)) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    for (const text of required) {
      assert.match(
        source,
        new RegExp(text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
      );
    }
    const publicCopy = quotedPublicCopy(source);
    for (const noun of FORBIDDEN_FIRST_LAYER_NOUNS) {
      assert.doesNotMatch(
        publicCopy,
        new RegExp(`\\b${noun}\\b`, 'u'),
        `${relative} exposes internal noun ${noun} in first-layer copy`,
      );
    }
  }
}

test('Project, Work, and Agent are the complete first-layer object model', () => {
  const contract = readJson(CONTRACT_PATH);
  assert.equal(
    contract.schema,
    'kungfu.project-work-agent-product.contract/v1',
  );
  assert.deepEqual(contract.firstLayer.objectNouns, [
    'Project',
    'Work',
    'Agent',
  ]);
  assert.deepEqual(contract.firstLayer.goldenPath, [
    'Teach the existing Agent with kungfu agent brief',
    'New or Open Project',
    'Create or select Work',
    'Run Agent',
    'Review and complete Work',
  ]);
  assert.deepEqual(contract.progressiveDisclosure.firstLayerAllowedObjects, [
    'Project',
    'Work',
    'Agent',
  ]);
  assert.equal(
    contract.firstEntry.principle,
    "Kungfu's first entry is an Agent capability, not a new daily work interface.",
  );
  assertRequiredCopy(contract.surfaces.tui.requiredCopy);
  assertRequiredCopy(contract.surfaces.gui.requiredCopy);
});

test('README first-use paths converge on Agent-first onboarding', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const explicitInstallEntry = readme.indexOf(
    'install Kungfu and make the `kungfu` command available',
  );
  const installGuide = readme.indexOf('docs/guides/installing-cli.md');
  const agentBrief = readme.indexOf('Run `kungfu agent brief`');
  const runAgent = readme.indexOf('kungfu run codex');
  const demoStart = readme.indexOf(
    '<!-- kungfu:auditable-demo:agent-work-lab-autoplay:start -->',
  );
  const autoplayEnd = readme.indexOf(
    '<!-- kungfu:auditable-demo:agent-work-lab-autoplay:end -->',
  );
  const tourEpisodeOneStart = readme.indexOf(
    '<!-- kungfu:auditable-demo:project-tour-episode-1:start -->',
  );
  const tourEpisodeOneEnd = readme.indexOf(
    '<!-- kungfu:auditable-demo:project-tour-episode-1:end -->',
  );
  const tourEpisodeTwoStart = readme.indexOf(
    '<!-- kungfu:auditable-demo:project-tour-episode-2:start -->',
  );
  const demoEnd = readme.indexOf(
    '<!-- kungfu:auditable-demo:project-tour-episode-2:end -->',
  );
  const tuiEntry = readme.indexOf('\nkungfu\n', demoEnd);
  const firstUseEnd = readme.indexOf('\n## What Kungfu preserves', demoEnd);

  assert.ok(
    explicitInstallEntry > 0,
    'README must present installation as an explicit first-use action',
  );
  assert.ok(
    installGuide > explicitInstallEntry,
    'The explicit installation action must link to the installation guide',
  );
  assert.ok(agentBrief > installGuide, 'Agent brief must follow installation');
  assert.ok(
    runAgent > agentBrief,
    'run <agent> must follow the one-line brief',
  );
  assert.ok(
    demoStart > runAgent,
    'Agent Work Lab demo must follow run <agent>',
  );
  assert.ok(autoplayEnd > demoStart, 'managed autoplay block is incomplete');
  assert.ok(
    tourEpisodeOneStart > autoplayEnd,
    'managed Project Tour episode 1 block is missing',
  );
  assert.ok(
    tourEpisodeOneEnd > tourEpisodeOneStart,
    'managed Project Tour episode 1 block is incomplete',
  );
  assert.ok(
    tourEpisodeTwoStart > tourEpisodeOneEnd,
    'managed Project Tour episode 2 block is missing',
  );
  assert.ok(
    demoEnd > tourEpisodeTwoStart,
    'managed Project Tour episode 2 block is incomplete',
  );
  assert.ok(tuiEntry > demoEnd, 'bare TUI entry must follow the Lab demo');
  assert.match(
    readme.slice(demoEnd, firstUseEnd),
    /Getting Started leads to the same Agent-first prompt/u,
  );
});

test('CLI exposes Project creation and Agent execution without legacy entrypoints', () => {
  const contract = readJson(CONTRACT_PATH);
  const catalog = readJson(CATALOG_PATH);
  const registry = readJson(CLI_REGISTRY_PATH);
  const rows = new Map(
    catalog.surfaces.map((row) => [row.canonical_path, row]),
  );
  assert.ok(rows.has(contract.surfaces.cli.requiredOnboardingCommand));

  assert.deepEqual(registry.helpProjection.defaultVisibilities, ['start-here']);
  const startHere = Object.entries(registry.familyPolicies)
    .filter(([, policy]) => policy.visibility === 'start-here')
    .map(([family]) => `kungfu ${family}`)
    .sort();
  assert.deepEqual(
    startHere,
    [...contract.surfaces.cli.defaultHelpCommands].sort(),
  );
  for (const command of contract.surfaces.cli.requiredProjectCommands) {
    assert.ok(rows.has(command), `missing CLI Project command: ${command}`);
    assert.notEqual(rows.get(command).visibility, 'hidden-internal');
  }
  for (const command of contract.surfaces.cli.requiredRunCommands) {
    const row = rows.get(command);
    assert.ok(row, `missing CLI Agent command: ${command}`);
    assert.notEqual(row.visibility, 'hidden-internal');
    assert.match(row.summary, /\bProject Work\b/u);
  }
  for (const command of contract.surfaces.cli.hiddenProjectCommands) {
    assert.equal(rows.get(command)?.visibility, 'hidden-internal');
  }
  for (const command of contract.surfaces.cli.forbiddenPublicCommands) {
    assert.ok(
      !rows.has(command) || rows.get(command).visibility === 'hidden-internal',
      `legacy CLI command remains public: ${command}`,
    );
  }
  const startHereSummary = registry.helpProjection.sections.find(
    (section) => section.id === 'start-here',
  )?.summary;
  for (const noun of contract.surfaces.cli.forbiddenDefaultHelpNouns) {
    assert.doesNotMatch(
      startHereSummary ?? '',
      new RegExp(`\\b${noun}\\b`, 'u'),
    );
  }
});

test('the release contract names existing qualification evidence', () => {
  const contract = readJson(CONTRACT_PATH);
  for (const relative of contract.qualification.surfaceTests) {
    assert.ok(
      fs.existsSync(path.join(ROOT, relative)),
      `missing surface qualification: ${relative}`,
    );
  }
});
