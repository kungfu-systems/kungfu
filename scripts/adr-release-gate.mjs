#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditDeprecations } from '../developer/deprecation/deprecation-lifecycle.mjs';
import { classifyAdrIdentity, inspectAdrRecordPath } from './adr-identity.mjs';
import {
  readMetadataContract,
  validateDocumentMetadata,
} from './document-metadata-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONTRACT = 'docs/adr-release.contract.json';

/** @typedef {{code: string, message: string, adr?: string}} Finding */

/** @param {string} file */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isolatedGitEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
}

/** @param {string} root */
function markdownFiles(root) {
  const result = childProcess.spawnSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      '*.md',
      '*.markdown',
    ],
    { cwd: root, env: isolatedGitEnvironment(), encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `git ls-files failed: ${String(result.stderr || '').trim()}`,
    );
  }
  return String(result.stdout || '')
    .split('\0')
    .filter(Boolean)
    .filter((rel) => fs.existsSync(path.join(root, rel)))
    .sort();
}

/** @param {string} root */
export function validateAdrAuthority(root) {
  try {
    const contract = readMetadataContract(root);
    const metadataFindings = validateDocumentMetadata({
      root,
      files: markdownFiles(root),
      contract,
    })
      .filter(
        (finding) =>
          finding.code.startsWith('adr-') ||
          finding.file === 'docs/adr' ||
          finding.file.startsWith('docs/adr/'),
      )
      .map((finding) => ({
        code: `adr-authority-${finding.code}`,
        adr: undefined,
        message: `${finding.file}:${finding.line} ${finding.message}`,
      }));
    const adrRoot = 'docs/adr';
    const pathFindings = [];
    for (const name of fs.readdirSync(path.join(root, adrRoot)).sort()) {
      const rel = path.posix.join(adrRoot, name);
      if (inspectAdrRecordPath(rel, adrRoot).kind === 'invalid') {
        pathFindings.push({
          code: 'adr-authority-path-invalid',
          adr: undefined,
          message: `${rel}: identity-looking ADR paths must be direct lowercase .md files`,
        });
      }
    }
    return [...metadataFindings, ...pathFindings];
  } catch (error) {
    return [
      {
        code: 'adr-authority-invalid',
        message: error instanceof Error ? error.message : String(error),
      },
    ];
  }
}

/** @param {string} raw */
function parseInlineList(raw) {
  const value = raw.trim();
  if (!value.startsWith('[') || !value.endsWith(']')) return [];
  const body = value.slice(1, -1).trim();
  if (!body) return [];
  return body
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''));
}

/** @param {string} text */
export function parseAdrMetadata(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) return null;
  /** @type {Record<string, string | string[]>} */
  const fields = {};
  for (const line of text.slice(4, end).split('\n')) {
    const match = /^([a-z][a-z0-9_]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    fields[match[1]] = match[2].trim().startsWith('[')
      ? parseInlineList(match[2])
      : match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return fields;
}

/** @param {string} root @param {any} contract */
export function loadAdrs(root, contract) {
  /** @type {Map<string, {id: string, file: string, decisionStatus: string, implementationStatus: string, qualificationRefs: string[]}>} */
  const adrs = new Map();
  for (const relRoot of contract.adrRoots || []) {
    const absoluteRoot = path.join(root, relRoot);
    if (!fs.existsSync(absoluteRoot)) continue;
    for (const name of fs.readdirSync(absoluteRoot).sort()) {
      const file = path.posix.join(relRoot.replaceAll(path.sep, '/'), name);
      const inspected = inspectAdrRecordPath(file, relRoot);
      if (inspected.kind === 'invalid') {
        throw new Error(
          `${file}: identity-looking ADR paths must be direct lowercase .md files`,
        );
      }
      if (inspected.kind !== 'record') continue;
      const fields = parseAdrMetadata(
        fs.readFileSync(path.join(root, file), 'utf8'),
      );
      const id = String(fields?.adr_id || '');
      if (!id) continue;
      adrs.set(id, {
        id,
        file,
        decisionStatus: String(fields?.decision_status || ''),
        implementationStatus: String(fields?.implementation_status || ''),
        qualificationRefs: Array.isArray(fields?.qualification_refs)
          ? fields.qualification_refs.map(String)
          : [],
      });
    }
  }
  return adrs;
}

/** @param {string} body @param {string} marker */
export function parsePrManifest(body, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [
    ...body.matchAll(new RegExp(`<!--\\s*${escaped}\\s*([\\s\\S]*?)-->`, 'g')),
  ];
  if (matches.length !== 1) {
    throw new Error(
      `PR body must contain exactly one <!-- ${marker} ... --> manifest`,
    );
  }
  try {
    return JSON.parse(matches[0][1].trim());
  } catch (error) {
    throw new Error(
      `ADR release PR manifest is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** @param {string} value @param {string} label @param {Finding[]} findings */
function requireText(value, label, findings) {
  if (typeof value !== 'string' || value.trim().length < 8) {
    findings.push({
      code: 'manifest-field',
      message: `${label} must be a meaningful string (at least 8 characters)`,
    });
  }
}

/** @param {unknown} value */
function stringList(value) {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string')
    ? value
    : [];
}

/** @param {string} ref @param {string} head @param {string} root */
export function changedFilesBetween(ref, head, root) {
  const runDiff = () =>
    childProcess.spawnSync('git', ['diff', '--name-only', `${ref}...${head}`], {
      cwd: root,
      env: isolatedGitEnvironment(),
      encoding: 'utf8',
    });

  let result = runDiff();
  if (
    result.status !== 0 &&
    /^[0-9a-f]{40}$/u.test(ref) &&
    /^[0-9a-f]{40}$/u.test(head)
  ) {
    // Buildchain checks out the immutable pull-request merge source with a
    // shallow boundary. The PR event still names the exact base and head
    // commits needed by the ADR settlement gate, so hydrate only those two
    // boundaries (plus the promotion parents) before retrying the diff.
    const fetch = childProcess.spawnSync(
      'git',
      ['fetch', '--no-tags', '--depth=2', 'origin', ref, head],
      {
        cwd: root,
        env: isolatedGitEnvironment(),
        encoding: 'utf8',
      },
    );
    if (fetch.status !== 0) {
      throw new Error(
        `git diff ${ref}...${head} failed: ${String(result.stderr || '').trim()}; exact boundary fetch failed: ${String(fetch.stderr || '').trim()}`,
      );
    }
    result = runDiff();
  }
  if (result.status !== 0) {
    throw new Error(
      `git diff ${ref}...${head} failed: ${String(result.stderr || '').trim()}`,
    );
  }
  return String(result.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean);
}

/** @param {string} root @param {string[]} args */
function gitOutput(root, args) {
  const result = childProcess.spawnSync('git', args, {
    cwd: root,
    env: isolatedGitEnvironment(),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${String(result.stderr || '').trim()}`,
    );
  }
  return String(result.stdout || '').trim();
}

/**
 * @param {Map<string, {id: string, file: string, decisionStatus: string, implementationStatus: string}>} adrs
 * @param {string[]} changedFiles
 */
export function buildAlphaSettlementManifest(adrs, changedFiles) {
  const changed = new Set(changedFiles);
  const progress = [...adrs.values()]
    .filter((adr) => adr.decisionStatus === 'accepted' && changed.has(adr.file))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((adr) => ({
      adr: adr.id,
      to: adr.implementationStatus,
      summary: `Exact candidate projects ${adr.implementationStatus}`,
    }));
  return {
    schema: 'kungfu.adr-release-pr/v1',
    kind: 'alpha-settlement',
    ...(progress.length > 0
      ? { progress }
      : {
          no_adr_progress_reason:
            'The exact qualified development delta contains no accepted ADR record changes',
        }),
  };
}

/** @param {object} manifest */
export function formatAlphaSettlementPrefix(manifest) {
  return `<!-- kungfu-adr-release:v1\n${JSON.stringify(manifest, null, 2)}\n-->`;
}

export function renderAlphaSettlement(options = {}) {
  const root = path.resolve(String(options.root || ROOT));
  const selectedSha = String(
    options.selectedSha ||
      process.env.BUILDCHAIN_CHANNEL_PATROL_SELECTED_SHA ||
      '',
  ).trim();
  const targetBranch = String(
    options.targetBranch ||
      process.env.BUILDCHAIN_CHANNEL_PATROL_TARGET_BRANCH ||
      '',
  ).trim();
  const outputValue = String(
    options.outputPath ||
      process.env.BUILDCHAIN_CHANNEL_PATROL_PR_BODY_PREFIX_OUTPUT ||
      '',
  ).trim();
  if (!outputValue) throw new Error('renderer output path is required');
  if (!/^[0-9a-f]{40}$/u.test(selectedSha))
    throw new Error('selected SHA must be an exact 40-character commit SHA');
  if (!/^alpha\/v[0-9]+\/v[0-9]+\.[0-9]+$/u.test(targetBranch))
    throw new Error('target branch must be an exact alpha/vN/vN.N channel');
  if (gitOutput(root, ['rev-parse', 'HEAD']) !== selectedSha)
    throw new Error('renderer checkout HEAD does not match the selected SHA');
  const targetRef = `refs/remotes/origin/${targetBranch}`;
  gitOutput(root, ['rev-parse', '--verify', `${targetRef}^{commit}`]);

  const contract = readJson(path.join(root, DEFAULT_CONTRACT));
  const adrs = loadAdrs(root, contract);
  const changedFiles = changedFilesBetween(targetRef, selectedSha, root);
  const manifest = buildAlphaSettlementManifest(adrs, changedFiles);
  const validation = evaluateReleaseGate({
    root,
    contract,
    adrs,
    authorityFindings: [],
    mode: 'alpha',
    manifest,
    changedFiles,
  });
  if (!validation.ok) {
    throw new Error(
      `generated alpha settlement is invalid: ${validation.findings
        .map((finding) => `${finding.code}: ${finding.message}`)
        .join('; ')}`,
    );
  }
  const prefix = formatAlphaSettlementPrefix(manifest);
  const outputPath = path.resolve(outputValue);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${prefix}\n`);
  return { prefix, manifest, changedFiles, targetRef };
}

/** @param {any} options */
export function validateStaticContract(options) {
  const root = path.resolve(options.root || ROOT);
  const contract =
    options.contract ||
    readJson(path.join(root, options.contractPath || DEFAULT_CONTRACT));
  /** @type {Finding[]} */
  const findings = [];
  if (contract.schema !== 'kungfu.adr-release-contract/v1') {
    findings.push({
      code: 'contract-schema',
      message: 'unsupported contract schema',
    });
  }
  if (contract.manifestSchema !== 'kungfu.adr-release-pr/v1') {
    findings.push({
      code: 'manifest-schema',
      message: 'unsupported manifest schema',
    });
  }
  if (!Array.isArray(contract.adrRoots) || contract.adrRoots.length === 0) {
    findings.push({
      code: 'adr-roots',
      message: 'contract must declare ADR roots',
    });
  }
  if (contract.deprecationLifecycle) {
    for (const field of ['contract', 'registry', 'candidateVersionFile']) {
      const value = String(contract.deprecationLifecycle[field] || '');
      if (!value || !fs.existsSync(path.join(root, value))) {
        findings.push({
          code: 'deprecation-authority',
          message: `deprecationLifecycle.${field} is missing or unresolved`,
        });
      }
    }
  }
  const approvers = stringList(contract.stable?.waiverApprovers);
  if (approvers.length === 0) {
    findings.push({
      code: 'waiver-approvers',
      message: 'stable waiver approvers cannot be empty',
    });
  }
  const waiverPath = path.join(root, String(contract.stable?.waiverFile || ''));
  if (!fs.existsSync(waiverPath)) {
    findings.push({
      code: 'waiver-file',
      message: 'stable waiver file does not exist',
    });
    return { ok: false, contract, waivers: [], findings };
  }
  const ledger = readJson(waiverPath);
  if (
    ledger.schema !== 'kungfu.adr-release-waivers/v1' ||
    !Array.isArray(ledger.waivers)
  ) {
    findings.push({
      code: 'waiver-schema',
      message: 'invalid ADR release waiver ledger',
    });
  }
  const ids = new Set();
  for (const waiver of ledger.waivers || []) {
    if (!waiver.waiver_id || ids.has(waiver.waiver_id)) {
      findings.push({
        code: 'waiver-id',
        message: 'waiver ids must be present and unique',
      });
    }
    ids.add(waiver.waiver_id);
  }
  return {
    ok: findings.length === 0,
    contract,
    waivers: ledger.waivers || [],
    findings,
  };
}

/** @param {any} options */
function releaseGateContext(options) {
  const root = path.resolve(options.root || ROOT);
  const staticResult = validateStaticContract({
    root,
    contract: options.contract,
    contractPath: options.contractPath,
  });
  const { contract, waivers } = staticResult;
  /** @type {Finding[]} */
  const findings = [
    ...staticResult.findings,
    ...(options.authorityFindings ?? validateAdrAuthority(root)),
  ];
  const manifest = options.manifest;
  if (!manifest || manifest.schema !== contract.manifestSchema) {
    findings.push({
      code: 'manifest-schema',
      message: 'PR manifest schema is missing or unsupported',
    });
  }
  const adrs = options.adrs || loadAdrs(root, contract);
  const changedFiles = options.changedFiles || [];
  const prUrl = String(options.prUrl || '');
  const mode = options.mode;
  /** @type {any[]} */
  const admitted = [];
  /** @type {any[]} */
  const waived = [];
  /** @type {any[]} */
  const blocked = [];

  const referenced = stringList(manifest?.adrs);
  return {
    options,
    root,
    contract,
    waivers,
    findings,
    manifest,
    adrs,
    changedFiles,
    prUrl,
    mode,
    admitted,
    waived,
    blocked,
    referenced,
  };
}

function checkReferenced({ referenced, adrs, findings }) {
  for (const id of referenced) {
    const adr = adrs.get(id);
    if (!adr) {
      findings.push({
        code: 'adr-reference',
        adr: id,
        message: `${id} does not exist`,
      });
    } else if (adr.decisionStatus !== 'accepted') {
      findings.push({
        code: 'adr-decision',
        adr: id,
        message: `${id} is not accepted`,
      });
    }
  }
}

function validateNeutralDevRelease(context) {
  const { options, contract, findings, manifest, changedFiles, adrs } = context;
  if (
    new RegExp(contract.dev.featureBranchPattern).test(
      String(options.headRef || ''),
    )
  ) {
    findings.push({
      code: 'feature-neutral',
      message:
        'feature branches must declare stage-ready or implemented intent',
    });
  }
  requireText(manifest?.reason, 'reason', findings);
  if (
    changedFiles.some((file) =>
      [...adrs.values()].some((adr) => adr.file === file),
    )
  ) {
    findings.push({
      code: 'neutral-adr-change',
      message: 'ADR-neutral PRs cannot modify ADR records',
    });
  }
}

function validateDevDelivery(context) {
  const { contract, findings, manifest, changedFiles, adrs, referenced } =
    context;
  if (!contract.dev.deliveryIntents.includes(manifest.intent)) {
    findings.push({
      code: 'dev-intent',
      message: 'dev delivery intent must be stage-ready or implemented',
    });
  }
  if (referenced.length === 0) {
    findings.push({
      code: 'adr-reference',
      message: 'dev deliveries must reference at least one ADR',
    });
  }
  requireText(manifest?.summary, 'summary', findings);
  if (stringList(manifest?.verification).length === 0) {
    findings.push({
      code: 'verification',
      message: 'dev deliveries must list verification evidence',
    });
  }
  checkReferenced(context);
  const allowed =
    manifest.intent === 'implemented'
      ? contract.dev.implementedCandidateStatuses
      : contract.dev.stageReadyStatuses;
  for (const id of referenced) {
    const adr = adrs.get(id);
    if (adr && !changedFiles.includes(adr.file)) {
      findings.push({
        code: 'dev-adr-projection',
        adr: id,
        message: `${id} must be updated in the feature PR so delivery evidence and implementation state remain synchronized`,
      });
    }
    if (adr && !allowed.includes(adr.implementationStatus)) {
      findings.push({
        code: 'dev-status',
        adr: id,
        message: `${manifest.intent} cannot project ${id} from implementation_status ${adr.implementationStatus}`,
      });
    }
    if (
      manifest.intent === 'implemented' &&
      adr &&
      adr.qualificationRefs.length === 0
    ) {
      findings.push({
        code: 'implemented-candidate-qualification',
        adr: id,
        message: `${id} needs qualification_refs before implemented intent`,
      });
    }
  }
}

function validateDevRelease(context) {
  if (context.manifest?.kind === 'adr-neutral')
    validateNeutralDevRelease(context);
  else if (context.manifest?.kind === 'dev-delivery')
    validateDevDelivery(context);
  else {
    const { findings } = context;
    findings.push({
      code: 'dev-kind',
      message: 'dev PR must be dev-delivery or adr-neutral',
    });
  }
}

function validateAlphaProgressEntry(context, entry, seen) {
  const { contract, findings, changedFiles, adrs } = context;
  const id = String(entry?.adr || '');
  const adr = adrs.get(id);
  if (!adr || adr.decisionStatus !== 'accepted') {
    findings.push({
      code: 'alpha-adr',
      adr: id,
      message: `${id || 'progress entry'} is not an accepted ADR`,
    });
    return;
  }
  if (seen.has(id))
    findings.push({
      code: 'alpha-duplicate',
      adr: id,
      message: `${id} appears more than once`,
    });
  seen.add(id);
  if (!contract.alpha.settlementStatuses.includes(entry.to))
    findings.push({
      code: 'alpha-status',
      adr: id,
      message: `${entry.to} is not a settlement status`,
    });
  else if (adr.implementationStatus !== entry.to)
    findings.push({
      code: 'alpha-projection',
      adr: id,
      message: `${id} projects ${adr.implementationStatus}, not declared ${entry.to}`,
    });
  if (!changedFiles.includes(adr.file))
    findings.push({
      code: 'alpha-evidence',
      adr: id,
      message: `${id} has no ADR record change in this promotion`,
    });
  requireText(entry?.summary, `${id} summary`, findings);
  if (entry.to === 'implemented' && adr.qualificationRefs.length === 0)
    findings.push({
      code: 'alpha-qualification',
      adr: id,
      message: `${id} cannot settle implemented without qualification_refs`,
    });
}

function validateAlphaCoverage(context, seen, noProgress) {
  const { findings, changedFiles, adrs } = context;
  const changedAcceptedAdrs = [...adrs.values()].filter(
    (adr) =>
      adr.decisionStatus === 'accepted' && changedFiles.includes(adr.file),
  );
  if (noProgress && changedAcceptedAdrs.length > 0)
    findings.push({
      code: 'alpha-unsettled-change',
      message: `no-progress settlement cannot contain changed accepted ADRs: ${changedAcceptedAdrs.map((adr) => adr.id).join(', ')}`,
    });
  for (const adr of changedAcceptedAdrs)
    if (!seen.has(adr.id) && !noProgress)
      findings.push({
        code: 'alpha-unsettled-change',
        adr: adr.id,
        message: `${adr.id} changed in the promotion but is absent from progress settlement`,
      });
}

function validateAlphaRelease(context) {
  const { findings, manifest } = context;
  if (manifest?.kind !== 'alpha-settlement') {
    findings.push({
      code: 'alpha-kind',
      message: 'alpha PR must declare an alpha-settlement',
    });
  }
  const progress = Array.isArray(manifest?.progress) ? manifest.progress : [];
  const noProgress = String(manifest?.no_adr_progress_reason || '');
  if ((progress.length === 0) === (noProgress.length === 0)) {
    findings.push({
      code: 'alpha-progress',
      message:
        'alpha settlement must declare progress or one explicit no-progress reason, but not both',
    });
  }
  if (noProgress) requireText(noProgress, 'no_adr_progress_reason', findings);
  const seen = new Set();
  for (const entry of progress)
    validateAlphaProgressEntry(context, entry, seen);
  validateAlphaCoverage(context, seen, noProgress);
}

function stableAdrConditions(contract, adr) {
  if (
    !contract.stable.admittedImplementationStatuses.includes(
      adr.implementationStatus,
    )
  )
    return [`implementation_status:${adr.implementationStatus}`];
  if (
    adr.implementationStatus === 'implemented' &&
    contract.stable.requireQualificationForImplemented &&
    adr.qualificationRefs.length === 0
  )
    return ['qualification:missing'];
  return [];
}

function settleStableAdr(context, adr, release, currentWaivers, usedWaivers) {
  const { contract, findings, prUrl, admitted, waived, blocked } = context;
  const conditions = stableAdrConditions(contract, adr);
  if (conditions.length === 0) {
    admitted.push({ adr: adr.id, status: adr.implementationStatus });
    return;
  }
  const waiver = currentWaivers.find((entry) => entry.adr === adr.id);
  const waiverConditions = stringList(waiver?.conditions);
  const valid =
    waiver &&
    waiver.expires_after === release &&
    contract.stable.waiverApprovers.includes(waiver.approved_by) &&
    waiver.approval_pr === prUrl &&
    /^https:\/\/github\.com\/kungfu-systems\/kungfu\/pull\/[0-9]+$/.test(
      String(waiver.approval_pr || ''),
    ) &&
    conditions.every((condition) => waiverConditions.includes(condition)) &&
    waiverConditions.every((condition) => conditions.includes(condition));
  if (valid) {
    requireText(waiver.reason, `${adr.id} waiver reason`, findings);
    requireText(waiver.risk, `${adr.id} waiver risk`, findings);
    requireText(waiver.mitigation, `${adr.id} waiver mitigation`, findings);
    usedWaivers.add(waiver.waiver_id);
    waived.push({ adr: adr.id, conditions, waiver: waiver.waiver_id });
  } else {
    blocked.push({ adr: adr.id, conditions });
    findings.push({
      code: 'stable-blocked',
      adr: adr.id,
      message: `${adr.id} is not stable-admissible: ${conditions.join(', ')}`,
    });
  }
}

function validateStableRelease(context) {
  const { contract, findings, manifest, adrs, waivers } = context;
  if (manifest?.kind !== 'stable-admission') {
    findings.push({
      code: 'stable-kind',
      message: 'stable PR must declare stable-admission',
    });
  }
  const release = String(manifest?.release || '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release)) {
    findings.push({
      code: 'stable-release',
      message: 'stable admission needs an exact semantic version',
    });
  }
  const currentWaivers = waivers.filter((waiver) => waiver.release === release);
  const usedWaivers = new Set();
  for (const adr of [...adrs.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    if (!contract.stable.requiredDecisionStatuses.includes(adr.decisionStatus))
      continue;
    settleStableAdr(context, adr, release, currentWaivers, usedWaivers);
  }
  for (const waiver of currentWaivers) {
    if (!usedWaivers.has(waiver.waiver_id)) {
      findings.push({
        code: 'waiver-stale',
        adr: waiver.adr,
        message: `${waiver.waiver_id} is invalid, unused, or broader than the current blocker`,
      });
    }
  }
}

function validateReleaseMode(context) {
  if (context.mode === 'dev') validateDevRelease(context);
  else if (context.mode === 'alpha') validateAlphaRelease(context);
  else if (context.mode === 'stable') validateStableRelease(context);
  else {
    const { findings, mode } = context;
    findings.push({
      code: 'mode',
      message: `unsupported gate mode: ${String(mode)}`,
    });
  }
}

function auditReleaseDeprecations(context) {
  const { options, root, contract, findings, manifest, mode } = context;
  let deprecations = null;
  if (contract.deprecationLifecycle) {
    const candidateVersion =
      mode === 'stable'
        ? String(manifest?.release || '')
        : mode === 'alpha'
          ? String(
              readJson(
                path.join(
                  root,
                  contract.deprecationLifecycle.candidateVersionFile,
                ),
              ).version || '',
            )
          : '';
    deprecations =
      options.deprecationReport ||
      auditDeprecations({
        root,
        contractPath: contract.deprecationLifecycle.contract,
        registryPath: contract.deprecationLifecycle.registry,
        release: candidateVersion || undefined,
        releaseDate: options.releaseDate,
        channel: ['alpha', 'stable'].includes(mode) ? mode : 'audit',
        strictDue: ['alpha', 'stable'].includes(mode),
      });
    for (const finding of deprecations.findings || []) {
      findings.push({
        code: finding.code || 'deprecation-release',
        adr: undefined,
        message: finding.entry
          ? `${finding.entry}: ${finding.message}`
          : finding.message,
      });
    }
  }
  return deprecations;
}

export function evaluateReleaseGate(options) {
  const context = releaseGateContext(options);
  validateReleaseMode(context);
  const deprecations = auditReleaseDeprecations(context);
  const { mode, manifest, findings, adrs, admitted, waived, blocked } = context;
  return {
    schema: 'kungfu.adr-release-report/v1',
    mode,
    release: manifest?.release || null,
    disposition:
      mode === 'dev' ? manifest?.intent || manifest?.kind : manifest?.kind,
    ok: findings.length === 0,
    summary: {
      acceptedAdrs: [...adrs.values()].filter(
        (adr) => adr.decisionStatus === 'accepted',
      ).length,
      admitted: admitted.length,
      waived: waived.length,
      blocked: blocked.length,
      findings: findings.length,
    },
    admitted,
    waived,
    blocked,
    deprecations,
    findings,
  };
}

function parseArgs(argv) {
  const args = { contractOnly: false, allowNonPr: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--contract-only') args.contractOnly = true;
    else if (arg === '--allow-non-pr') args.allowNonPr = true;
    else if (arg === '--github-event')
      args.event = process.env.GITHUB_EVENT_PATH;
    else if (arg === '--event') args.event = argv[++i];
    else if (arg === '--report') args.report = argv[++i];
    else if (arg === '--contract') args.contract = argv[++i];
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
      `## ADR release gate\n\n- Mode: \`${report.mode || 'contract'}\`\n- Result: **${report.ok ? 'admitted' : 'blocked'}**\n- Findings: ${report.findings.length}\n\n`,
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.env.BUILDCHAIN_CHANNEL_PATROL_PR_BODY_PREFIX_OUTPUT) {
      renderAlphaSettlement();
      process.exit(0);
    }
    const args = parseArgs(process.argv.slice(2));
    if (args.contractOnly) {
      const result = validateStaticContract({
        root: ROOT,
        contractPath: args.contract,
      });
      writeReport(
        { schema: 'kungfu.adr-release-report/v1', mode: 'contract', ...result },
        args.report,
      );
      if (!result.ok)
        throw new Error(
          result.findings.map((finding) => finding.message).join('; '),
        );
      console.log('[adr-release] contract and waiver ledger are valid');
      process.exit(0);
    }
    if (!args.event || !fs.existsSync(args.event)) {
      if (args.allowNonPr) {
        const report = {
          schema: 'kungfu.adr-release-report/v1',
          mode: 'not-applicable',
          ok: true,
          findings: [],
        };
        writeReport(report, args.report);
        console.log(
          '[adr-release] no pull-request event; release admission is not applicable',
        );
        process.exit(0);
      }
      throw new Error('a pull-request event is required');
    }
    const event = readJson(args.event);
    const pr = event.pull_request;
    if (!pr) {
      if (args.allowNonPr) {
        const report = {
          schema: 'kungfu.adr-release-report/v1',
          mode: 'not-applicable',
          ok: true,
          findings: [],
        };
        writeReport(report, args.report);
        console.log(
          '[adr-release] event is not a pull request; release admission is not applicable',
        );
        process.exit(0);
      }
      throw new Error('event does not contain pull_request');
    }
    const baseRef = String(pr.base?.ref || '');
    const mode = baseRef.startsWith('dev/')
      ? 'dev'
      : baseRef.startsWith('alpha/')
        ? 'alpha'
        : baseRef.startsWith('release/')
          ? 'stable'
          : '';
    const contract = readJson(
      path.join(ROOT, args.contract || DEFAULT_CONTRACT),
    );
    const manifest = parsePrManifest(
      String(pr.body || ''),
      contract.manifestMarker,
    );
    const changedFiles = changedFilesBetween(
      String(pr.base?.sha || ''),
      String(pr.head?.sha || 'HEAD'),
      ROOT,
    );
    const report = evaluateReleaseGate({
      root: ROOT,
      contract,
      manifest,
      mode,
      headRef: String(pr.head?.ref || ''),
      changedFiles,
      prUrl: String(pr.html_url || ''),
    });
    writeReport(report, args.report);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exit(1);
  } catch (error) {
    console.error(
      `[adr-release] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
