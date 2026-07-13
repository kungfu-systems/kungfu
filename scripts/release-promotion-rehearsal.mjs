#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateReleaseGate, parsePrManifest } from './adr-release-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONTRACT = 'docs/release-promotion-rehearsal.contract.json';
const FIXTURE_DIR = 'tests/fixtures/release-promotion';

/** @param {string} file */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** @param {string} root @param {string} relative */
function readText(root, relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

/** @param {string} message @param {string} code */
function finding(message, code = 'promotion-contract') {
  return { code, message };
}

/**
 * Extract one top-level job without requiring a YAML runtime dependency.
 * The workflow contract intentionally treats job ids as stable public wiring.
 * @param {string} source
 * @param {string} job
 */
export function extractWorkflowJob(source, job) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${job}:`);
  if (start < 0) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** @param {string} source @param {RegExp} pattern @param {any[]} findings @param {string} message */
function requirePattern(source, pattern, findings, message) {
  if (!pattern.test(source)) findings.push(finding(message));
}

/** @param {string} root @param {any} contract @param {Record<string, string>} [overrides] */
export function validateWorkflowSources(root, contract, overrides = {}) {
  /** @type {any[]} */
  const findings = [];
  const build = overrides.build || readText(root, contract.workflows.build);
  const promotion =
    overrides.promotion || readText(root, contract.workflows.promotion);
  const validation =
    overrides.validation || readText(root, contract.workflows.validation);
  const preflight = extractWorkflowJob(promotion, 'promotion-contract');
  const promote = extractWorkflowJob(promotion, 'promote');
  const launcher = extractWorkflowJob(promotion, 'shifu-launcher-tag');
  const rehearsal = extractWorkflowJob(validation, 'promotion-rehearsal');

  requirePattern(
    build,
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/\.build\.yml@v2-alpha/,
    findings,
    'release-candidate build must consume Buildchain v2-alpha',
  );
  requirePattern(
    build,
    /buildchain-ref: \$\{\{ inputs\.buildchain-ref \|\| '' \}\}/,
    findings,
    'manual validation must retain the Buildchain ref pass-through',
  );
  requirePattern(
    build,
    /episode:qualify:release[\s\S]*adr:release:gate[\s\S]*adr-release-admissibility\.json/,
    findings,
    'candidate verify must qualify Episodes before ADR release admission',
  );
  requirePattern(
    build,
    /release-candidate: true/,
    findings,
    'candidate build must remain a Buildchain release candidate',
  );

  requirePattern(
    promotion,
    /branches:[\s\S]*alpha\/v\*\/v\*[\s\S]*release\/v\*\/v\*/,
    findings,
    'promotion workflow must cover alpha and stable channel branches',
  );
  requirePattern(
    preflight,
    /if: \$\{\{ github\.event\.pull_request\.merged == true \}\}/,
    findings,
    'promotion contract preflight must run only for a merged promotion PR',
  );
  requirePattern(
    preflight,
    /\.\/shifu gate run governance\.promotion-rehearsal/,
    findings,
    'promotion contract preflight must execute the current merged PR event',
  );
  requirePattern(
    promote,
    /needs: promotion-contract/,
    findings,
    'Buildchain promotion must depend on the Kungfu promotion contract preflight',
  );
  requirePattern(
    promote,
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/release-candidate-promote\.yml@v2/,
    findings,
    'promotion must consume the stable Buildchain workflow shell',
  );
  requirePattern(
    promote,
    new RegExp(
      `required-status-check: ${contract.buildchain.required_status_check}`,
    ),
    findings,
    'promotion required status check drifted from the rehearsal contract',
  );
  requirePattern(
    promote,
    new RegExp(
      `required-artifact-count: ${contract.buildchain.required_artifact_count}`,
    ),
    findings,
    'promotion artifact count drifted from the rehearsal contract',
  );
  requirePattern(
    promote,
    /buildchain-ref: \$\{\{ startsWith\(github\.event\.pull_request\.base\.ref, 'alpha\/'\) && 'v2-alpha' \|\| 'v2' \}\}/,
    findings,
    'alpha/stable Buildchain ref routing drifted',
  );
  requirePattern(
    promote,
    /buildchain-contract-lock-path: \$\{\{ startsWith\(github\.event\.pull_request\.base\.ref, 'alpha\/'\) && '\.buildchain\/alpha-contract-lock\.json' \|\| '\.buildchain\/contract-lock\.json' \}\}/,
    findings,
    'alpha/stable Buildchain contract-lock routing drifted',
  );
  requirePattern(
    promote,
    /publish-dist-tag: \$\{\{ startsWith\(github\.event\.pull_request\.base\.ref, 'alpha\/'\) && 'alpha' \|\| 'latest' \}\}/,
    findings,
    'alpha/stable distribution-tag routing drifted',
  );
  requirePattern(
    promote,
    new RegExp(
      `publish-command: ${contract.evidence.publish_command.replaceAll('.', '\\.')}`,
    ),
    findings,
    'custom publish evidence command drifted',
  );
  requirePattern(
    launcher,
    /needs: promote/,
    findings,
    'launcher tagging must remain downstream of Buildchain promotion',
  );
  requirePattern(
    rehearsal,
    /needs: validate/,
    findings,
    'routine promotion rehearsal must depend on Buildchain config validation',
  );
  requirePattern(
    rehearsal,
    /\.\/shifu gate run governance\.promotion-rehearsal/,
    findings,
    'Buildchain validation workflow must execute the promotion rehearsal',
  );

  for (const command of contract.safety.forbidden_commands) {
    if (preflight.includes(command)) {
      findings.push(
        finding(
          `promotion contract preflight contains forbidden side effect: ${command}`,
          'promotion-side-effect',
        ),
      );
    }
  }
  if (/^\s+secrets:/m.test(preflight)) {
    findings.push(
      finding(
        'promotion contract preflight must not receive release secrets',
        'promotion-side-effect',
      ),
    );
  }

  for (const evidence of [
    ...contract.evidence.kfd_1_witnesses,
    ...contract.evidence.kfd_2_claims,
    ...contract.evidence.kfd_3_prebuild_witnesses,
  ]) {
    if (!fs.existsSync(path.join(root, evidence))) {
      findings.push(
        finding(`declared release evidence does not exist: ${evidence}`),
      );
    }
    if (!promote.includes(evidence)) {
      findings.push(
        finding(`Buildchain promotion does not consume evidence: ${evidence}`),
      );
    }
  }
  if (!promote.includes(contract.evidence.kfd_3_artifact_verify_command)) {
    findings.push(finding('KFD-3 artifact verification command drifted'));
  }

  return { ok: findings.length === 0, findings };
}

/** @param {string} root @param {any} contract */
export function validateBuildchainLocks(root, contract) {
  /** @type {any[]} */
  const findings = [];
  for (const channel of ['alpha', 'stable']) {
    const expected = contract.buildchain[channel];
    const lock = readJson(path.join(root, expected.contract_lock));
    if (lock.buildchain?.ref !== expected.workflow_ref) {
      findings.push(
        finding(
          `${channel} contract lock resolves ${String(lock.buildchain?.ref)}, expected ${expected.workflow_ref}`,
          'buildchain-lock',
        ),
      );
    }
    if (!/^[0-9a-f]{40}$/.test(String(lock.buildchain?.resolvedSha || ''))) {
      findings.push(
        finding(
          `${channel} contract lock needs an immutable SHA`,
          'buildchain-lock',
        ),
      );
    }
    if (
      !/^sha256:[0-9a-f]{64}$/.test(
        String(lock.buildchain?.contractDigest || ''),
      )
    ) {
      findings.push(
        finding(
          `${channel} contract lock needs a contract digest`,
          'buildchain-lock',
        ),
      );
    }
    const surfaces = new Set(
      (lock.buildchain?.surfaces || []).map((surface) => surface.id),
    );
    for (const id of contract.buildchain.required_surfaces) {
      if (!surfaces.has(id)) {
        findings.push(
          finding(
            `${channel} contract lock is missing surface ${id}`,
            'buildchain-lock',
          ),
        );
      }
    }
  }
  return { ok: findings.length === 0, findings };
}

/** @param {string} root @param {string} contractPath */
export function validatePromotionContract(
  root = ROOT,
  contractPath = DEFAULT_CONTRACT,
) {
  const contract = readJson(path.join(root, contractPath));
  /** @type {any[]} */
  const findings = [];
  if (contract.schema !== 'kungfu.release-promotion-rehearsal-contract/v1') {
    findings.push(finding('unsupported promotion rehearsal contract schema'));
  }
  if (
    !fs.existsSync(
      path.join(root, 'scripts/buildchain-custom-publish-evidence.mjs'),
    )
  ) {
    findings.push(finding('custom publish evidence adapter does not exist'));
  }
  const workflows = validateWorkflowSources(root, contract);
  const locks = validateBuildchainLocks(root, contract);
  findings.push(...workflows.findings, ...locks.findings);
  return { ok: findings.length === 0, contract, findings };
}

/** @param {string} baseRef */
function modeForBaseRef(baseRef) {
  if (baseRef.startsWith('alpha/')) return 'alpha';
  if (baseRef.startsWith('release/')) return 'stable';
  return '';
}

/** @param {any} fixture */
function createFixtureRoot(fixture) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-promotion-'));
  fs.mkdirSync(path.join(root, 'adr'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'docs/adr-release-waivers.json'),
    `${JSON.stringify({ schema: 'kungfu.adr-release-waivers/v1', waivers: fixture.waivers || [] }, null, 2)}\n`,
  );
  for (const adr of fixture.adrs || []) {
    const qualifications = (adr.qualification_refs || []).join(', ');
    fs.writeFileSync(
      path.join(root, `adr/${adr.id}-rehearsal.md`),
      `---\nadr_id: ${adr.id}\ndecision_status: ${adr.decision_status || 'accepted'}\nimplementation_status: ${adr.implementation_status}\nqualification_refs: [${qualifications}]\n---\n\n# ${adr.id}\n`,
    );
  }
  return root;
}

/** @param {string} file @param {any} adrContract */
export function evaluatePromotionFixture(file, adrContract) {
  const fixture = readJson(file);
  const root = createFixtureRoot(fixture);
  try {
    const contract = {
      ...adrContract,
      adrRoots: ['adr'],
      stable: {
        ...adrContract.stable,
        waiverFile: 'docs/adr-release-waivers.json',
      },
    };
    const marker = contract.manifestMarker;
    const manifest = parsePrManifest(
      `<!-- ${marker}\n${JSON.stringify(fixture.manifest)}\n-->`,
      marker,
    );
    const changedFiles = (fixture.changed_adrs || []).map(
      (id) => `adr/${id}-rehearsal.md`,
    );
    const report = evaluateReleaseGate({
      root,
      contract,
      manifest,
      mode: modeForBaseRef(String(fixture.base_ref || '')),
      changedFiles,
      prUrl: String(fixture.pr_url || ''),
    });
    const actualCodes = new Set(report.findings.map((entry) => entry.code));
    const missingCodes = (fixture.expected_findings || []).filter(
      (code) => !actualCodes.has(code),
    );
    const ok = report.ok === fixture.expect_ok && missingCodes.length === 0;
    return {
      name: fixture.name,
      base_ref: fixture.base_ref,
      expected_ok: fixture.expect_ok,
      actual_ok: report.ok,
      expected_findings: fixture.expected_findings || [],
      actual_findings: [...actualCodes].sort(),
      ok,
      report,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** @param {string} root */
export function runFixtureSuite(root = ROOT) {
  const adrContract = readJson(
    path.join(root, 'docs/adr-release.contract.json'),
  );
  const directory = path.join(root, FIXTURE_DIR);
  const fixtures = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) =>
      evaluatePromotionFixture(path.join(directory, name), adrContract),
    );
  return {
    ok: fixtures.length >= 4 && fixtures.every((entry) => entry.ok),
    fixtures,
  };
}

/** @param {string} root */
function currentStableReadiness(root) {
  const contract = readJson(path.join(root, 'docs/adr-release.contract.json'));
  const currentVersion = String(
    readJson(path.join(root, 'lerna.json')).version,
  );
  const release = currentVersion.split('-', 1)[0];
  return evaluateReleaseGate({
    root,
    contract,
    manifest: {
      schema: contract.manifestSchema,
      kind: 'stable-admission',
      release,
    },
    mode: 'stable',
    changedFiles: [],
    prUrl: 'https://github.com/kungfu-systems/kungfu/pull/999999',
  });
}

/** @param {string} root */
function gitSnapshot(root) {
  const run = (args) => {
    const result = childProcess.spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
    });
    if (result.status !== 0)
      throw new Error(String(result.stderr || '').trim());
    return String(result.stdout || '');
  };
  return {
    tracked: run(['status', '--porcelain', '--untracked-files=no']),
    refs: run([
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/heads',
      'refs/tags',
    ]),
  };
}

/** @param {string} root @param {string} eventPath */
function evaluateActualEvent(root, eventPath) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-promotion-event-'),
  );
  const reportPath = path.join(directory, 'adr-release-report.json');
  try {
    const result = childProcess.spawnSync(
      process.execPath,
      [
        'scripts/adr-release-gate.mjs',
        '--event',
        eventPath,
        '--report',
        reportPath,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    const report = fs.existsSync(reportPath) ? readJson(reportPath) : null;
    return {
      ok: result.status === 0 && report?.ok === true,
      status: result.status,
      report,
      output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** @param {{root?: string, contractPath?: string, eventPath?: string}} options */
export function runRehearsal(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const before = gitSnapshot(root);
  const contract = validatePromotionContract(
    root,
    options.contractPath || DEFAULT_CONTRACT,
  );
  const fixtures = runFixtureSuite(root);
  const currentStable = currentStableReadiness(root);
  const event = options.eventPath
    ? evaluateActualEvent(root, path.resolve(options.eventPath))
    : null;
  const after = gitSnapshot(root);
  const repositoryUnchanged =
    before.tracked === after.tracked && before.refs === after.refs;
  const findings = [...contract.findings];
  if (!fixtures.ok)
    findings.push(
      finding('one or more release promotion fixtures failed', 'fixture'),
    );
  if (event && !event.ok)
    findings.push(
      finding('current promotion event failed ADR admission', 'event'),
    );
  if (!repositoryUnchanged)
    findings.push(
      finding(
        'rehearsal changed tracked files, branches, or tags',
        'side-effect',
      ),
    );
  return {
    schema: 'kungfu.release-promotion-rehearsal/v1',
    ok: findings.length === 0,
    side_effects: {
      tracked_files_changed: before.tracked !== after.tracked,
      refs_changed: before.refs !== after.refs,
      remote_mutations_attempted: false,
      promotion_credentials_consumed: false,
    },
    contract: {
      ok: contract.ok,
      findings: contract.findings,
      buildchain_refs: {
        alpha: contract.contract.buildchain.alpha.workflow_ref,
        stable: contract.contract.buildchain.stable.workflow_ref,
      },
    },
    fixtures,
    current_repository_stable_readiness: {
      informational: true,
      release: currentStable.release,
      ok: currentStable.ok,
      summary: currentStable.summary,
      blocked: currentStable.blocked,
    },
    event,
    findings,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--github-event')
      args.eventPath = process.env.GITHUB_EVENT_PATH;
    else if (arg === '--event') args.eventPath = argv[++index];
    else if (arg === '--report') args.reportPath = argv[++index];
    else if (arg === '--contract') args.contractPath = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function writeReport(report, destination) {
  if (destination) {
    const absolute = path.resolve(ROOT, destination);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Release promotion rehearsal\n\n- Result: **${report.ok ? 'admitted' : 'blocked'}**\n- Fixtures: ${report.fixtures.fixtures.length}\n- Current stable blockers: ${report.current_repository_stable_readiness.summary.blocked}\n- Tracked/ref mutations: ${report.side_effects.tracked_files_changed || report.side_effects.refs_changed ? 'detected' : 'none'}\n\n`,
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = runRehearsal(args);
    writeReport(report, args.reportPath);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exit(1);
  } catch (error) {
    console.error(
      `[release-promotion-rehearsal] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
