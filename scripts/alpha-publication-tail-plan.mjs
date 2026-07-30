#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sourceBinding } from './alpha-promotion-preflight.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = 'kungfu.alpha-publication-tail-plan/v1';
const REQUIRED_FRESH_EVIDENCE = [
  'credentials',
  'github-release',
  'notarization',
  'publication',
  'public-readback',
  'signing',
];

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
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(JSON.stringify(canonical(value)));
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function required(value, label) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`${label} is required`);
  return value.trim();
}

function exactSha(value, label) {
  const normalized = required(value, label);
  if (!/^[a-f0-9]{40}$/u.test(normalized))
    throw new Error(`${label} must be an exact Git SHA`);
  return normalized;
}

function productVersion(root) {
  const lerna = JSON.parse(
    fs.readFileSync(path.join(root, 'lerna.json'), 'utf8'),
  );
  return required(lerna.version, 'lerna version');
}

function withPlanRoot(plan) {
  return { ...plan, planRoot: digest(plan) };
}

export function buildAlphaPublicationTailPlan({
  root = ROOT,
  sourceCommit,
  sourceTree,
  version = productVersion(root),
  generatedAt = new Date().toISOString(),
}) {
  const binding = sourceBinding(root);
  const expectedCommit = exactSha(sourceCommit, 'sourceCommit');
  const expectedTree = exactSha(sourceTree, 'sourceTree');
  if (binding.sourceCommit !== expectedCommit)
    throw new Error('publication tail source commit does not match checkout');
  if (binding.sourceTree !== expectedTree)
    throw new Error('publication tail source tree does not match checkout');
  const exactVersion = required(version, 'version');
  return withPlanRoot({
    schema: SCHEMA,
    status: 'precomputed',
    generatedAt: new Date(generatedAt).toISOString(),
    identity: {
      channel: 'alpha',
      sourceCommit: expectedCommit,
      sourceTree: expectedTree,
      version: exactVersion,
      releaseTag: `v${exactVersion}`,
    },
    binding,
    publication: {
      channelUrl: 'https://kungfu.tech/.well-known/kungfu/alpha.json',
      canonicalBaseUrl: 'https://kungfu.tech',
      releaseRepository: 'kungfu-systems/kungfu',
      activation: 'single-fail-closed-publication-commit',
    },
    reuse: {
      scope: 'non-secret-publication-tail-inputs-only',
      requiredFreshEvidence: REQUIRED_FRESH_EVIDENCE,
    },
  });
}

export function verifyAlphaPublicationTailPlan({
  root = ROOT,
  plan,
  expectedSourceCommit,
  expectedVersion,
}) {
  const { planRoot, ...body } = plan || {};
  if (planRoot !== digest(body))
    throw new Error('publication tail plan root mismatch');
  if (plan.schema !== SCHEMA || plan.status !== 'precomputed')
    throw new Error('publication tail plan is not qualifying');
  if (
    plan.identity?.sourceCommit !==
    exactSha(expectedSourceCommit, 'expectedSourceCommit')
  )
    throw new Error('publication tail source commit mismatch');
  const version = required(expectedVersion, 'expectedVersion');
  if (
    plan.identity.version !== version ||
    plan.identity.releaseTag !== `v${version}`
  )
    throw new Error('publication tail version or tag mismatch');
  const current = sourceBinding(root);
  for (const [field, value] of Object.entries(current)) {
    if (field === 'sourceCommit') continue;
    if (plan.binding?.[field] !== value)
      throw new Error(`publication tail ${field} mismatch`);
  }
  if (plan.identity.sourceTree !== current.sourceTree)
    throw new Error('publication tail source tree mismatch');
  if (
    JSON.stringify(plan.reuse?.requiredFreshEvidence) !==
    JSON.stringify(REQUIRED_FRESH_EVIDENCE)
  )
    throw new Error('publication tail fresh-evidence boundary drifted');
  return plan;
}

export function findAlphaPublicationTailPlan(root) {
  const matches = [];
  const stack = [path.resolve(root)];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (
        entry.isFile() &&
        entry.name === 'alpha-publication-tail-plan.json'
      )
        matches.push(target);
    }
  }
  if (matches.length !== 1)
    throw new Error(
      `expected exactly one Alpha publication tail plan, found ${matches.length}`,
    );
  return matches[0];
}

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!flag?.startsWith('--') || index + 1 >= rest.length)
      throw new Error(
        `invalid publication tail option: ${flag || '<missing>'}`,
      );
    options[flag.slice(2)] = rest[index + 1];
  }
  return { command, options };
}

function main(argv = process.argv.slice(2)) {
  const { command, options } = parse(argv);
  if (command === 'write') {
    const output = path.resolve(required(options.out, '--out'));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(
      output,
      `${JSON.stringify(
        buildAlphaPublicationTailPlan({
          sourceCommit: options['source-commit'],
          sourceTree: options['source-tree'],
        }),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (command === 'verify') {
    const plan = JSON.parse(
      fs.readFileSync(path.resolve(required(options.plan, '--plan')), 'utf8'),
    );
    verifyAlphaPublicationTailPlan({
      plan,
      expectedSourceCommit: options['source-commit'],
      expectedVersion: options.version || productVersion(ROOT),
    });
    return;
  }
  throw new Error(
    `unknown Alpha publication tail command: ${command || '<missing>'}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
