#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
export const AUTHORITY_PATH = path.join(
  ROOT,
  'product/version-line/version-line-authority.json',
);
export const PROJECTION_PATH = path.join(
  ROOT,
  'product/version-line/version-line-projections.json',
);

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

function withoutRoot(value, rootField) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== rootField),
  );
}

function requiredText(value, label) {
  const text = String(value || '').trim();
  if (!text || /[\0\r\n]/u.test(text)) throw new Error(`${label} is required`);
  return text;
}

function expand(template, line) {
  return requiredText(template, 'branch template')
    .replaceAll('{major}', String(line.major))
    .replaceAll('{minor}', String(line.minor));
}

export function validateAuthority(authority) {
  if (
    authority?.schema !== 'kungfu.version-line-authority/v1' ||
    authority.status !== 'active' ||
    authority.repository !== 'kungfu-systems/kungfu'
  ) {
    throw new Error('version-line authority is not active or admitted');
  }
  const templates = authority.branchTemplates || {};
  for (const key of [
    'dev',
    'alpha',
    'stable',
    'majorPublicationGate',
    'candidateLedger',
  ]) {
    const template = requiredText(templates[key], `branchTemplates.${key}`);
    if (!template.includes('{major}') || !template.includes('{minor}')) {
      throw new Error(`branchTemplates.${key} must be version-generic`);
    }
  }
  if (!Array.isArray(authority.lines) || authority.lines.length === 0) {
    throw new Error('version-line authority requires at least one line');
  }
  const ids = new Set();
  for (const line of authority.lines) {
    if (
      !Number.isInteger(line.major) ||
      line.major < 1 ||
      !Number.isInteger(line.minor) ||
      line.minor < 0 ||
      line.id !== `${line.major}.${line.minor}` ||
      !['active', 'supported', 'retiring'].includes(line.lifecycle)
    ) {
      throw new Error(`invalid version line: ${JSON.stringify(line)}`);
    }
    if (ids.has(line.id)) throw new Error(`duplicate version line: ${line.id}`);
    ids.add(line.id);
  }
  if (!ids.has(authority.activeLine)) {
    throw new Error('activeLine does not identify a declared line');
  }
  const aliases = authority.runnerRouting?.compatibilityAliases;
  if (
    authority.runnerRouting?.policy !== 'capability-first-cross-version' ||
    !Array.isArray(aliases) ||
    aliases.length === 0
  ) {
    throw new Error('runner routing must be capability-first');
  }
  for (const alias of aliases) {
    requiredText(alias.capability, 'runner capability');
    if (
      alias.crossVersion !== true ||
      !Array.isArray(alias.labels) ||
      alias.labels.length === 0
    ) {
      throw new Error(`${alias.capability} is not cross-version reusable`);
    }
  }
  for (const field of ['owner', 'rationale', 'reviewDate', 'sunsetCondition']) {
    requiredText(
      authority.runnerRouting.compatibilityBoundary?.[field],
      `runnerRouting.compatibilityBoundary.${field}`,
    );
  }
  const boundaries = authority.sourceBoundaries;
  for (const field of [
    'activeProjectionPaths',
    'historicalEvidencePaths',
    'immutableEvidencePrefixes',
  ]) {
    if (
      !Array.isArray(boundaries?.[field]) ||
      boundaries[field].length === 0 ||
      boundaries[field].some(
        (value) =>
          typeof value !== 'string' ||
          !value ||
          path.isAbsolute(value) ||
          value.split('/').includes('..'),
      )
    ) {
      throw new Error(`sourceBoundaries.${field} is invalid`);
    }
  }
  if (
    authority.authorityRoot !== digest(withoutRoot(authority, 'authorityRoot'))
  ) {
    throw new Error('version-line authority root mismatch');
  }
  return authority;
}

export function readAuthority(file = AUTHORITY_PATH) {
  return validateAuthority(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function deriveLine(authority, line) {
  const branches = Object.fromEntries(
    Object.entries(authority.branchTemplates).map(([key, template]) => [
      key,
      expand(template, line),
    ]),
  );
  return {
    id: line.id,
    major: line.major,
    minor: line.minor,
    lifecycle: line.lifecycle,
    branches: {
      dev: branches.dev,
      alpha: branches.alpha,
      stable: branches.stable,
      majorPublicationGate: branches.majorPublicationGate,
    },
    candidateLedger: branches.candidateLedger,
    latencyBaseline: line.latencyBaseline || null,
  };
}

export function deriveProjection(authority) {
  validateAuthority(authority);
  const lines = authority.lines.map((line) => deriveLine(authority, line));
  const aliasByCapability = new Map(
    authority.runnerRouting.compatibilityAliases.map((alias) => [
      alias.capability,
      alias,
    ]),
  );
  const selfHosted = [
    ['linux-x64', 'Linux x64', 'linux', 'linux-x64-native'],
    ['macos-arm64', 'macOS ARM64', 'macos', 'macos-arm64-native'],
    ['windows-x64', 'Windows x64', 'windows', 'windows-x64-native'],
  ].map(([id, name, platform, capability]) => {
    const alias = aliasByCapability.get(capability);
    if (!alias) throw new Error(`runner capability is missing: ${capability}`);
    return {
      id,
      name,
      platform,
      runner: JSON.stringify(alias.labels),
      capabilities: ['node', 'native-toolchain', 'product-artifacts', 'rust'],
    };
  });
  const native = [
    {
      id: 'linux-x64',
      name: 'Linux x64',
      platform: 'linux',
      runner: '["ubuntu-24.04"]',
      capabilities: ['node', 'native-toolchain', 'product-artifacts', 'rust'],
      environment: { CC: 'gcc-14', CXX: 'g++-14' },
    },
    {
      id: 'linux-arm64',
      name: 'Linux ARM64',
      platform: 'linux',
      runner: '["ubuntu-24.04-arm"]',
      capabilities: ['node', 'native-toolchain', 'product-artifacts', 'rust'],
    },
    {
      id: 'macos-arm64',
      name: 'macOS ARM64',
      platform: 'macos',
      runner: '["macos-15"]',
      capabilities: ['node', 'native-toolchain', 'product-artifacts', 'rust'],
    },
    {
      id: 'windows-x64',
      name: 'Windows x64',
      platform: 'windows',
      runner: '["windows-2022"]',
      capabilities: ['node', 'native-toolchain', 'product-artifacts', 'rust'],
    },
  ];
  const projection = {
    schema: 'kungfu.version-line-projections/v1',
    authorityRoot: authority.authorityRoot,
    activeLine: authority.activeLine,
    lines,
    runnerRouting: {
      ...authority.runnerRouting,
      matrices: { selfHosted, native },
    },
  };
  return { ...projection, projectionRoot: digest(projection) };
}

export function activeProjection(authority = readAuthority()) {
  const projection = deriveProjection(authority);
  const line = projection.lines.find(({ id }) => id === projection.activeLine);
  if (!line) throw new Error('active version-line projection is missing');
  return { projection, line };
}

export function latencyBaselineForDevBranch(branch, root = ROOT) {
  const authority = readAuthority(
    path.join(root, 'product/version-line/version-line-authority.json'),
  );
  const line = deriveProjection(authority).lines.find(
    ({ branches }) => branches.dev === branch,
  );
  if (!line?.latencyBaseline)
    throw new Error(`no latency baseline admitted for ${branch}`);
  const baseline = JSON.parse(
    fs.readFileSync(path.join(root, line.latencyBaseline), 'utf8'),
  );
  if (
    baseline.authorityClassification !== 'historical-measurement' ||
    baseline.versionLineAuthorityRoot !== authority.authorityRoot ||
    baseline.branch !== branch
  )
    throw new Error(`latency baseline authority drift for ${branch}`);
  return baseline;
}

function pullRequestRule() {
  return {
    type: 'pull_request',
    parameters: {
      allowed_merge_methods: ['merge', 'squash', 'rebase'],
      dismiss_stale_reviews_on_push: true,
      dismissal_restriction: { allowed_actors: [], enabled: false },
      require_code_owner_review: true,
      require_last_push_approval: true,
      required_approving_review_count: 1,
      required_review_thread_resolution: true,
      required_reviewers: [],
    },
  };
}

export function rulesetContract(authority, channel) {
  if (!['alpha', 'stable'].includes(channel)) {
    throw new Error(`unsupported ruleset channel: ${channel}`);
  }
  const { line } = activeProjection(authority);
  const targetRef = line.branches[channel];
  const label = channel === 'alpha' ? 'Alpha candidate' : 'stable release';
  const requiredChecks = authority.requiredChecks?.[channel];
  if (!Array.isArray(requiredChecks) || requiredChecks.length === 0) {
    throw new Error(`${channel} required checks are missing`);
  }
  const body = {
    schema: `kungfu.${channel}-ruleset-contract/v1`,
    status: 'active',
    repository: authority.repository,
    versionLineAuthorityRoot: authority.authorityRoot,
    targetRef,
    ruleset: {
      name: `Kungfu ${label} authority: ${targetRef}`,
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [],
      conditions: {
        ref_name: {
          include: [`refs/heads/${targetRef}`],
          exclude: [],
        },
      },
      rules: [
        pullRequestRule(),
        {
          type: 'required_status_checks',
          parameters: {
            do_not_enforce_on_create: false,
            required_status_checks: requiredChecks,
            strict_required_status_checks_policy: true,
          },
        },
        { type: 'deletion' },
        { type: 'non_fast_forward' },
      ],
    },
    classicProtection: {
      mode: 'defense-in-depth',
      requiredChecks: requiredChecks.map(({ context }) => context),
      enforceAdmins: true,
      requiredApprovals: 1,
      dismissStaleReviews: true,
      requireCodeOwnerReview: true,
      requireLastPushApproval: true,
      requireResolvedThreads: true,
      allowForcePushes: false,
      allowDeletions: false,
    },
  };
  return { ...body, contractRoot: digest(body) };
}

export function renderedProjections(authority = readAuthority()) {
  return new Map([
    [
      PROJECTION_PATH,
      `${JSON.stringify(deriveProjection(authority), null, 2)}\n`,
    ],
    [
      path.join(ROOT, 'docs/qualification/alpha-ruleset.contract.json'),
      `${JSON.stringify(rulesetContract(authority, 'alpha'), null, 2)}\n`,
    ],
    [
      path.join(ROOT, 'docs/qualification/stable-ruleset.contract.json'),
      `${JSON.stringify(rulesetContract(authority, 'stable'), null, 2)}\n`,
    ],
  ]);
}

export function checkProjections(authority = readAuthority()) {
  for (const [file, expected] of renderedProjections(authority)) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== expected) {
      throw new Error(
        `${path.relative(ROOT, file)} is not the byte-for-byte authority projection`,
      );
    }
  }
  return true;
}

function writeProjections(authority = readAuthority()) {
  for (const [file, content] of renderedProjections(authority)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

function writeGithubOutput(file, line) {
  const output = [
    `version-line=${line.id}`,
    `dev-branch=${line.branches.dev}`,
    `alpha-branch=${line.branches.alpha}`,
    `stable-branch=${line.branches.stable}`,
    `candidate-ledger=${line.candidateLedger}`,
  ].join('\n');
  fs.appendFileSync(file, `${output}\n`);
}

function main(argv) {
  const [command = 'check', ...args] = argv;
  if (command === 'check') {
    checkProjections();
    console.log('version-line authority projections passed');
    return;
  }
  if (command === 'write') {
    writeProjections();
    console.log('version-line authority projections written');
    return;
  }
  if (command === 'resolve') {
    const { line } = activeProjection();
    const outputIndex = args.indexOf('--github-output');
    if (outputIndex >= 0) {
      const file = requiredText(args[outputIndex + 1], '--github-output');
      writeGithubOutput(file, line);
    } else {
      console.log(JSON.stringify(line));
    }
    return;
  }
  throw new Error(`unknown version-line authority command: ${command}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `[version-line-authority] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
