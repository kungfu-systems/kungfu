#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

/** @param {any} value */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

/** @param {any} value */
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
    if (!['--xinfa', '--atlas', '--corpus', '--actor'].includes(key) || !value)
      throw new Error(
        'usage: qualify-route-resolver.mjs --xinfa FILE --atlas DIR --corpus FILE --actor ID',
      );
    result.set(key, value);
  }
  for (const key of ['--xinfa', '--atlas', '--corpus', '--actor'])
    if (!result.has(key)) throw new Error(`missing ${key}`);
  return result;
}

/** @param {string} binary @param {string} atlasDir @param {any} task */
function resolve(binary, atlasDir, task) {
  const result = spawnSync(
    binary,
    ['route', 'resolve', '--atlas', atlasDir, '--task', '-', '--json'],
    { input: `${JSON.stringify(task)}\n`, encoding: 'utf8' },
  );
  if (result.error || ![0, 1].includes(result.status ?? -1))
    throw new Error(
      `Xinfa resolver failed: ${result.error?.message || result.stderr || result.status}`,
    );
  return JSON.parse(result.stdout);
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
  if (corpus.schema !== 'xinfa.go-route-corpus/v1')
    throw new Error('unsupported route corpus');
  const outcomes = [];
  let correct = 0;
  let authorityRequired = 0;
  let authorityRecalled = 0;
  let falseGreen = 0;
  const routeFamilies = new Set();
  for (const item of corpus.cases) {
    const route = atlas.routes.find(
      (candidate) => candidate.id === item.expected_route,
    );
    if (!route)
      throw new Error(`missing expected route ${item.expected_route}`);
    const requiredAuthority = route.nodes.slice(0, 1);
    authorityRequired += requiredAuthority.length;
    routeFamilies.add(route.parityGroup);
    const task = {
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
        `route ${item.expected_route} is selected without omitted authority`,
      ],
      subjects: item.subjects,
      claims: [],
      ownership: item.ownership,
      dependencies: [],
      required_capabilities: item.capabilities,
      required_authority: requiredAuthority,
      requested_route: null,
      requested_parity_group: route.parityGroup,
      atlas: { atlas_root: atlas.atlas_root, cut_root: atlas.roots.cut },
    };
    const receipt = resolve(binary, atlasDir, task);
    const matched =
      receipt.status === 'resolved' &&
      receipt.selected_route === item.expected_route;
    if (matched) correct += 1;
    const selected = atlas.routes.find(
      (candidate) => candidate.id === receipt.selected_route,
    );
    authorityRecalled += requiredAuthority.filter((node) =>
      selected?.nodes.includes(node),
    ).length;

    const faultTask = structuredClone(task);
    faultTask.required_authority = [
      ...faultTask.required_authority,
      `qualification.missing-authority.${item.id}`,
    ];
    const fault = resolve(binary, atlasDir, faultTask);
    const faultRejected = fault.status !== 'resolved';
    if (!faultRejected) falseGreen += 1;
    outcomes.push({
      id: item.id,
      goal_id: item.goal_id,
      expected_route: item.expected_route,
      selected_route: receipt.selected_route,
      status: receipt.status,
      receipt_root: receipt.receipt_root,
      correct: matched,
      required_authority: requiredAuthority,
      required_authority_recalled: requiredAuthority.filter((node) =>
        selected?.nodes.includes(node),
      ).length,
      omission_fault_rejected: faultRejected,
      omission_fault_receipt_root: fault.receipt_root,
    });
  }
  const total = corpus.cases.length;
  const metrics = {
    cases: total,
    route_families: routeFamilies.size,
    top1_accuracy: total ? correct / total : 0,
    required_authority_recall: authorityRequired
      ? authorityRecalled / authorityRequired
      : 0,
    required_omission_false_green: falseGreen,
  };
  const thresholds = {
    cases: 20,
    route_families: 4,
    top1_accuracy: 0.9,
    required_authority_recall: 1,
    required_omission_false_green: 0,
  };
  const verdict =
    metrics.cases >= thresholds.cases &&
    metrics.route_families >= thresholds.route_families &&
    metrics.top1_accuracy >= thresholds.top1_accuracy &&
    metrics.required_authority_recall ===
      thresholds.required_authority_recall &&
    metrics.required_omission_false_green ===
      thresholds.required_omission_false_green
      ? 'pass'
      : 'fail';
  const content = {
    schema: 'xinfa.go-route-qualification/v1',
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
  process.stdout.write(`${JSON.stringify(canonical(receipt), null, 2)}\n`);
  process.exitCode = verdict === 'pass' ? 0 : 1;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
