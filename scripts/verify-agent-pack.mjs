// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
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
const AGENT_CLI_SOURCES = [
  'agent.py',
  'agent_first_value_entry.py',
  'agent_work_lab.py',
];

const REQUIRED = [
  'index.json',
  'brief.md',
  'intent-map.json',
  'first-value.contract.json',
  'first-value-receipt.schema.json',
  'skill-decision.contract.json',
  'xinfa-context.md',
  'primitive-management.md',
  'mode-selection.md',
  'commands.json',
  'cli_surface.catalog.json',
  'kfd3_api.registry.json',
  'kfd3_api.schema.json',
  'safety.md',
  'examples/report-mode.md',
  'examples/trace-mode.md',
  'examples/managed-run.md',
  'examples/remote-sync.md',
  'skills/codex/SKILL.md',
  'skills/claude/SKILL.md',
  'skills/amp/SKILL.md',
  'skills/opencode/SKILL.md',
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
let cliSurface = null;
let apiRegistry = null;
let apiSchema = null;
let intentMap = null;
let firstValueContract = null;
let firstValueReceiptSchema = null;
let skillDecisionContract = null;
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
  cliSurface = readJson('cli_surface.catalog.json');
} catch (e) {
  fail(
    `cli_surface.catalog.json is invalid JSON: ${e instanceof Error ? e.message : e}`,
  );
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
try {
  intentMap = readJson('intent-map.json');
} catch (e) {
  fail(
    `intent-map.json is invalid JSON: ${e instanceof Error ? e.message : e}`,
  );
}
try {
  firstValueContract = readJson('first-value.contract.json');
} catch (e) {
  fail(
    `first-value.contract.json is invalid JSON: ${e instanceof Error ? e.message : e}`,
  );
}
try {
  firstValueReceiptSchema = readJson('first-value-receipt.schema.json');
} catch (e) {
  fail(
    `first-value-receipt.schema.json is invalid JSON: ${e instanceof Error ? e.message : e}`,
  );
}
try {
  skillDecisionContract = readJson('skill-decision.contract.json');
} catch (e) {
  fail(
    `skill-decision.contract.json is invalid JSON: ${e instanceof Error ? e.message : e}`,
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
  if (context.authority !== 'kungfu xinfa contract --json')
    fail('index.json contextCompiler has no canonical Xinfa contract help');
  if (context.publicEntrypoint !== 'kungfu')
    fail('index.json contextCompiler has more than one public entrypoint');
  if (context.installedBoundary !== 'linked-xinfa-component-in-kungfu-trunk')
    fail('index.json does not fail closed on the installed Xinfa boundary');
  if (context.automaticAdmission !== 'coordinator-required')
    fail('index.json overstates automatic Xinfa admission');
}

const brief = exists('brief.md') ? read('brief.md') : '';
const codexSkill = exists('skills/codex/SKILL.md')
  ? read('skills/codex/SKILL.md')
  : '';
const xinfaContext = exists('xinfa-context.md') ? read('xinfa-context.md') : '';
const primitiveManagement = exists('primitive-management.md')
  ? read('primitive-management.md')
  : '';
if (Buffer.byteLength(brief, 'utf8') > 8192)
  fail('brief.md exceeds the 8192-byte first-entry budget');
if (brief.split(/\r?\n/).length > 120)
  fail('brief.md exceeds the 120-line first-entry budget');
if (intentMap) {
  const required = intentMap.requiredIntentIds || [];
  const actual = (intentMap.intents || []).map((row) => row.id);
  if (new Set(actual).size !== actual.length)
    fail('intent-map.json contains duplicate intent ids');
  if (
    required.length !== actual.length ||
    required.some((id) => !actual.includes(id))
  )
    fail('intent-map.json required intent coverage is incomplete or unknown');
  for (const row of intentMap.intents || []) {
    for (const field of [
      'id',
      'summary',
      'audience',
      'maturity',
      'authorityRoots',
      'access',
      'authorization',
      'nonClaims',
      'discoveryCommands',
      'expansionHandles',
    ])
      if (!(field in row))
        fail(`intent-map.json intent ${row.id} missing ${field}`);
  }
  const workspaceGit = intentMap.workspaceGit || {};
  if (
    workspaceGit.schema !== 'kungfu.workspace-git-boundary/v1' ||
    workspaceGit.scope !== '.kungfu/' ||
    workspaceGit.neverStageWholeHome !== true ||
    workspaceGit.publicationDisposition !== 'stage-only-after-row-selection' ||
    workspaceGit.defaultDisposition !== 'keep-local' ||
    workspaceGit.unmatchedPathPolicy !==
      'keep-local-unless-explicit-repository-policy'
  )
    fail('intent-map.json workspace Git boundary defaults are invalid');
  const gitRows = [
    ...(workspaceGit.publishAllowlist || []),
    ...(workspaceGit.localOnly || []),
  ];
  const gitIds = gitRows.map((row) => row.id);
  if (new Set(gitIds).size !== gitIds.length)
    fail('intent-map.json workspace Git boundary has duplicate ids');
  for (const row of gitRows) {
    if (
      typeof row.pathRegex !== 'string' ||
      !row.pathRegex.startsWith('^') ||
      !row.pathRegex.endsWith('$')
    ) {
      fail(`intent-map.json workspace Git rule ${row.id} is not anchored`);
      continue;
    }
    try {
      new RegExp(row.pathRegex, 'u');
    } catch {
      fail(`intent-map.json workspace Git rule ${row.id} is invalid`);
    }
  }
}
if (firstValueContract) {
  const prompt = firstValueContract.prompt || {};
  const promptRoot = `sha256:${crypto
    .createHash('sha256')
    .update(String(prompt.text || ''), 'utf8')
    .digest('hex')}`;
  if (firstValueContract.schema !== 'kungfu.agent-first-value-contract/v1')
    fail('first-value contract has an unknown schema');
  if (prompt.root !== promptRoot)
    fail('first-value contract prompt root does not bind the exact UTF-8 text');
  const promptFamily = firstValueContract.promptFamily || {};
  const variants = promptFamily.variants || [];
  if (promptFamily.canonicalRoot !== prompt.root || variants.length !== 5)
    fail('first-value contract natural prompt family is incomplete');
  const promptRoots = new Set([prompt.root]);
  for (const variant of variants) {
    const root = `sha256:${crypto
      .createHash('sha256')
      .update(String(variant.text || ''), 'utf8')
      .digest('hex')}`;
    if (variant.root !== root || promptRoots.has(root))
      fail('first-value contract natural prompt variant root is invalid');
    promptRoots.add(root);
    if (
      !String(variant.text || '').includes(
        promptFamily.naturalLanguagePolicy?.requiredPhrase || '',
      ) ||
      (promptFamily.naturalLanguagePolicy?.forbiddenProtocolHints || []).some(
        (hint) => String(variant.text || '').includes(hint),
      )
    )
      fail('first-value contract variant leaks protocol-step instructions');
  }
  if (firstValueContract.result?.maximumQuestionCount !== 1)
    fail('first-value contract does not enforce at most one question');
  if (firstValueContract.result?.requiredIntentCount !== 1)
    fail('first-value contract does not enforce exactly one intent');
  if (firstValueContract.result?.minimumSafeDiscoveryCount !== 1)
    fail('first-value contract does not require one safe discovery');
  if (firstValueContract.result?.requiredOutcomeCount !== 1)
    fail('first-value contract does not require one minimal outcome');
  const exactDefault = firstValueContract.result?.exactPromptDefault || {};
  if (
    firstValueContract.result?.deterministicEntryCommand !==
      'kungfu agent first-value start --json' ||
    exactDefault.intentId !== 'onboarding' ||
    exactDefault.questionCount !== 0 ||
    exactDefault.discoveryCommand !==
      'kungfu agent status --target codex --scope project --json'
  )
    fail('first-value contract exact-prompt default is not deterministic');
  if (
    firstValueContract.qualification?.requiredLocalCodexTrials !== 10 ||
    firstValueContract.qualification?.minimumCanonicalPromptTrials !== 5
  )
    fail('first-value contract does not require the 10-run local Codex matrix');
  if (
    firstValueContract.qualification?.experienceDimensions?.length !== 9 ||
    firstValueContract.qualification?.evaluatorPolicy
      ?.keywordOrSelfReportAloneCanPass !== false
  )
    fail(
      'first-value contract does not bind the deterministic experience gate',
    );
  if (
    firstValueContract.qualification?.ci !==
    'deterministic-contract-and-receipt-only'
  )
    fail('first-value contract incorrectly requires a provider in CI');
  for (const nonClaim of [
    'claude-qualified',
    'ci-hosted-codex-qualified',
    'public-release-qualified',
    'model-output-alone-is-proof',
  ])
    if (!(firstValueContract.qualification?.nonClaims || []).includes(nonClaim))
      fail(`first-value contract omitted non-claim ${nonClaim}`);
}
if (firstValueReceiptSchema) {
  if (
    firstValueReceiptSchema.properties?.schema?.const !==
    'kungfu.agent-first-value-receipt/v1'
  )
    fail('first-value receipt schema has an unknown receipt identity');
  if (firstValueReceiptSchema.properties?.questionCount?.maximum !== 1)
    fail('first-value receipt schema permits more than one question');
  if (firstValueReceiptSchema.properties?.diagnostics?.maxItems !== 0)
    fail('a verified first-value receipt can retain diagnostics');
}
if (skillDecisionContract && index && intentMap) {
  const policyRoot = `sha256:${crypto
    .createHash('sha256')
    .update(read('skill-decision.contract.json'), 'utf8')
    .digest('hex')}`;
  const outcomes = skillDecisionContract.outcomes || [];
  const exactOutcomes = [
    'auto-use-existing',
    'suggest-existing',
    'suggest-create',
    'auto-draft',
    'plan-only',
    'none',
  ];
  if (
    skillDecisionContract.schema !==
      'kungfu.agent-skill-decision-contract/v1' ||
    outcomes.length !== exactOutcomes.length ||
    exactOutcomes.some((outcome) => !outcomes.includes(outcome))
  )
    fail('Skill decision contract does not declare exactly the six outcomes');
  if (
    skillDecisionContract.input?.rawTranscriptRetention !== false ||
    skillDecisionContract.authority?.class !== 'read-only-advisory'
  )
    fail('Skill decision contract weakens the private read-only boundary');
  if (
    index.skillDecision?.policyRoot !== policyRoot ||
    intentMap.skillDecision?.policyRoot !== policyRoot ||
    !brief.includes(policyRoot)
  )
    fail(
      'Agent Pack index, intent map, and brief do not bind the Skill policy root',
    );
  for (const provider of ['codex', 'claude', 'amp', 'opencode']) {
    const providerSkill = read(`skills/${provider}/SKILL.md`);
    if (
      !providerSkill.includes(policyRoot) ||
      !providerSkill.includes('kungfu agent skill-advisory')
    )
      fail(
        `${provider} provider Skill does not bind the shared Skill decision`,
      );
  }
}
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
for (const [rel, text] of [
  ['brief.md', brief],
  ['skills/codex/SKILL.md', codexSkill],
]) {
  for (const phrase of ['kungfu agent first-value start', 'receiptRoot']) {
    if (!text.includes(phrase))
      fail(`${rel} missing deterministic first-value phrase: ${phrase}`);
  }
}
for (const phrase of [
  'kungfu xinfa contract --json',
  'kungfu xinfa schema task-envelope',
  'coordinator',
  'does not execute Xinfa',
]) {
  if (!xinfaContext.includes(phrase))
    fail(`xinfa-context.md missing authority boundary: ${phrase}`);
}
for (const phrase of [
  'kungfu-primitive-management-agent',
  '--actor agent',
  'context.projectionRoot',
  'kungfu primitive list --json',
  'kungfu primitive show fact --json',
  'kungfu primitive explain fact --json',
  'does not require a full Kungfu product build',
]) {
  if (!primitiveManagement.includes(phrase))
    fail(`primitive-management.md missing operational phrase: ${phrase}`);
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
    'trace',
    'managed-run',
    'remote-sync',
  ]) {
    if (!commands.modes?.[mode]) fail(`commands.json missing mode ${mode}`);
    if (!commands.modes?.[mode]?.maturity)
      fail(`commands.json mode ${mode} missing maturity`);
  }
}

if (cliSurface) {
  if (cliSurface.schema !== 'kungfu.cli-surface-catalog/v1')
    fail('cli_surface.catalog.json has an unknown schema');
  if (!Array.isArray(cliSurface.surfaces) || !cliSurface.surfaces.length)
    fail('cli_surface.catalog.json has no complete surface graph');
  if (cliSurface.projection?.consumers?.agentCapabilities !== 'embed-complete')
    fail('cli_surface.catalog.json is not bound to Agent capabilities');
}

if (apiRegistry) {
  const commandRoot = path.join(
    ROOT,
    'framework',
    'core',
    'src',
    'python',
    'kungfu',
    'cli',
    'commands',
  );
  const agentCli = AGENT_CLI_SOURCES.map((source) =>
    fs.readFileSync(path.join(commandRoot, source), 'utf8'),
  ).join('\n');
  const expectedRuntimeIds = new Set(
    (apiRegistry.apis || [])
      .filter((row) => row.anchor?.kind === 'runtime-click')
      .map((row) => row.id),
  );
  const observedAnchors = new Set(
    [...agentCli.matchAll(/@kfd3_api\("([^"]+)"\)/g)]
      .map((match) => match[1])
      .filter(
        (apiId) =>
          apiId === 'kungfu.agent' || apiId.startsWith('kungfu.agent.'),
      ),
  );
  for (const apiId of expectedRuntimeIds) {
    if (!observedAnchors.has(apiId))
      fail(`Agent CLI sources missing @kfd3_api("${apiId}")`);
  }
  for (const apiId of observedAnchors) {
    if (!expectedRuntimeIds.has(apiId))
      fail(`Agent CLI sources have stale @kfd3_api("${apiId}")`);
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
        bare.startsWith('kungfu rewind');
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
if (
  !gui.includes('kungfuAgentBriefCommand(') ||
  !gui.includes("navigateShell({ target: 'onboarding' })")
) {
  fail('GUI onboarding does not expose the exact local agent brief command');
}

const tui = fs.readFileSync(
  path.join(ROOT, 'framework', 'tui', 'src', 'main.tsx'),
  'utf8',
);
const tuiOnboarding = fs.readFileSync(
  path.join(ROOT, 'framework', 'tui', 'src', 'agent-work-lab-view.tsx'),
  'utf8',
);
if (
  !tui.includes('kungfuAgentBriefCommand(') ||
  !tuiOnboarding.includes('Exact local command:')
) {
  fail('TUI onboarding does not expose the exact local agent brief command');
}

if (failures.length) {
  console.error(failures.map((f) => `- ${f}`).join('\n'));
  process.exit(1);
}

console.log(
  `ok (${REQUIRED.length} files, ${commands?.commands?.length || 0} commands)`,
);
