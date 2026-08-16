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

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @param {string} source @param {RegExp} pattern @param {any[]} findings @param {string} message */
function forbidPattern(source, pattern, findings, message) {
  if (pattern.test(source)) findings.push(finding(message));
}

/** @param {string} root @param {any} contract @param {Record<string, string>} [overrides] */
export function validateWorkflowSources(root, contract, overrides = {}) {
  /** @type {any[]} */
  const findings = [];
  const build = overrides.build || readText(root, contract.workflows.build);
  const qualification =
    overrides.qualification ||
    readText(root, 'scripts/run-release-qualification.mjs');
  const promotion =
    overrides.promotion || readText(root, contract.workflows.promotion);
  const validation =
    overrides.validation || readText(root, contract.workflows.validation);
  const preflight = extractWorkflowJob(promotion, 'promotion-contract');
  const promote = extractWorkflowJob(promotion, 'promote');
  const recovery = extractWorkflowJob(promotion, 'recover');
  const releaseAdmission = readJson(
    path.join(root, 'docs/qualification/gates/release-admission-policy.json'),
  );
  const recoveryRuntimeRef = releaseAdmission.buildchain.runtimes.alpha.ref;
  const productAdmission = extractWorkflowJob(
    build,
    'finalize-upgrade-publication-admission',
  );
  const rehearsal = extractWorkflowJob(validation, 'promotion-rehearsal');
  const attestation = contract.buildchain.artifact_attestation;
  const buildShellRef = contract.buildchain.build_channel_ref;
  const buildShellMajor = contract.buildchain.build_major;
  const buildShellSha = contract.buildchain.build_workflow_shell_resolved_sha;
  const buildRuntimeSha = contract.buildchain.build_runtime_resolved_sha;

  if (
    buildShellRef !== 'v3-alpha' ||
    buildShellMajor !== 'v3' ||
    buildShellRef !== `${buildShellMajor}-alpha` ||
    contract.buildchain.workflow_shell_ref !== buildShellRef
  )
    findings.push(
      finding(
        'release-candidate build workflow shell channel or major drifted',
      ),
    );
  if (
    !/^[0-9a-f]{40}$/u.test(buildShellSha || '') ||
    !/^[0-9a-f]{40}$/u.test(buildRuntimeSha || '') ||
    buildShellSha !== buildRuntimeSha
  )
    findings.push(
      finding(
        'release-candidate build workflow shell or runtime revision is not one immutable source',
      ),
    );

  for (const [label, job] of [
    ['primary promotion', promote],
    ['release-candidate recovery', recovery],
  ]) {
    const publishCommand =
      label === 'release-candidate recovery'
        ? contract.evidence.recovery_publish_command
        : contract.evidence.publish_command;
    requirePattern(
      job,
      /release-activation-command: ""/,
      findings,
      `${label} must leave the Buildchain release activation command empty`,
    );
    requirePattern(
      job,
      /release-passport-evidence-command: ""/,
      findings,
      `${label} must leave the Buildchain release-passport evidence command empty`,
    );
    requirePattern(
      job,
      new RegExp(`publish-command: ${publishCommand.replaceAll('.', '\\.')}`),
      findings,
      `${label} custom publish evidence command drifted`,
    );
    requirePattern(
      job,
      /publication-commit-evidence-path: \.buildchain\/publication-commit\/evidence\.json/,
      findings,
      `${label} publication commit evidence path drifted`,
    );
    requirePattern(
      job,
      /release-passport: true/,
      findings,
      `${label} must retain Release Passport collection`,
    );
    requirePattern(
      job,
      /publication-target: github-release:kungfu-systems\/kungfu/,
      findings,
      `${label} must retain the exact Kungfu GitHub Release target`,
    );
    requirePattern(
      job,
      /github-release-payload-patterns:[\s\S]*kungfu-episodes-cli-\*\.tar\.gz[\s\S]*kungfu-episodes-cli-\*\.zip[\s\S]*kungfu-episodes-cli-\*\.qualification\.json[\s\S]*Kungfu-Episodes-\*-macos-arm64\.dmg[\s\S]*Kungfu-Episodes-\*-macos-arm64\.zip[\s\S]*Kungfu Episodes-\*\.AppImage[\s\S]*Kungfu Episodes Setup \*\.exe/,
      findings,
      `${label} must retain the exact GitHub Release payloads`,
    );
  }

  const candidateBuildShellCalls = [
    ...build.matchAll(
      /^\s+uses:\s+kungfu-systems\/buildchain\/\.github\/workflows\/\.build\.yml@(\S+)\s*$/gmu,
    ),
  ];
  if (
    candidateBuildShellCalls.length !== 1 ||
    candidateBuildShellCalls[0][1] !== buildShellSha
  )
    findings.push(
      finding(
        'release-candidate build must contain exactly one immutable channel-bound native-finalization workflow call',
      ),
    );
  requirePattern(
    build,
    new RegExp(`^\\s+buildchain-ref: ${buildRuntimeSha}\\s*$`, 'mu'),
    findings,
    'Alpha candidate builds must execute the same immutable reviewed workflow and runtime revision',
  );
  const candidateBuildchainRefLines =
    build.match(/^\s+buildchain-ref:\s*.+$/gmu) || [];
  if (
    candidateBuildchainRefLines.length !== 1 ||
    candidateBuildchainRefLines[0].trim() !==
      `buildchain-ref: ${buildRuntimeSha}` ||
    build.includes('inputs.buildchain-ref')
  )
    findings.push(
      finding(
        'privileged candidate builds must not expose a movable Buildchain runtime override',
      ),
    );
  requirePattern(
    build,
    /^\s+publish-source-ref: \$\{\{ fromJSON\(inputs\.macos-overflow-request-json \|\| '\{\}'\)\.releaseCutSourceRef \|\| '' \}\}$/m,
    findings,
    'manual Release Cut recovery must bind Buildchain to the source-lock ref carried by the trusted controller envelope',
  );
  forbidPattern(
    build,
    /^\s+publish-source-ref:\s+.*(?:github\.head_ref|github\.event\.pull_request)/m,
    findings,
    'PR-stage release-candidate builds must leave publish-source locking to exact manual Release Cut recovery or post-merge promotion',
  );
  requirePattern(
    build,
    /uses: \.\/\.github\/actions\/require-alpha-preflight/,
    findings,
    'release-candidate build must admit the exact-source Alpha preflight receipt',
  );
  requirePattern(
    extractWorkflowJob(build, 'build'),
    /needs: (?:preflight|\[[^\]\n]*\bpreflight\b[^\]\n]*\])/,
    findings,
    'the expensive Buildchain matrix must depend on Alpha preflight admission',
  );
  requirePattern(
    build,
    /fail-fast: \$\{\{ github\.event_name == 'pull_request' \|\| !inputs\.diagnostic-mode \}\}/,
    findings,
    'required promotion builds must fail fast while explicit diagnostics retain all platforms',
  );
  requirePattern(
    build,
    /checkout-cache-github-timeout-seconds:\s+1200/,
    findings,
    'release-candidate source checkout must retain the bounded large-repository GitHub fallback window',
  );
  requirePattern(
    `${build}\n${qualification}`,
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
    productAdmission,
    /needs: build/,
    findings,
    'product admission finalization must consume the complete candidate matrix',
  );
  requirePattern(
    productAdmission,
    /scripts\/upgrade-publication-admission\.mjs write/,
    findings,
    'candidate finalization must mint the product admission receipt before publication',
  );
  requirePattern(
    productAdmission,
    /product-upgrade-publication-admission\.json[\s\S]*product-upgrade-publication-capsule\.json/,
    findings,
    'candidate finalization must seal the receipt and capsule together',
  );
  requirePattern(
    productAdmission,
    /name: kungfu-product-upgrade-publication-admission-\$\{\{ needs\.build\.outputs\.publish-source-sha \}\}/,
    findings,
    'candidate finalization must retain the exact source-bound capsule artifact',
  );
  requirePattern(
    build,
    new RegExp(
      `github-artifact-attestation-subject-path: ${escapeRegExp(attestation.subject_path)}`,
    ),
    findings,
    'release-candidate build must bind the exact Linux CLI attestation subject',
  );
  requirePattern(
    build,
    new RegExp(
      `github-artifact-attestation-signer-sha: ${escapeRegExp(attestation.signer_sha)}`,
    ),
    findings,
    'release-candidate build must pin the immutable Buildchain signer bootstrap',
  );
  requirePattern(
    build,
    new RegExp(
      `github-artifact-attestation-platform-id: ${escapeRegExp(attestation.platform_id)}`,
    ),
    findings,
    'release-candidate build must bind the Linux attestation platform manifest',
  );

  requirePattern(
    promotion,
    /branches:[\s\S]*alpha\/v\*\/v\*[\s\S]*release\/v\*\/v\*/,
    findings,
    'promotion workflow must cover alpha and stable channel branches',
  );
  requirePattern(
    preflight,
    /if: \$\{\{ \(github\.event_name == 'workflow_dispatch' && inputs\.resume-candidate-run-id == ''\) \|\| github\.event\.pull_request\.merged == true \}\}/,
    findings,
    'promotion contract preflight must run only for a merged promotion PR or a non-recovery manual dispatch',
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
    new RegExp(
      `uses: kungfu-systems/buildchain/\\.github/workflows/release-candidate-promote\\.yml@${contract.buildchain.workflow_shell_ref}`,
    ),
    findings,
    'promotion must consume the v3-alpha floating router contract',
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
  const buildchainRefLines = promote.match(/^\s+buildchain-ref:\s*.+$/gm) || [];
  const expectedBuildchainRef =
    "buildchain-ref: ${{ startsWith(inputs.target-ref || github.event.pull_request.base.ref, 'alpha/') && 'v3-alpha' || 'v3' }}";
  if (
    buildchainRefLines.length !== 1 ||
    buildchainRefLines[0].trim() !== expectedBuildchainRef
  ) {
    findings.push(
      finding(
        'promotion must route only through the reviewed v3-alpha or v3 floating contracts',
      ),
    );
  }
  requirePattern(
    recovery,
    new RegExp(
      `uses: kungfu-systems/buildchain/\\.github/workflows/release-candidate-promote\\.yml@${escapeRegExp(recoveryRuntimeRef)}`,
    ),
    findings,
    'recovery must consume the reviewed floating Alpha publication contract',
  );
  requirePattern(
    recovery,
    /^\s+buildchain-channel: auto[\s\S]*^\s+buildchain-ref: \$\{\{ inputs\.resume-buildchain-runtime-sha \}\}$/mu,
    findings,
    'Alpha recovery must bind the sealed candidate to its exact resolved publication runtime',
  );
  for (const permission of ['artifact-metadata', 'attestations']) {
    requirePattern(
      promote,
      new RegExp(`${permission}: write`),
      findings,
      `promotion must grant ${permission}: write for GitHub keyless attestation`,
    );
  }
  requirePattern(
    promote,
    new RegExp(
      `github-artifact-attestation-policy-json: ${escapeRegExp(attestation.policy_json)}`,
    ),
    findings,
    'promotion must consume the exact auto-discovered attestation policy',
  );
  requirePattern(
    promote,
    new RegExp(
      `github-artifact-attestation-environment: ${escapeRegExp(attestation.environment)}`,
    ),
    findings,
    'promotion must retain the protected attestation environment boundary',
  );
  requirePattern(
    promote,
    /buildchain-contract-lock-path: \$\{\{ startsWith\(inputs\.target-ref \|\| github\.event\.pull_request\.base\.ref, 'alpha\/'\) && '\.buildchain\/alpha-contract-lock\.json' \|\| '\.buildchain\/contract-lock\.json' \}\}/,
    findings,
    'alpha/stable Buildchain contract-lock routing drifted',
  );
  requirePattern(
    promote,
    /release-candidate-wait-seconds: 10800/,
    findings,
    'promotion must wait for the complete long-running release-candidate workflow',
  );
  requirePattern(
    promote,
    /publication-gate-command: node scripts\/assemble-kungfu-publication-gate\.mjs/,
    findings,
    'publication authority must assemble the consumer Gate from exact candidate evidence',
  );
  requirePattern(
    promote,
    /publication-publisher-workflow-path: \.github\/workflows\/release-new-version\.yml/,
    findings,
    'publication authority must bind the repository-local publisher workflow',
  );
  requirePattern(
    promote,
    /publication-product: Kungfu Episodes/,
    findings,
    'publication authority must bind the Kungfu Episodes product identity',
  );
  requirePattern(
    promote,
    /publication-target: github-release:kungfu-systems\/kungfu/,
    findings,
    'publication authority must bind the exact Kungfu GitHub Release target',
  );
  requirePattern(
    promote,
    /publication-package-name: ""/,
    findings,
    'GitHub Release publication must retain an empty npm package identity',
  );
  requirePattern(
    promote,
    /publish-dist-tag: \$\{\{ startsWith\(inputs\.target-ref \|\| github\.event\.pull_request\.base\.ref, 'alpha\/'\) && 'alpha' \|\| 'latest' \}\}/,
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
    promote,
    /github-release-payload-patterns:[\s\S]*kungfu-episodes-cli-\*\.tar\.gz[\s\S]*kungfu-episodes-cli-\*\.zip[\s\S]*kungfu-episodes-cli-\*\.qualification\.json[\s\S]*Kungfu-Episodes-\*-macos-arm64\.dmg[\s\S]*Kungfu-Episodes-\*-macos-arm64\.zip[\s\S]*Kungfu Episodes-\*\.AppImage[\s\S]*Kungfu Episodes Setup \*\.exe/,
    findings,
    'promotion must publish the exact CLI archives and qualification receipts from the PR-stage payload',
  );
  requirePattern(
    promote,
    /publication-commit-command: \$\{\{ startsWith\(inputs\.target-ref \|\| github\.event\.pull_request\.base\.ref, 'alpha\/'\) && 'node scripts\/alpha-publication-commit\.mjs' \|\| '' \}\}/,
    findings,
    'signed Alpha discovery must be the final commit only for the Alpha channel',
  );
  requirePattern(
    recovery,
    /publication-commit-command: BUILDCHAIN_PUBLICATION_COMMIT_PRODUCT_ROOT=\$GITHUB_WORKSPACE BUILDCHAIN_PUBLICATION_COMMIT_CANDIDATE_SOURCE_SHA=\$\{\{ inputs\.resume-candidate-source-sha \}\} node \.buildchain\/publication-controller\/scripts\/alpha-publication-commit\.mjs/,
    findings,
    'release-candidate recovery must run the pinned controller against the immutable candidate product root',
  );
  requirePattern(
    promote,
    /publication-commit-evidence-path: \.buildchain\/publication-commit\/evidence\.json/,
    findings,
    'signed Alpha discovery evidence path drifted',
  );
  requirePattern(
    promote,
    /standalone-binary-distribution: false/,
    findings,
    'no deferred product mutation may follow the signed Alpha authority commit',
  );
  requirePattern(
    promote,
    /BUILDCHAIN_PUBLICATION_COMMIT_SIGNING_KEY: \$\{\{ secrets\.KUNGFU_ALPHA_CHANNEL_SIGNING_PRIVATE_KEY \}\}/,
    findings,
    'Alpha publication must receive its dedicated signing secret only at the final commit boundary',
  );
  requirePattern(
    promote,
    /KUNGFU_GOVERNANCE_AUDITOR_APP_PRIVATE_KEY: \$\{\{ secrets\.KUNGFU_GOVERNANCE_AUDITOR_APP_PRIVATE_KEY \}\}/,
    findings,
    'promotion must relay the dedicated read-only governance auditor App credential',
  );
  if (extractWorkflowJob(promotion, 'shifu-launcher-tag')) {
    findings.push(
      finding(
        'launcher tagging must execute inside the final publication commit before signed discovery moves',
      ),
    );
  }
  requirePattern(
    promote,
    /dry-run: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}/,
    findings,
    'manual promotion measurement must remain dry-run only',
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
    if (lock.buildchain?.resolvedSha !== expected.resolved_sha) {
      findings.push(
        finding(
          `${channel} contract lock resolves ${String(lock.buildchain?.resolvedSha)}, expected recorded digest ${expected.resolved_sha}`,
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
  const publishAdapterPath = path.join(
    root,
    'scripts/buildchain-custom-publish-evidence.mjs',
  );
  if (!fs.existsSync(publishAdapterPath)) {
    findings.push(finding('custom publish evidence adapter does not exist'));
  } else {
    const publishAdapter = fs.readFileSync(publishAdapterPath, 'utf8');
    requirePattern(
      publishAdapter,
      /verifyUpgradePublicationAdmission\(\{/,
      findings,
      'custom publish evidence must validate the sealed product admission receipt',
    );
    forbidPattern(
      publishAdapter,
      /verifyUpgradePublicationPayloads/,
      findings,
      'custom publish evidence must not repeat Kungfu product qualification',
    );
    requirePattern(
      publishAdapter,
      /upgrade_qualification:\s*\{/,
      findings,
      'custom publish evidence must bind one-command campaign roots into the release passport',
    );
    requirePattern(
      publishAdapter,
      /path\.join\(SCRIPT_DIR, 'buildchain-kfd-evidence\.mjs'\)/u,
      findings,
      'recovery custom publish evidence must execute the checked-out publication controller KFD adapter',
    );
    requirePattern(
      publishAdapter,
      /artifact\.platform\s*\?\s*\{ platform: artifact\.platform \}/u,
      findings,
      'custom publish evidence must preserve the required platform provenance',
    );
  }
  const kfdEvidencePath = path.join(
    root,
    'scripts/buildchain-kfd-evidence.mjs',
  );
  if (!fs.existsSync(kfdEvidencePath)) {
    findings.push(finding('Buildchain KFD evidence adapter does not exist'));
  } else {
    const kfdEvidence = fs.readFileSync(kfdEvidencePath, 'utf8');
    const kfdRuntimePath = path.join(
      root,
      'framework/release/buildchain-kfd-runtime.mjs',
    );
    const kfdRuntime = fs.existsSync(kfdRuntimePath)
      ? fs.readFileSync(kfdRuntimePath, 'utf8')
      : '';
    const kfdRecoveryClosure = `${kfdEvidence}\n${kfdRuntime}`;
    requirePattern(
      kfdRecoveryClosure,
      /BUILDCHAIN_RELEASE_CANDIDATE_RECOVERY_RECEIPT_PATH[\s\S]*reused sealed release-candidate KFD upstream aggregate/u,
      findings,
      'release-candidate recovery must reuse the sealed KFD upstream aggregate without reinstalling product dependencies',
    );
    requirePattern(
      kfdRecoveryClosure,
      /BUILDCHAIN_RELEASE_CANDIDATE_RECOVERY_RECEIPT_PATH[\s\S]*releaseCandidateKfdRoot[\s\S]*process\.cwd\(\)/u,
      findings,
      'release-candidate recovery must project controller logic over the sealed product root',
    );
  }
  const publicationCommitPath = path.join(
    root,
    'scripts/alpha-publication-commit.mjs',
  );
  const publicationCommit = fs.readFileSync(publicationCommitPath, 'utf8');
  requirePattern(
    publicationCommit,
    /verifyUpgradePublicationAdmission\(\{/,
    findings,
    'Alpha publication commit must validate the sealed product admission receipt',
  );
  forbidPattern(
    publicationCommit,
    /verifyUpgradePublicationPayloads/,
    findings,
    'Alpha publication commit must not repeat Kungfu product qualification',
  );
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
      path.join(root, `adr/${adr.id}.md`),
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
      // These fixtures isolate the ADR manifest state machine. The common
      // deprecation authority has its own fail-closed fixture suite and is
      // evaluated against the real repository below.
      deprecationLifecycle: undefined,
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
      (id) => `adr/${id}.md`,
    );
    const report = evaluateReleaseGate({
      root,
      contract,
      manifest,
      mode: modeForBaseRef(String(fixture.base_ref || '')),
      changedFiles,
      prUrl: String(fixture.pr_url || ''),
      // These minimal fixtures exercise promotion semantics only. The current
      // repository readiness path below retains the real ADR authority gate.
      authorityFindings: [],
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
  const run = (args, allowFailure = false) => {
    const result = childProcess.spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
    });
    if (result.status !== 0 && !allowFailure)
      throw new Error(String(result.stderr || '').trim());
    return String(result.stdout || '');
  };
  return {
    tracked: run(['status', '--porcelain', '--untracked-files=no']),
    // Branches and tags are shared by every worktree. Snapshotting all of
    // them makes this read-only rehearsal blame an unrelated concurrent
    // worktree for changing its own ref. The current worktree's symbolic HEAD
    // and commit remain attributable here; forbidden tag/push commands are
    // separately rejected by the promotion contract.
    head: run(['rev-parse', 'HEAD']),
    headRef: run(['symbolic-ref', '-q', 'HEAD'], true),
  };
}

/** @param {string} root @param {string} eventPath */
function evaluateActualEvent(root, eventPath) {
  const payload = readJson(eventPath);
  if (!payload.pull_request) return null;
  const baseRef = String(payload.pull_request.base?.ref || '');
  if (!modeForBaseRef(baseRef)) return null;
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-promotion-event-'),
  );
  const reportPath = path.join(directory, 'adr-release-report.json');
  const indexPath = childProcess
    .execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
      { cwd: root, encoding: 'utf8' },
    )
    .trim();
  const rehearsalIndexPath = path.join(directory, 'index');
  fs.copyFileSync(indexPath, rehearsalIndexPath);
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
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        // The rehearsal is read-only. Disable Git's optional index refresh so
        // the child remains runnable from a pre-commit hook that already owns
        // the real index lock. A private index preserves the exact staged view
        // without contending with the hook's lock.
        env: {
          ...process.env,
          GIT_INDEX_FILE: rehearsalIndexPath,
          GIT_OPTIONAL_LOCKS: '0',
        },
      },
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
    before.tracked === after.tracked &&
    before.head === after.head &&
    before.headRef === after.headRef;
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
      refs_changed:
        before.head !== after.head || before.headRef !== after.headRef,
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
