#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { sourceCommandArguments } from './source-command-arguments.mjs';

/** @param {unknown} value */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

/** @param {unknown} value */
function digest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(`${JSON.stringify(canonical(value))}\n`)
    .digest('hex')}`;
}

function argumentsFromCli() {
  const result = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (
      !['--xinfa', '--atlas', '--corpus', '--actor', '--output'].includes(
        key,
      ) ||
      !value
    )
      throw new Error(
        'usage: qualify-context-quality.mjs --xinfa FILE --atlas DIR --corpus FILE --actor ID [--output FILE]',
      );
    result.set(key, value);
  }
  for (const key of ['--xinfa', '--atlas', '--corpus', '--actor'])
    if (!result.has(key)) throw new Error(`missing ${key}`);
  return result;
}

/**
 * @param {string} binary
 * @param {string[]} args
 * @param {unknown} [input]
 */
function invoke(binary, args, input) {
  const result = spawnSync(binary, sourceCommandArguments(binary, args), {
    input: input === undefined ? undefined : `${JSON.stringify(input)}\n`,
    encoding: 'utf8',
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(binary),
  });
  if (result.error || ![0, 1].includes(result.status ?? -1))
    throw new Error(
      `Xinfa invocation failed: ${result.error?.message || result.stderr || result.status}`,
    );
  return JSON.parse(result.stdout);
}

/**
 * Invalid-root faults are rejected before Xinfa can emit a resolution receipt.
 * Treat only that explicit fail-closed diagnostic as an expected rejection.
 * @param {string} binary
 * @param {string[]} args
 * @param {unknown} input
 */
function invokeBindingFault(binary, args, input) {
  const result = spawnSync(binary, sourceCommandArguments(binary, args), {
    input: `${JSON.stringify(input)}\n`,
    encoding: 'utf8',
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(binary),
  });
  if ([0, 1].includes(result.status ?? -1)) return JSON.parse(result.stdout);
  const diagnostic = (result.stderr || '').trim();
  if (
    result.status === 2 &&
    diagnostic.includes('task envelope is not bound to this Atlas root and cut')
  )
    return { status: 'rejected', diagnostic };
  throw new Error(
    `Xinfa binding-fault invocation failed: ${result.error?.message || diagnostic || result.status}`,
  );
}

/** @param {any} atlas @param {any} item */
function taskEnvelope(atlas, item) {
  const route = atlas.routes.find(
    (candidate) => candidate.id === item.expected_route,
  );
  if (!route) throw new Error(`missing expected route ${item.expected_route}`);
  const nodeByPath = new Map(
    atlas.semantic.nodes.map((node) => [node.source.path, node.id]),
  );
  const requiredAuthority = item.critical_sources.map((source) => {
    const node = nodeByPath.get(source);
    if (!node || !route.nodes.includes(node))
      throw new Error(
        `${item.id} critical source ${source} is not in ${route.id}`,
      );
    return node;
  });
  return {
    schema: 'xinfa.task-envelope/v1',
    kind: 'xinfa.task-envelope/v1',
    objective: item.objective,
    audience: 'agent',
    role: item.role,
    visibility: 'public',
    mission: {
      id: 'kungfu-technical-stewardship',
      lens: 'principal-engineer',
      track: item.mission_track,
    },
    acceptance: [
      `route ${item.expected_route} includes every declared critical source`,
    ],
    subjects: item.subjects,
    claims: [],
    ownership: item.ownership,
    dependencies: [],
    required_capabilities: item.capabilities,
    required_authority: requiredAuthority,
    requested_route: null,
    requested_parity_group: null,
    atlas: { atlas_root: atlas.atlas_root, cut_root: atlas.roots.cut },
  };
}

function main() {
  const args = argumentsFromCli();
  const binary = /** @type {string} */ (args.get('--xinfa'));
  const atlasDir = /** @type {string} */ (args.get('--atlas'));
  const actor = /** @type {string} */ (args.get('--actor'));
  const corpus = JSON.parse(
    fs.readFileSync(/** @type {string} */ (args.get('--corpus')), 'utf8'),
  );
  const atlas = JSON.parse(fs.readFileSync(`${atlasDir}/atlas.json`, 'utf8'));
  if (corpus.schema !== 'xinfa.context-quality-corpus/v1')
    throw new Error('unsupported context quality corpus');

  const outcomes = [];
  const routeFamilies = new Set();
  const scenarioFamilies = new Set();
  let criticalRequired = 0;
  let criticalRecalled = 0;
  let requiredOmissions = 0;
  let irrelevantTokens = 0;
  let totalTokens = 0;
  let ambiguous = 0;
  let degraded = 0;
  let staleDetected = 0;
  let corrections = 0;
  let fallbacks = 0;
  let maxExpansionHops = 0;

  for (const item of corpus.cases) {
    const task = taskEnvelope(atlas, item);
    const route = atlas.routes.find(
      (candidate) => candidate.id === item.expected_route,
    );
    routeFamilies.add(route.parityGroup);
    scenarioFamilies.add(item.scenario);

    const resolution = invoke(
      binary,
      ['route', 'resolve', '--atlas', atlasDir, '--task', '-', '--json'],
      task,
    );
    const routeCorrect =
      resolution.status === 'resolved' &&
      resolution.selected_route === item.expected_route;
    if (!routeCorrect) corrections += 1;
    if (resolution.status === 'ambiguous') ambiguous += 1;

    const context = invoke(binary, [
      'context',
      '--atlas',
      atlasDir,
      '--route',
      item.expected_route,
      '--task',
      item.objective,
      '--role',
      item.role,
      '--budget',
      String(item.budget),
      '--json',
    ]);
    if (context.status !== 'complete') degraded += 1;
    requiredOmissions += context.omissions.filter(
      (omission) => omission.required,
    ).length;
    maxExpansionHops = Math.max(
      maxExpansionHops,
      context.expansion_handles.length === 0 ? 0 : 1,
    );

    const acceptableSources = new Set([
      ...item.critical_sources,
      ...item.optional_sources,
    ]);
    const selectedSources = new Set(
      context.units.map((unit) => unit.source.path),
    );
    const recalled = item.critical_sources.filter((source) =>
      selectedSources.has(source),
    ).length;
    criticalRequired += item.critical_sources.length;
    criticalRecalled += recalled;
    for (const unit of context.units) {
      const tokens = unit.tokens ?? 0;
      totalTokens += tokens;
      if (!acceptableSources.has(unit.source.path)) irrelevantTokens += tokens;
    }

    const staleTask = structuredClone(task);
    staleTask.atlas.atlas_root = `sha256:${'0'.repeat(64)}`;
    const stale = invokeBindingFault(
      binary,
      ['route', 'resolve', '--atlas', atlasDir, '--task', '-', '--json'],
      staleTask,
    );
    const staleRejected = stale.status !== 'resolved';
    if (staleRejected) staleDetected += 1;

    const missingTask = structuredClone(task);
    missingTask.required_authority.push(
      `qualification.missing-authority.${item.id}`,
    );
    const missing = invoke(
      binary,
      ['route', 'resolve', '--atlas', atlasDir, '--task', '-', '--json'],
      missingTask,
    );
    const missingRejected = missing.status !== 'resolved';

    const insufficient = invoke(binary, [
      'context',
      '--atlas',
      atlasDir,
      '--route',
      item.expected_route,
      '--task',
      item.objective,
      '--role',
      item.role,
      '--budget',
      '1',
      '--json',
    ]);
    const budgetRejected =
      insufficient.status === 'degraded' &&
      insufficient.omissions.some(
        (omission) => omission.required && omission.reason === 'token-budget',
      );

    if (['kungfu-agent-surfaces', 'kungfu-human-surfaces'].includes(route.id))
      fallbacks += 1;
    outcomes.push({
      id: item.id,
      scenario: item.scenario,
      expected_route: item.expected_route,
      selected_route: resolution.selected_route,
      route_status: resolution.status,
      route_receipt_root: resolution.receipt_root,
      route_correct: routeCorrect,
      critical_sources: item.critical_sources,
      critical_sources_recalled: recalled,
      context_status: context.status,
      projection_root: context.projection_root,
      token_cost: context.budget.used_tokens,
      required_omissions: context.omissions.filter(
        (omission) => omission.required,
      ).length,
      expansion_handles: context.expansion_handles.length,
      stale_fault_rejected: staleRejected,
      missing_authority_fault_rejected: missingRejected,
      insufficient_budget_fault_rejected: budgetRejected,
    });
  }

  const cases = corpus.cases.length;
  const metrics = {
    cases,
    route_families: routeFamilies.size,
    scenario_families: scenarioFamilies.size,
    critical_source_recall: criticalRequired
      ? criticalRecalled / criticalRequired
      : 0,
    required_omission_rate: cases ? requiredOmissions / cases : 1,
    irrelevant_context_ratio: totalTokens ? irrelevantTokens / totalTokens : 1,
    route_ambiguity_rate: cases ? ambiguous / cases : 1,
    degraded_rate: cases ? degraded / cases : 1,
    stale_detection_rate: cases ? staleDetected / cases : 0,
    human_correction_rate: cases ? corrections / cases : 1,
    fallback_rate: cases ? fallbacks / cases : 1,
    token_cost_total: totalTokens,
    token_cost_max: Math.max(...outcomes.map((item) => item.token_cost)),
    max_expansion_hops: maxExpansionHops,
  };
  const thresholds = corpus.thresholds;
  const faultGreen = outcomes.every(
    (item) =>
      item.stale_fault_rejected &&
      item.missing_authority_fault_rejected &&
      item.insufficient_budget_fault_rejected,
  );
  const verdict =
    metrics.cases >= thresholds.cases &&
    metrics.route_families >= thresholds.route_families &&
    metrics.scenario_families >= thresholds.scenario_families &&
    metrics.critical_source_recall === thresholds.critical_source_recall &&
    metrics.required_omission_rate === thresholds.required_omission_rate &&
    metrics.irrelevant_context_ratio <=
      thresholds.irrelevant_context_ratio_max &&
    metrics.route_ambiguity_rate === thresholds.route_ambiguity_rate &&
    metrics.degraded_rate === thresholds.degraded_rate &&
    metrics.stale_detection_rate === thresholds.stale_detection_rate &&
    metrics.human_correction_rate === thresholds.human_correction_rate &&
    metrics.fallback_rate === thresholds.fallback_rate &&
    metrics.max_expansion_hops <= thresholds.max_expansion_hops &&
    faultGreen
      ? 'pass'
      : 'fail';
  const content = {
    schema: 'xinfa.context-quality-qualification/v1',
    actor,
    verdict,
    atlas_root: atlas.atlas_root,
    cut_root: atlas.roots.cut,
    corpus_root: digest(corpus),
    thresholds,
    metrics,
    outcomes,
  };
  const receipt = { ...content, qualification_root: digest(content) };
  const rendered = `${JSON.stringify(canonical(receipt), null, 2)}\n`;
  const output = args.get('--output');
  if (output) fs.writeFileSync(output, rendered);
  process.stdout.write(rendered);
  process.exitCode = verdict === 'pass' ? 0 : 1;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
