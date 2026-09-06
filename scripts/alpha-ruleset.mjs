#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  activeProjection,
  readAuthority,
} from '@kungfu-tech/product-kungfu/version-line/version-line-authority';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTHORITY = readAuthority();
const { line: ACTIVE_LINE } = activeProjection(AUTHORITY);
const CONTRACTS = new Map([
  [
    'kungfu.alpha-ruleset-contract/v1',
    {
      label: 'Alpha',
      targetRef: ACTIVE_LINE.branches.alpha,
      inspectionSchema: 'kungfu.alpha-ruleset-inspection/v1',
    },
  ],
  [
    'kungfu.stable-ruleset-contract/v1',
    {
      label: 'Stable',
      targetRef: ACTIVE_LINE.branches.stable,
      inspectionSchema: 'kungfu.stable-ruleset-inspection/v1',
    },
  ],
]);

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

export function digest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;
}

function required(value, label) {
  const text = String(value || '').trim();
  if (!text || /[\r\n\0]/u.test(text)) throw new Error(`${label} is required`);
  return text;
}

function normalizeRule(rule) {
  const value = structuredClone(rule || {});
  if (value.type === 'required_status_checks') {
    value.parameters.required_status_checks = [
      ...(value.parameters?.required_status_checks || []),
    ].sort((left, right) =>
      `${left.context}:${left.integration_id || ''}`.localeCompare(
        `${right.context}:${right.integration_id || ''}`,
      ),
    );
  }
  if (value.type === 'pull_request') {
    value.parameters.allowed_merge_methods = [
      ...(value.parameters?.allowed_merge_methods || []),
    ].sort();
    value.parameters.required_reviewers = [
      ...(value.parameters?.required_reviewers || []),
    ].sort();
    if (value.parameters.dismissal_restriction) {
      value.parameters.dismissal_restriction.allowed_actors = [
        ...(value.parameters.dismissal_restriction.allowed_actors || []),
      ].sort();
    }
  }
  return value;
}

export function normalizeRuleset(ruleset) {
  return {
    name: required(ruleset?.name, 'ruleset.name'),
    target: required(ruleset?.target, 'ruleset.target'),
    enforcement: required(ruleset?.enforcement, 'ruleset.enforcement'),
    bypass_actors: [...(ruleset?.bypass_actors || [])].sort((left, right) =>
      `${left.actor_type}:${left.actor_id}:${left.bypass_mode}`.localeCompare(
        `${right.actor_type}:${right.actor_id}:${right.bypass_mode}`,
      ),
    ),
    conditions: canonical(ruleset?.conditions || {}),
    rules: [...(ruleset?.rules || [])]
      .map(normalizeRule)
      .sort((left, right) => left.type.localeCompare(right.type)),
  };
}

export function validateContract(contract) {
  const specification = CONTRACTS.get(contract?.schema);
  if (!specification || contract.status !== 'active')
    throw new Error('Release channel ruleset contract is not active');
  if (contract.repository !== 'kungfu-systems/kungfu')
    throw new Error(
      `${specification.label} ruleset repository is not admitted`,
    );
  if (contract.versionLineAuthorityRoot !== AUTHORITY.authorityRoot)
    throw new Error(
      `${specification.label} ruleset version-line authority root mismatch`,
    );
  if (contract.targetRef !== specification.targetRef)
    throw new Error(
      `${specification.label} ruleset target ref is not admitted`,
    );
  const { contractRoot, ...body } = contract;
  if (contractRoot !== digest(body))
    throw new Error(`${specification.label} ruleset contract root mismatch`);
  const desired = normalizeRuleset(contract.ruleset);
  if (
    desired.conditions?.ref_name?.include?.length !== 1 ||
    desired.conditions.ref_name.include[0] !==
      `refs/heads/${contract.targetRef}` ||
    desired.conditions.ref_name.exclude?.length !== 0
  )
    throw new Error(
      `${specification.label} ruleset must target one exact branch`,
    );
  if (desired.bypass_actors.length !== 0)
    throw new Error(
      `${specification.label} ruleset contract cannot declare bypass actors`,
    );
  const types = desired.rules.map(({ type }) => type);
  for (const type of [
    'deletion',
    'non_fast_forward',
    'pull_request',
    'required_status_checks',
  ]) {
    if (types.filter((candidate) => candidate === type).length !== 1)
      throw new Error(
        `${specification.label} ruleset requires exactly one ${type} rule`,
      );
  }
  return contract;
}

export function compareRuleset(contract, liveRulesets) {
  validateContract(contract);
  const expectedRef = `refs/heads/${contract.targetRef}`;
  const matching = (liveRulesets || []).filter((ruleset) => {
    const refName = ruleset?.conditions?.ref_name || {};
    return (
      ruleset.target === 'branch' &&
      refName.include?.length === 1 &&
      refName.include[0] === expectedRef &&
      (refName.exclude || []).length === 0
    );
  });
  if (matching.length === 0)
    return {
      status: 'missing',
      qualifying: false,
      expected: normalizeRuleset(contract.ruleset),
      observed: null,
    };
  if (matching.length > 1)
    return {
      status: 'ambiguous',
      qualifying: false,
      expected: normalizeRuleset(contract.ruleset),
      observed: matching.map(normalizeRuleset),
    };
  const expected = normalizeRuleset(contract.ruleset);
  const observed = normalizeRuleset(matching[0]);
  const qualifying =
    JSON.stringify(canonical(observed)) === JSON.stringify(canonical(expected));
  return {
    status: qualifying ? 'matching' : 'drifted',
    qualifying,
    expected,
    observed,
  };
}

function github(route) {
  const result = childProcess.spawnSync(
    'gh',
    [
      'api',
      route,
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2022-11-28',
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (result.status !== 0)
    throw new Error(`GitHub read failed closed for ${route}`);
  return JSON.parse(String(result.stdout || 'null'));
}

function inspect(contract) {
  const specification = CONTRACTS.get(contract.schema);
  const listed = github(
    `repos/${contract.repository}/rulesets?includes_parents=false&per_page=100`,
  );
  const detailed = listed.map((entry) =>
    github(`repos/${contract.repository}/rulesets/${entry.id}`),
  );
  return {
    schema: specification.inspectionSchema,
    repository: contract.repository,
    targetRef: contract.targetRef,
    contractRoot: contract.contractRoot,
    ...compareRuleset(contract, detailed),
  };
}

function parse(argv) {
  const [command = 'inspect', ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith('--')) throw new Error(`invalid option: ${value}`);
    const name = value.slice(2);
    if (
      [
        'create-if-missing',
        'block-deletions',
        'block-non-fast-forward',
      ].includes(name)
    ) {
      options[name] = true;
    } else {
      options[name] = rest[++index];
    }
  }
  return { command, options };
}

function runBuildchain(bin, args) {
  const command = bin.endsWith('.mjs') ? process.execPath : bin;
  const commandArgs = bin.endsWith('.mjs')
    ? [bin, 'github-governance', ...args]
    : ['github-governance', ...args];
  const result = childProcess.spawnSync(command, commandArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  if (result.status !== 0)
    throw new Error(
      `Buildchain governance failed closed: ${String(
        result.stderr || result.stdout || '',
      ).trim()}`,
    );
  process.stdout.write(result.stdout);
}

function readContract(file) {
  const contract = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  return validateContract(contract);
}

function main(argv = process.argv.slice(2)) {
  const { command, options } = parse(argv);
  const contract = readContract(
    options.contract ||
      path.join(ROOT, 'docs/qualification/alpha-ruleset.contract.json'),
  );
  if (['inspect', 'diff'].includes(command)) {
    const result = inspect(contract);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (command === 'inspect' && !result.qualifying) process.exitCode = 1;
    return;
  }
  const bin = required(
    options['buildchain-bin'] ||
      path.join(ROOT, 'node_modules/.bin/buildchain'),
    '--buildchain-bin',
  );
  if (command === 'plan') {
    runBuildchain(bin, [
      'ruleset-policy-plan',
      '--repository',
      contract.repository,
      '--branch',
      contract.targetRef,
      '--ruleset-name',
      contract.ruleset.name,
      '--create-if-missing',
      '--block-deletions',
      '--block-non-fast-forward',
      '--snapshot-output',
      required(options.snapshot, '--snapshot'),
      '--plan-output',
      required(options.plan, '--plan'),
    ]);
    return;
  }
  if (command === 'apply') {
    runBuildchain(bin, [
      'ruleset-policy-apply',
      '--plan-json',
      required(options.plan, '--plan'),
      '--confirm-plan-root',
      required(options.confirm, '--confirm'),
    ]);
    return;
  }
  if (command === 'rollback') {
    const args = [
      'ruleset-policy-rollback',
      '--plan-json',
      required(options.plan, '--plan'),
      '--confirm-rollback-root',
      required(options.confirm, '--confirm'),
    ];
    if (options['apply-receipt'])
      args.push('--apply-receipt', options['apply-receipt']);
    runBuildchain(bin, args);
    return;
  }
  throw new Error(`unknown release channel ruleset command: ${command}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
