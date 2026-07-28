#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const CONTRACT_PATH = 'docs/evolution/evolution-map.contract.json';
const ERA_ROOT = 'docs/evolution/eras';
const STAGE_ROOT = 'docs/evolution/stages';
const OUTPUTS = {
  map: 'docs/evolution/map.json',
  timeline: 'docs/evolution/timeline.md',
  authority: 'docs/evolution/current-authority.md',
  routes: 'docs/evolution/reader-routes.md',
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function identifier(value, label) {
  invariant(
    typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value),
    `${label} must be a lowercase kebab-case identifier`,
  );
}

function nonEmptyText(value, label) {
  invariant(
    typeof value === 'string' && value.trim().length > 0,
    `${label} must be non-empty text`,
  );
}

function textArray(value, label, { allowEmpty = false } = {}) {
  invariant(Array.isArray(value), `${label} must be an array`);
  invariant(allowEmpty || value.length > 0, `${label} must not be empty`);
  for (const [index, item] of value.entries())
    nonEmptyText(item, `${label}[${index}]`);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash('sha256')
    .update(`${JSON.stringify(canonical(value))}\n`)
    .digest('hex')}`;
}

export function parseEvolutionRecord(text, kind, file = '<memory>') {
  const fence = '```';
  const pattern = new RegExp(
    `${fence}json ${kind}\\n([\\s\\S]*?)\\n${fence}`,
    'g',
  );
  const matches = [...text.matchAll(pattern)];
  invariant(
    matches.length === 1,
    `${file} must contain exactly one ${kind} fence`,
  );
  try {
    return JSON.parse(matches[0][1]);
  } catch (error) {
    throw new Error(
      `${file} contains invalid ${kind} JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function period(value, label) {
  invariant(value && typeof value === 'object', `${label} must be an object`);
  invariant(
    /^\d{4}-\d{2}-\d{2}$/.test(value.start),
    `${label}.start must be YYYY-MM-DD`,
  );
  invariant(
    value.end === 'ongoing' || /^\d{4}-\d{2}-\d{2}$/.test(value.end),
    `${label}.end must be YYYY-MM-DD or ongoing`,
  );
  if (value.end !== 'ongoing')
    invariant(value.start <= value.end, `${label} must not run backwards`);
}

function validateReference(ref, label, contract, root) {
  invariant(ref && typeof ref === 'object', `${label} must be an object`);
  invariant(
    contract.evidenceKinds.includes(ref.kind),
    `${label}.kind is not supported`,
  );
  nonEmptyText(ref.ref, `${label}.ref`);
  nonEmptyText(ref.label, `${label}.label`);
  if (ref.kind === 'pull-request')
    invariant(
      /^https:\/\/github\.com\/kungfu-systems\/kungfu\/pull\/\d+$/.test(
        ref.ref,
      ),
      `${label}.ref must be a canonical Kungfu pull request URL`,
    );
  if (ref.kind === 'commit')
    invariant(
      /^[0-9a-f]{40}$/.test(ref.ref),
      `${label}.ref must be a full commit SHA`,
    );
  if (['adr', 'document'].includes(ref.kind)) {
    invariant(
      !path.isAbsolute(ref.ref) && !ref.ref.includes('..'),
      `${label}.ref must be repository-relative`,
    );
    invariant(
      fs.existsSync(path.join(root, ref.ref)),
      `${label}.ref does not exist: ${ref.ref}`,
    );
  }
}

function validateEra(era, file, contract) {
  invariant(
    era.schema === contract.eraSchema,
    `${file} has the wrong era schema`,
  );
  identifier(era.id, `${file}.id`);
  invariant(
    Number.isInteger(era.sequence) && era.sequence > 0,
    `${file}.sequence must be positive`,
  );
  nonEmptyText(era.title, `${file}.title`);
  period(era.period, `${file}.period`);
  textArray(era.buildsOn, `${file}.buildsOn`, { allowEmpty: true });
  nonEmptyText(era.thesis, `${file}.thesis`);
}

function validateStage(stage, file, contract, root) {
  invariant(
    stage.schema === contract.stageSchema,
    `${file} has the wrong stage schema`,
  );
  identifier(stage.id, `${file}.id`);
  identifier(stage.era, `${file}.era`);
  invariant(
    Number.isInteger(stage.sequence) && stage.sequence > 0,
    `${file}.sequence must be positive`,
  );
  invariant(
    contract.stageStatuses.includes(stage.status),
    `${file}.status is not supported`,
  );
  invariant(
    contract.evolutionImpacts.includes(stage.evolutionImpact),
    `${file}.evolutionImpact is not supported`,
  );
  period(stage.period, `${file}.period`);
  for (const field of [
    'title',
    'pressure',
    'priorLimitation',
    'localCapability',
    'compression',
  ])
    nonEmptyText(stage[field], `${file}.${field}`);
  for (const field of [
    'buildsOn',
    'retiredSurfaces',
    'unlockedCapabilities',
    'downstreamConsumers',
    'amends',
    'supersedes',
  ])
    textArray(stage[field], `${file}.${field}`, {
      allowEmpty: [
        'buildsOn',
        'retiredSurfaces',
        'amends',
        'supersedes',
      ].includes(field),
    });
  invariant(
    Array.isArray(stage.authorityTransitions) &&
      stage.authorityTransitions.length > 0,
    `${file}.authorityTransitions must not be empty`,
  );
  const subjects = new Set();
  for (const [index, transition] of stage.authorityTransitions.entries()) {
    const label = `${file}.authorityTransitions[${index}]`;
    identifier(transition.subject, `${label}.subject`);
    invariant(
      !subjects.has(transition.subject),
      `${file} repeats authority subject ${transition.subject}`,
    );
    subjects.add(transition.subject);
    nonEmptyText(transition.before, `${label}.before`);
    nonEmptyText(transition.after, `${label}.after`);
    textArray(transition.authorityRefs, `${label}.authorityRefs`);
    for (const ref of transition.authorityRefs)
      invariant(
        fs.existsSync(path.join(root, ref)),
        `${label} authority ref does not exist: ${ref}`,
      );
  }
  invariant(
    Array.isArray(stage.evidence) && stage.evidence.length > 0,
    `${file}.evidence must not be empty`,
  );
  stage.evidence.forEach((ref, index) =>
    validateReference(ref, `${file}.evidence[${index}]`, contract, root),
  );
  invariant(
    stage.readerRoute && typeof stage.readerRoute === 'object',
    `${file}.readerRoute must be an object`,
  );
  nonEmptyText(stage.readerRoute.intent, `${file}.readerRoute.intent`);
  nonEmptyText(stage.readerRoute.start, `${file}.readerRoute.start`);
  invariant(
    fs.existsSync(path.join(root, stage.readerRoute.start)),
    `${file}.readerRoute.start does not exist`,
  );
  textArray(stage.readerRoute.deepen, `${file}.readerRoute.deepen`);
  for (const ref of stage.readerRoute.deepen)
    invariant(
      fs.existsSync(path.join(root, ref)),
      `${file}.readerRoute.deepen ref does not exist: ${ref}`,
    );
}

export function buildEvolutionMap(
  erasInput,
  stagesInput,
  contract,
  root = ROOT,
) {
  const eras = erasInput
    .map((item) => ({ ...item }))
    .sort(
      (left, right) =>
        left.sequence - right.sequence || left.id.localeCompare(right.id),
    );
  const stages = stagesInput
    .map((item) => ({ ...item }))
    .sort(
      (left, right) =>
        left.sequence - right.sequence || left.id.localeCompare(right.id),
    );
  const eraIds = new Set();
  let previousEraSequence = 0;
  for (const era of eras) {
    validateEra(era, era.file, contract);
    invariant(!eraIds.has(era.id), `duplicate era id: ${era.id}`);
    invariant(
      era.sequence > previousEraSequence,
      `era sequence must be strictly increasing at ${era.id}`,
    );
    for (const predecessor of era.buildsOn)
      invariant(
        eraIds.has(predecessor),
        `${era.id} has dangling or forward buildsOn: ${predecessor}`,
      );
    eraIds.add(era.id);
    previousEraSequence = era.sequence;
  }
  invariant(
    eras.length > 0,
    'the evolution corpus must contain at least one era',
  );

  const stageIds = new Set();
  const authority = new Map();
  let previousStageSequence = 0;
  for (const stage of stages) {
    validateStage(stage, stage.file, contract, root);
    invariant(!stageIds.has(stage.id), `duplicate stage id: ${stage.id}`);
    invariant(
      eraIds.has(stage.era),
      `${stage.id} references unknown era: ${stage.era}`,
    );
    invariant(
      stage.sequence > previousStageSequence,
      `stage sequence must be strictly increasing at ${stage.id}`,
    );
    invariant(
      stageIds.size === 0 || stage.buildsOn.length > 0,
      `${stage.id} must build on at least one earlier Stage`,
    );
    for (const relation of ['buildsOn', 'amends', 'supersedes'])
      for (const predecessor of stage[relation])
        invariant(
          stageIds.has(predecessor),
          `${stage.id} has dangling or forward ${relation}: ${predecessor}`,
        );
    for (const transition of stage.authorityTransitions) {
      const prior = authority.get(transition.subject);
      if (prior)
        invariant(
          prior.authority === transition.before,
          `${stage.id} authority transition for ${transition.subject} expected before=${prior.authority}, got ${transition.before}`,
        );
      authority.set(transition.subject, {
        subject: transition.subject,
        authority: transition.after,
        sinceStage: stage.id,
        authorityRefs: transition.authorityRefs,
      });
    }
    stageIds.add(stage.id);
    previousStageSequence = stage.sequence;
  }
  invariant(
    stages.length > 0,
    'the evolution corpus must contain at least one stage',
  );

  const currentAuthority = [...authority.values()].sort((left, right) =>
    left.subject.localeCompare(right.subject),
  );
  const source = { eras, stages };
  return {
    schema: contract.projectionSchema,
    generatedFrom: {
      authority: 'append-only Era and Stage records under docs/evolution',
      semanticGraphAuthority:
        'Xinfa Atlas; this projection never creates current runtime authority',
      sourceRoot: digest(source),
    },
    summary: {
      eras: eras.length,
      stages: stages.length,
      evidence: stages.reduce(
        (total, stage) => total + stage.evidence.length,
        0,
      ),
      authoritySubjects: currentAuthority.length,
    },
    eras,
    stages,
    currentAuthority,
  };
}

function markdownLink(from, target, label = target) {
  return `[${label}](${path.posix.relative(path.posix.dirname(from), target)})`;
}

export function renderTimeline(projection) {
  const lines = [
    '# Kungfu Evolution Timeline',
    '',
    'This page is generated from the append-only Era and Stage corpus. It is a',
    'longitudinal learning path, not a replacement for current architecture, runtime,',
    'or qualification authority.',
    '',
    `Coverage: **${projection.summary.eras} eras**, **${projection.summary.stages} stages**, and **${projection.summary.evidence} evidence references**.`,
    '',
  ];
  for (const era of projection.eras) {
    lines.push(
      `## Era ${era.sequence}: ${era.title}`,
      '',
      `Era record: ${markdownLink(OUTPUTS.timeline, era.file, era.id)}`,
      '',
      era.thesis,
      '',
    );
    for (const stage of projection.stages.filter(
      (item) => item.era === era.id,
    )) {
      lines.push(
        `### ${stage.sequence}. ${stage.title}`,
        '',
        `**Period:** ${stage.period.start} to ${stage.period.end} · **Recorded status:** ${stage.status}`,
        '',
        `**Pressure:** ${stage.pressure}`,
        '',
        `**Compression:** ${stage.compression}`,
        '',
        `${markdownLink(OUTPUTS.timeline, stage.file, 'Open the immutable Stage record')} for the full capability, authority transition, downstream consumers, and evidence.`,
        '',
      );
    }
  }
  lines.push(
    '## Maintenance',
    '',
    'Add a successor or amendment record; do not edit a Stage that already exists on',
    'the protected base. Regenerate with `./shifu evolution:map`. The documentation',
    'and source gates reject stale projections and settled-history mutation.',
    '',
  );
  return lines.join('\n');
}

export function renderAuthority(projection) {
  const lines = [
    '# Current Authority Through the Evolution Lens',
    '',
    'This generated table folds declared authority transitions across the historical',
    'Stage corpus. It tells a reader where to continue; every referenced current',
    'contract remains authoritative over this navigation projection.',
    '',
    '| Subject | Current authority | Since | Exact current references |',
    '|---|---|---|---|',
  ];
  for (const item of projection.currentAuthority) {
    const stage = projection.stages.find(
      (candidate) => candidate.id === item.sinceStage,
    );
    const refs = item.authorityRefs
      .map((ref) => markdownLink(OUTPUTS.authority, ref, ref))
      .join('<br>');
    lines.push(
      `| ${item.subject} | ${item.authority} | ${markdownLink(OUTPUTS.authority, stage.file, stage.title)} | ${refs} |`,
    );
  }
  lines.push(
    '',
    `Machine projection: ${markdownLink(OUTPUTS.authority, OUTPUTS.map, 'map.json')}.`,
    '',
  );
  return lines.join('\n');
}

export function renderReaderRoutes(projection) {
  const lines = [
    '# Evolution Reader Routes',
    '',
    'Start with the timeline when repository breadth is the problem. Then choose the',
    'closest historical pressure below and cross into the exact current authority.',
    'Agents should request the paired `kungfu-evolution-map-agent` Xinfa route.',
    '',
  ];
  for (const stage of projection.stages) {
    lines.push(
      `## ${stage.readerRoute.intent}`,
      '',
      `Historical context: ${markdownLink(OUTPUTS.routes, stage.file, stage.title)}.`,
      '',
      `Start current reading at ${markdownLink(OUTPUTS.routes, stage.readerRoute.start)}.`,
      '',
      `Deepen through ${stage.readerRoute.deepen.map((ref) => markdownLink(OUTPUTS.routes, ref)).join(', ')}.`,
      '',
    );
  }
  return lines.join('\n');
}

function readRecords(root, relativeRoot, fence) {
  const directory = path.join(root, relativeRoot);
  return fs
    .readdirSync(directory)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => {
      const relative = path.posix.join(relativeRoot, file);
      return {
        ...parseEvolutionRecord(
          fs.readFileSync(path.join(root, relative), 'utf8'),
          fence,
          relative,
        ),
        file: relative,
      };
    });
}

function runGit(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0 && !allowFailure)
    throw new Error(
      `git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`,
    );
  return result.status === 0 ? result.stdout.trim() : '';
}

function checkHistoricalIntegrity() {
  const base =
    process.env.KUNGFU_EVOLUTION_BASE ||
    runGit(['merge-base', 'origin/dev/v4/v4.0', 'HEAD'], {
      allowFailure: true,
    }) ||
    runGit(['merge-base', 'dev/v4/v4.0', 'HEAD']);
  const changed = runGit([
    'diff',
    '--name-status',
    base,
    '--',
    ERA_ROOT,
    STAGE_ROOT,
  ]);
  for (const line of changed.split('\n').filter(Boolean)) {
    const [status, file] = line.split('\t');
    if (!['M', 'D'].includes(status)) continue;
    const existed =
      spawnSync('git', ['cat-file', '-e', `${base}:${file}`], {
        cwd: ROOT,
        stdio: 'ignore',
      }).status === 0;
    invariant(
      !existed,
      `${file} is settled history on ${base}; add an amendment or successor Stage instead of ${status === 'D' ? 'deleting' : 'editing'} it`,
    );
  }
}

function checkPullRequestTemplate(contract) {
  const template = fs.readFileSync(
    path.join(ROOT, '.github/pull_request_template.md'),
    'utf8',
  );
  const marker = `Evolution impact: <!-- ${contract.evolutionImpacts.join(' | ')} -->`;
  invariant(
    template.includes(marker),
    `.github/pull_request_template.md must contain: ${marker}`,
  );
}

export function findUnlinkedEvolutionMapMentions(entries) {
  const violations = [];
  for (const { file, text } of entries) {
    if (file === 'docs/evolution/README.md') continue;
    let fenced = false;
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (fenced || !/\bevolution map\b/i.test(line)) continue;
      if (
        file.startsWith('docs/adr/') &&
        /^#\s+.*\bevolution map\b/i.test(line)
      )
        continue;
      if (/\[[^\]]*\bevolution map\b[^\]]*\]\([^)]+\)/i.test(line)) continue;
      violations.push(`${file}:${index + 1}`);
    }
  }
  return violations;
}

function checkEvolutionMapNavigation() {
  const markdownFiles = runGit(['ls-files', '--', '*.md'])
    .split('\n')
    .filter(Boolean);
  const violations = findUnlinkedEvolutionMapMentions(
    markdownFiles.map((file) => ({
      file,
      text: fs.readFileSync(path.join(ROOT, file), 'utf8'),
    })),
  );
  invariant(
    violations.length === 0,
    `Evolution Map mentions must link to a navigation target: ${violations.join(', ')}`,
  );
}

function outputs() {
  const contract = JSON.parse(
    fs.readFileSync(path.join(ROOT, CONTRACT_PATH), 'utf8'),
  );
  const eras = readRecords(ROOT, ERA_ROOT, contract.recordFences.era);
  const stages = readRecords(ROOT, STAGE_ROOT, contract.recordFences.stage);
  const projection = buildEvolutionMap(eras, stages, contract, ROOT);
  checkHistoricalIntegrity();
  checkPullRequestTemplate(contract);
  checkEvolutionMapNavigation();
  return new Map([
    [OUTPUTS.map, `${JSON.stringify(projection, null, 2)}\n`],
    [OUTPUTS.timeline, renderTimeline(projection)],
    [OUTPUTS.authority, renderAuthority(projection)],
    [OUTPUTS.routes, renderReaderRoutes(projection)],
  ]);
}

function main(argv) {
  const check = argv.includes('--check');
  const write = argv.includes('--write') || !check;
  if (argv.some((arg) => !['--check', '--write'].includes(arg)))
    throw new Error(`unknown argument: ${argv.join(' ')}`);
  for (const [relative, content] of outputs()) {
    const target = path.join(ROOT, relative);
    if (check) {
      const actual = fs.existsSync(target)
        ? fs.readFileSync(target, 'utf8')
        : '';
      invariant(
        actual === content,
        `${relative} is stale; run ./shifu evolution:map`,
      );
    }
    if (write) fs.writeFileSync(target, content);
  }
  process.stdout.write(
    `[evolution-map] ${check ? 'current' : 'generated'} ${Object.values(OUTPUTS).join(', ')}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `[evolution-map] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
