#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyAdrIdentity, identityFromAdrPath } from './adr-identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONTRACT = 'docs/document-metadata.contract.json';
const ADR_ROOT = 'docs/adr';
const ADR_PROFILE_PATTERN = '^docs/adr/(?!README\\.md$).+\\.(?:md|markdown)$';

/** @typedef {{code: string, file: string, line: number, message: string}} Finding */
/**
 * @typedef {{
 *   id: string,
 *   files?: string[],
 *   patterns?: string[],
 *   metadataMode: 'inline' | 'registry' | 'inline-optional',
 *   required: string[],
 *   constants?: Record<string, string>,
 *   enums?: Record<string, string[]>,
 *   forbidden?: string[]
 * }} MetadataProfile
 */
/**
 * @typedef {{
 *   schemaVersion: number,
 *   metadataSchema: string,
 *   metadataRegistry: string,
 *   metadataRegistryShards?: string[],
 *   adrIdentity?: {
 *     root: string,
 *     scheme: 'uuidv7',
 *     prefixes: string[],
 *     filenameProjection?: 'canonical-id-only'
 *   },
 *   optionalFields?: string[],
 *   sourceKinds?: string[],
 *   externalFrontmatterSchemas: {id: string, patterns: string[]}[],
 *   profiles: MetadataProfile[],
 *   adrRegistries?: never[],
 *   adrEvidence?: {
 *     commitFields: string[],
 *     pullRequestFields: string[],
 *     closureCommitField: string,
 *     qualificationRefField: string,
 *     statusesRequiringImplementationEvidence: string[],
 *     statusesRequiringClosure: string[],
 *     statusesForbiddingEvidence: string[],
 *     pullRequestPattern: string,
 *     legacyEvidenceExemptions: Record<string, string>
 *   }
 * }} MetadataContract
 */

/** @typedef {{schemaVersion: number, metadataSchema: string, documents: Record<string, Record<string, string | string[]>>}} MetadataRegistry */

/** @param {string} value */
function parseScalar(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const body = trimmed.slice(1, -1).trim();
    return body ? body.split(',').map((item) => parseScalar(item)) : [];
  }
  return trimmed;
}

/** @param {string} text */
export function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return { fields: new Map(), endLine: 1, malformed: true };
  const fields = new Map();
  const duplicates = [];
  for (let index = 1; index < end; index += 1) {
    const line = lines[index];
    if (!line || /^\s/.test(line) || line.trimStart().startsWith('#')) continue;
    const match = /^([a-z][a-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    if (fields.has(match[1]))
      duplicates.push({ key: match[1], line: index + 1 });
    else
      fields.set(match[1], { value: parseScalar(match[2]), line: index + 1 });
  }
  return { fields, duplicates, endLine: end + 1, malformed: false };
}

/** @param {string} root @param {string} contractPath */
export function readMetadataContract(
  root = ROOT,
  contractPath = DEFAULT_CONTRACT,
) {
  const contract = JSON.parse(
    fs.readFileSync(path.join(root, contractPath), 'utf8'),
  );
  if (contract.schemaVersion !== 1) {
    throw new Error(
      `${contractPath}: unsupported schemaVersion ${String(contract.schemaVersion)}`,
    );
  }
  if (
    contract.adrIdentity?.root !== ADR_ROOT ||
    contract.adrIdentity?.scheme !== 'uuidv7' ||
    JSON.stringify(contract.adrIdentity?.prefixes) !==
      JSON.stringify(['KF-ADR', 'SHIFU-ADR']) ||
    contract.adrIdentity?.filenameProjection !== 'canonical-id-only'
  ) {
    throw new Error(
      `${contractPath}: ADR identity policy must pin KF-ADR/SHIFU-ADR UUIDv7 and ID-only filenames`,
    );
  }
  const adrProfiles = (contract.profiles || []).filter(
    (profile) => profile.id === 'architecture-decision',
  );
  const adrRegistries = contract.adrRegistries || [];
  if (
    adrProfiles.length !== 1 ||
    adrProfiles[0].metadataMode !== 'inline' ||
    JSON.stringify(adrProfiles[0].patterns) !==
      JSON.stringify([ADR_PROFILE_PATTERN]) ||
    !adrProfiles[0].required?.includes('adr_id') ||
    adrRegistries.length !== 0
  ) {
    throw new Error(
      `${contractPath}: ADR metadata routing must be inline, recursively cover the canonical ADR directory, and have no shared identity registry`,
    );
  }
  return /** @type {MetadataContract} */ (contract);
}

/** @param {string} root @param {MetadataContract} contract */
function readMetadataRegistry(root, contract) {
  const paths = [
    contract.metadataRegistry,
    ...(contract.metadataRegistryShards || []),
  ];
  if (
    paths.some((item) => typeof item !== 'string' || !item.trim()) ||
    new Set(paths).size !== paths.length
  ) {
    throw new Error('document metadata registry paths must be unique strings');
  }
  /** @type {Record<string, Record<string, string | string[]>>} */
  const documents = {};
  const sources = new Map();
  for (const registryPath of paths) {
    const registry = JSON.parse(
      fs.readFileSync(path.join(root, registryPath), 'utf8'),
    );
    if (
      registry.schemaVersion !== 1 ||
      registry.metadataSchema !== contract.metadataSchema ||
      typeof registry.documents !== 'object' ||
      Array.isArray(registry.documents)
    ) {
      throw new Error(`${registryPath}: invalid document metadata registry`);
    }
    for (const [rel, entry] of Object.entries(registry.documents)) {
      if (sources.has(rel)) {
        throw new Error(
          `${registryPath}: duplicate document metadata authority for ${rel}; already declared in ${sources.get(rel)}`,
        );
      }
      documents[rel] = entry;
      sources.set(rel, registryPath);
    }
  }
  return { documents, paths, sources };
}

/** @param {string} rel @param {{files?: string[], patterns?: string[]}} rule */
function matches(rel, rule) {
  return (
    (rule.files || []).includes(rel) ||
    (rule.patterns || []).some((pattern) => new RegExp(pattern).test(rel))
  );
}

/** @param {string} value */
function canonicalDecisionStatus(value) {
  const match = /^(accepted|proposed|superseded|rejected|withdrawn)\b/i.exec(
    value.trim(),
  );
  return match?.[1].toLowerCase() || null;
}

/** @param {string} text */
function visibleDecisionStatus(text) {
  const bullet = /^- (?:Decision )?Status:\s*([^\n]+)/im.exec(text);
  if (bullet) return canonicalDecisionStatus(bullet[1]);
  const bold = /^\*\*(?:Decision )?Status:\*\*\s*([^\n]+)/im.exec(text);
  if (bold) return canonicalDecisionStatus(bold[1]);
  const section = /^## Status\s*\n+\s*([^\n]+)/im.exec(text);
  return section ? canonicalDecisionStatus(section[1]) : null;
}

/** @param {string} text */
function visibleAdrHeadingIdentity(text) {
  return /^#\s+([^:\s]+)(?::|\s|$)/m.exec(text)?.[1] || null;
}

/** @param {Map<string, {value: unknown, line: number}>} fields @param {MetadataProfile} profile @param {MetadataContract} contract @param {string} rel @param {Finding[]} findings */
function validateFields(fields, profile, contract, rel, findings) {
  const allowed = new Set([
    ...profile.required,
    ...Object.keys(profile.constants || {}),
    ...Object.keys(profile.enums || {}),
    ...(contract.optionalFields || []),
  ]);
  for (const [key, field] of fields) {
    if (!allowed.has(key)) {
      findings.push({
        code: 'metadata-unknown-field',
        file: rel,
        line: field.line,
        message: `metadata field is not declared by the contract: ${key}`,
      });
    }
  }
  for (const key of profile.required) {
    if (!fields.has(key)) {
      findings.push({
        code: 'metadata-required-field',
        file: rel,
        line: 1,
        message: `${profile.id} requires metadata field ${key}`,
      });
    }
  }
  for (const key of profile.forbidden || []) {
    const field = fields.get(key);
    if (field) {
      findings.push({
        code: 'metadata-forbidden-field',
        file: rel,
        line: field.line,
        message: `${profile.id} forbids ambiguous legacy field ${key}`,
      });
    }
  }
  for (const [key, expected] of Object.entries(profile.constants || {})) {
    const field = fields.get(key);
    if (field && field.value !== expected) {
      findings.push({
        code: 'metadata-constant',
        file: rel,
        line: field.line,
        message: `${key} must be ${expected} for ${profile.id}`,
      });
    }
  }
  for (const [key, allowed] of Object.entries(profile.enums || {})) {
    const field = fields.get(key);
    if (field && !allowed.includes(/** @type {string} */ (field.value))) {
      findings.push({
        code: 'metadata-enum',
        file: rel,
        line: field.line,
        message: `${key} must be one of: ${allowed.join(', ')}`,
      });
    }
  }
}

/** @param {Record<string, unknown>} values */
function registryFields(values) {
  return new Map(
    Object.entries(values).map(([key, value]) => [key, { value, line: 1 }]),
  );
}

function isolatedGitEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
}

/**
 * @param {string} root
 * @param {string | undefined} pullRequestBaseCommit
 */
function reachabilityRoots(root, pullRequestBaseCommit) {
  const env = isolatedGitEnvironment();
  if (pullRequestBaseCommit) {
    if (!/^[0-9a-f]{40}$/.test(pullRequestBaseCommit)) {
      throw new Error(
        'KUNGFU_ADR_EVIDENCE_BASE_SHA must be a full 40-character lowercase Git SHA',
      );
    }
    const exists = childProcess.spawnSync(
      'git',
      ['cat-file', '-e', `${pullRequestBaseCommit}^{commit}`],
      { cwd: root, env, stdio: 'ignore' },
    );
    if (exists.status !== 0) {
      throw new Error(
        `KUNGFU_ADR_EVIDENCE_BASE_SHA does not identify a commit in this checkout: ${pullRequestBaseCommit}`,
      );
    }
    return {
      roots: [pullRequestBaseCommit],
      label: `pull-request base history ${pullRequestBaseCommit}`,
    };
  }

  const roots = ['HEAD'];
  const mergeHead = childProcess.spawnSync(
    'git',
    ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'],
    { cwd: root, env, encoding: 'utf8' },
  );
  if (mergeHead.status === 0 && mergeHead.stdout.trim()) {
    roots.push(mergeHead.stdout.trim());
  }
  return { roots, label: 'the checked-out mainline history' };
}

/**
 * @param {string} root
 * @param {string} commit
 * @param {string | undefined} [pullRequestBaseCommit]
 */
export function validateReachableCommit(root, commit, pullRequestBaseCommit) {
  if (!/^[0-9a-f]{40}$/.test(commit))
    return 'must be a full 40-character lowercase Git SHA';
  const exists = childProcess.spawnSync(
    'git',
    ['cat-file', '-e', `${commit}^{commit}`],
    { cwd: root, env: isolatedGitEnvironment(), stdio: 'ignore' },
  );
  if (exists.status !== 0) return 'does not identify a commit in this checkout';
  const env = isolatedGitEnvironment();
  const reachability = reachabilityRoots(root, pullRequestBaseCommit);
  for (const candidate of reachability.roots) {
    const reachable = childProcess.spawnSync(
      'git',
      ['merge-base', '--is-ancestor', commit, candidate],
      { cwd: root, env, stdio: 'ignore' },
    );
    if (reachable.status === 0) return null;
  }
  return `is not reachable from ${reachability.label}`;
}

/**
 * Resolve every evidence commit in one Git cut. The previous per-reference
 * validation spawned up to three Git processes for every SHA, which made a
 * complete ADR authority pass disproportionately expensive.
 *
 * @param {string} root
 * @param {Set<string>} commits
 * @param {string | undefined} pullRequestBaseCommit
 */
function batchReachableCommitProblems(root, commits, pullRequestBaseCommit) {
  const candidates = [...commits].filter((commit) =>
    /^[0-9a-f]{40}$/.test(commit),
  );
  /** @type {Map<string, string | null>} */
  const problems = new Map();
  if (candidates.length === 0) return problems;

  const env = isolatedGitEnvironment();
  const reachability = reachabilityRoots(root, pullRequestBaseCommit);
  const objects = childProcess.spawnSync(
    'git',
    ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
    {
      cwd: root,
      env,
      encoding: 'utf8',
      input: `${candidates.map((commit) => `${commit}^{commit}`).join('\n')}\n`,
    },
  );
  const objectLines = String(objects.stdout || '')
    .trimEnd()
    .split('\n');

  /** @type {Map<string, string>} */
  const commitObjects = new Map();
  for (const [index, commit] of candidates.entries()) {
    const match = /^([0-9a-f]{40}) commit$/.exec(objectLines[index] || '');
    if (objects.status !== 0 || !match) {
      problems.set(commit, 'does not identify a commit in this checkout');
      continue;
    }
    commitObjects.set(commit, match[1]);
  }

  const history = childProcess.spawnSync(
    'git',
    ['rev-list', ...reachability.roots],
    { cwd: root, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const reachable = new Set(
    history.status === 0
      ? String(history.stdout || '')
          .split('\n')
          .filter(Boolean)
      : [],
  );
  for (const [commit, object] of commitObjects) {
    problems.set(
      commit,
      reachable.has(object)
        ? null
        : `is not reachable from ${reachability.label}`,
    );
  }
  return problems;
}

/** @param {string} root @param {string[]} files @param {MetadataContract} contract */
function evidenceCommitCandidates(root, files, contract) {
  const commits = new Set();
  const evidence = contract.adrEvidence;
  if (!evidence) return commits;
  const fields = [
    ...evidence.commitFields,
    evidence.closureCommitField,
    evidence.qualificationRefField,
  ];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!fields.some((field) => line.startsWith(`${field}:`))) continue;
      for (const match of line.matchAll(
        /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/g,
      ))
        commits.add(match[0]);
    }
  }
  return commits;
}

/** @param {string} value @param {string} field @param {string} rel @param {number} line @param {Finding[]} findings @param {Map<string, string | null>} commitProblems */
function checkCommit(value, field, rel, line, findings, commitProblems) {
  const problem = /^[0-9a-f]{40}$/.test(value)
    ? commitProblems.has(value)
      ? commitProblems.get(value)
      : 'does not identify a commit in this checkout'
    : 'must be a full 40-character lowercase Git SHA';
  if (problem) {
    findings.push({
      code: 'adr-evidence-commit',
      file: rel,
      line,
      message: `${field} ${value} ${problem}`,
    });
  }
}

/** @param {Map<string, {value: unknown, line: number}>} fields @param {string} rel @param {string} root @param {MetadataContract} contract @param {Finding[]} findings @param {Map<string, string | null>} commitProblems */
function validateAdrEvidence(
  fields,
  rel,
  root,
  contract,
  findings,
  commitProblems,
) {
  const evidence = contract.adrEvidence;
  if (!evidence) return;
  const id = String(fields.get('adr_id')?.value || '');
  const status = String(fields.get('implementation_status')?.value || '');
  const exemption = evidence.legacyEvidenceExemptions[id];
  const commits = fields.get(evidence.commitFields[0]);
  const prs = fields.get(evidence.pullRequestFields[0]);
  const closureCommit = fields.get(evidence.closureCommitField);
  const closurePr = fields.get(evidence.closurePullRequestField);
  const qualifications = fields.get(evidence.qualificationRefField);
  const present = [commits, prs, closureCommit, closurePr, qualifications].some(
    Boolean,
  );
  const evidenceComplete =
    (commits || prs) &&
    (!evidence.statusesRequiringClosure.includes(status) ||
      closureCommit ||
      closurePr);

  if (
    exemption &&
    (!evidence.statusesRequiringImplementationEvidence.includes(status) ||
      evidenceComplete)
  ) {
    findings.push({
      code: 'adr-evidence-exemption-stale',
      file: rel,
      line: 1,
      message: `legacy evidence exemption for ${id} is no longer needed`,
    });
  }

  if (
    evidence.statusesRequiringImplementationEvidence.includes(status) &&
    !commits &&
    !prs &&
    !exemption
  ) {
    findings.push({
      code: 'adr-evidence-required',
      file: rel,
      line: 1,
      message: `${status} requires implementation_commits or implementation_prs`,
    });
  }
  if (
    evidence.statusesRequiringClosure.includes(status) &&
    !closureCommit &&
    !closurePr &&
    !exemption
  ) {
    findings.push({
      code: 'adr-closure-required',
      file: rel,
      line: 1,
      message: `${status} requires closure_commit or closure_pr`,
    });
  }
  if (evidence.statusesForbiddingEvidence.includes(status) && present) {
    findings.push({
      code: 'adr-evidence-contradiction',
      file: rel,
      line: 1,
      message: `${status} cannot declare implementation evidence`,
    });
  }

  for (const field of [commits, prs, qualifications]) {
    if (field && !Array.isArray(field.value)) {
      findings.push({
        code: 'adr-evidence-list',
        file: rel,
        line: field.line,
        message: 'ADR evidence collections must be inline YAML lists',
      });
    }
  }
  if (Array.isArray(commits?.value)) {
    for (const commit of commits.value)
      checkCommit(
        String(commit),
        evidence.commitFields[0],
        rel,
        commits.line,
        findings,
        commitProblems,
      );
  }
  if (closureCommit) {
    checkCommit(
      String(closureCommit.value),
      evidence.closureCommitField,
      rel,
      closureCommit.line,
      findings,
      commitProblems,
    );
  }
  const prPattern = new RegExp(evidence.pullRequestPattern);
  if (Array.isArray(prs?.value)) {
    for (const pr of prs.value) {
      if (!prPattern.test(String(pr))) {
        findings.push({
          code: 'adr-evidence-pr',
          file: rel,
          line: prs.line,
          message: `implementation_prs must use a stable kungfu-systems/kungfu PR URL: ${String(pr)}`,
        });
      }
    }
  }
  if (closurePr && !prPattern.test(String(closurePr.value))) {
    findings.push({
      code: 'adr-evidence-pr',
      file: rel,
      line: closurePr.line,
      message: `closure_pr must use a stable kungfu-systems/kungfu PR URL: ${String(closurePr.value)}`,
    });
  }
  if (Array.isArray(qualifications?.value)) {
    for (const reference of qualifications.value) {
      const value = String(reference);
      if (value.startsWith('commit:')) {
        checkCommit(
          value.slice('commit:'.length),
          evidence.qualificationRefField,
          rel,
          qualifications.line,
          findings,
          commitProblems,
        );
      } else if (
        path.isAbsolute(value) ||
        value.split('/').includes('..') ||
        !fs.existsSync(path.join(root, value))
      ) {
        findings.push({
          code: 'adr-evidence-qualification',
          file: rel,
          line: qualifications.line,
          message: `qualification_refs must be an existing repository-relative path or commit:<sha>: ${value}`,
        });
      }
    }
  }
}

/**
 * @typedef {{
 *   rel: string,
 *   decision: string,
 *   implementation: string,
 *   supersedes: string[],
 *   supersededBy: string[],
 *   amends: string[],
 *   amendedBy: string[],
 *   line: number,
 *   supersedesLine: number,
 *   supersededByLine: number,
 *   amendsLine: number,
 *   amendedByLine: number
 * }} AdrRecord
 */

/**
 * @typedef {{
 *   root: string,
 *   contract: MetadataContract,
 *   findings: Finding[],
 *   registered: Record<string, Record<string, string | string[]>>,
 *   registryLabel: string,
 *   adrIds: Set<string>,
 *   adrRecords: Map<string, AdrRecord>,
 *   commitProblems: Map<string, string | null>
 * }} MetadataValidationContext
 */

/**
 * @param {MetadataValidationContext} context
 * @param {string} rel
 * @param {string} text
 */
function selectMetadataProfile(context, rel, text) {
  const { contract, findings, registered } = context;
  const adrRoot = contract.adrIdentity?.root || ADR_ROOT;
  const isAdrDocument =
    Boolean(adrRoot) &&
    rel.startsWith(`${adrRoot}/`) &&
    rel !== `${adrRoot}/README.md` &&
    /\.(?:md|markdown)$/.test(rel);
  if (
    !isAdrDocument &&
    contract.externalFrontmatterSchemas.some((schema) => matches(rel, schema))
  ) {
    if (registered[rel]) {
      findings.push({
        code: 'metadata-authority-duplicate',
        file: rel,
        line: 1,
        message:
          'external-schema document cannot also use the Kungfu metadata registry',
      });
    }
    return null;
  }
  const profile = isAdrDocument
    ? contract.profiles.find(
        (candidate) => candidate.id === 'architecture-decision',
      )
    : contract.profiles.find((candidate) => matches(rel, candidate));
  if (!profile) {
    findings.push({
      code: 'metadata-profile',
      file: rel,
      line: 1,
      message: 'document is not routed to a metadata profile',
    });
    return null;
  }
  return { adrRoot, profile, text };
}

/**
 * @param {MetadataValidationContext} context
 * @param {string} rel
 * @param {string} text
 * @param {MetadataProfile} profile
 */
function resolveDocumentFields(context, rel, text, profile) {
  const { contract, findings, registered, registryLabel } = context;
  const frontmatter = parseFrontmatter(text);
  const registryEntry = registered[rel];
  if (profile.metadataMode === 'registry') {
    if (frontmatter) {
      findings.push({
        code: 'metadata-authority-duplicate',
        file: rel,
        line: 1,
        message: `${profile.id} metadata belongs in ${registryLabel}, not visible frontmatter`,
      });
    }
    if (!registryEntry) {
      findings.push({
        code: 'metadata-registry-required',
        file: rel,
        line: 1,
        message: `${profile.id} requires one entry in ${registryLabel}`,
      });
      return null;
    }
  } else if (registryEntry) {
    findings.push({
      code: 'metadata-authority-duplicate',
      file: rel,
      line: 1,
      message: `${profile.id} metadata must be inline and cannot also appear in the registry`,
    });
  }
  if (profile.metadataMode === 'inline' && !frontmatter) {
    findings.push({
      code: 'metadata-required',
      file: rel,
      line: 1,
      message: `frontmatter required by ${profile.id} profile`,
    });
    return null;
  }
  if (
    profile.metadataMode === 'inline-optional' &&
    !frontmatter &&
    !registryEntry
  ) {
    return null;
  }
  if (frontmatter?.malformed) {
    findings.push({
      code: 'metadata-malformed',
      file: rel,
      line: 1,
      message: 'frontmatter is missing its closing delimiter',
    });
    return null;
  }
  for (const duplicate of frontmatter?.duplicates || []) {
    findings.push({
      code: 'metadata-duplicate',
      file: rel,
      line: duplicate.line,
      message: `duplicate frontmatter field: ${duplicate.key}`,
    });
  }
  const fields = registryEntry
    ? registryFields(registryEntry)
    : frontmatter?.fields || new Map();
  const headerText = frontmatter
    ? text
        .split(/\r?\n/)
        .slice(1, frontmatter.endLine - 1)
        .join('\n')
    : '';
  if (/^\s+[a-z][a-z0-9_]*\s*:/m.test(headerText)) {
    findings.push({
      code: 'metadata-nested-field',
      file: rel,
      line: 1,
      message:
        'Kungfu metadata is flat; nested maintenance or generation attribution is not allowed',
    });
  }
  validateFields(fields, profile, contract, rel, findings);
  return { fields, frontmatter };
}

/**
 * @param {MetadataValidationContext} context
 * @param {string} rel
 * @param {Map<string, {value: unknown, line: number}>} fields
 */
function validateSourceKinds(context, rel, fields) {
  const sources = fields.get('sources');
  if (!sources) return;
  const allowed = context.contract.sourceKinds || [];
  if (!Array.isArray(sources.value)) {
    context.findings.push({
      code: 'metadata-sources',
      file: rel,
      line: sources.line,
      message: 'sources must be an inline YAML list',
    });
    return;
  }
  for (const source of sources.value) {
    if (!allowed.includes(source)) {
      context.findings.push({
        code: 'metadata-sources',
        file: rel,
        line: sources.line,
        message: `unknown source kind: ${String(source)}`,
      });
    }
  }
}

/**
 * @param {MetadataValidationContext} context
 * @param {string} rel
 * @param {string} adrRoot
 */
function validateAdrPath(context, rel, adrRoot) {
  const { contract, findings } = context;
  if (contract.adrIdentity && path.posix.dirname(rel) !== adrRoot) {
    findings.push({
      code: 'adr-path-layout',
      file: rel,
      line: 1,
      message:
        'ADR records must be direct children of the canonical ADR directory',
    });
  }
  if (!rel.endsWith('.md')) {
    findings.push({
      code: 'adr-path-extension',
      file: rel,
      line: 1,
      message: 'ADR records require the canonical lowercase .md extension',
    });
  }
}

/**
 * @param {MetadataValidationContext} context
 * @param {string} rel
 * @param {Map<string, {value: unknown, line: number}>} fields
 */
function collectAdrRelations(context, rel, fields) {
  const relations = {
    supersedes: fields.get('supersedes'),
    supersededBy: fields.get('superseded_by'),
    amends: fields.get('amends'),
    amendedBy: fields.get('amended_by'),
  };
  for (const [name, field] of [
    ['supersedes', relations.supersedes],
    ['superseded_by', relations.supersededBy],
    ['amends', relations.amends],
    ['amended_by', relations.amendedBy],
  ]) {
    if (field && !Array.isArray(field.value)) {
      context.findings.push({
        code: 'adr-supersession-list',
        file: rel,
        line: field.line,
        message: `${name} must be an inline YAML list`,
      });
    }
  }
  return relations;
}

function storeAdrRecord(context, rel, fields, id, relations) {
  const idValue = String(id.value);
  if (context.adrRecords.has(idValue)) {
    context.findings.push({
      code: 'adr-id-duplicate',
      file: rel,
      line: id.line,
      message: `adr_id is already used by ${context.adrRecords.get(idValue).rel}`,
    });
  }
  context.adrRecords.set(idValue, {
    rel,
    decision: String(fields.get('decision_status')?.value || ''),
    implementation: String(fields.get('implementation_status')?.value || ''),
    supersedes: Array.isArray(relations.supersedes?.value)
      ? relations.supersedes.value.map(String)
      : [],
    supersededBy: Array.isArray(relations.supersededBy?.value)
      ? relations.supersededBy.value.map(String)
      : [],
    amends: Array.isArray(relations.amends?.value)
      ? relations.amends.value.map(String)
      : [],
    amendedBy: Array.isArray(relations.amendedBy?.value)
      ? relations.amendedBy.value.map(String)
      : [],
    line: id.line,
    supersedesLine: relations.supersedes?.line || id.line,
    supersededByLine: relations.supersededBy?.line || id.line,
    amendsLine: relations.amends?.line || id.line,
    amendedByLine: relations.amendedBy?.line || id.line,
  });
}

/**
 * @param {MetadataValidationContext} context
 * @param {string} rel
 * @param {string} adrRoot
 * @param {Map<string, {value: unknown, line: number}>} fields
 */
function recordAdrRelations(context, rel, adrRoot, fields) {
  const { findings, adrIds } = context;
  validateAdrPath(context, rel, adrRoot);
  const id = fields.get('adr_id');
  if (!id) {
    findings.push({
      code: 'adr-id-required',
      file: rel,
      line: 1,
      message: 'ADR records require inline adr_id metadata',
    });
  }
  if (id) adrIds.add(String(id.value));
  const relations = collectAdrRelations(context, rel, fields);
  if (id) storeAdrRecord(context, rel, fields, id, relations);
  return id;
}

/**
 * @param {MetadataValidationContext} context
 * @param {string} rel
 * @param {string} text
 * @param {ReturnType<typeof parseFrontmatter>} frontmatter
 * @param {Map<string, {value: unknown, line: number}>} fields
 * @param {{value: unknown, line: number} | undefined} id
 */
function validateAdrProjection(context, rel, text, frontmatter, fields, id) {
  const { findings } = context;
  const expectedId = identityFromAdrPath(rel);
  const identity = id ? classifyAdrIdentity(String(id.value)) : null;
  if (id && !identity) {
    findings.push({
      code: 'adr-id-format',
      file: rel,
      line: id.line,
      message: 'ADR identities must be KF-ADR-<UUIDv7> or SHIFU-ADR-<UUIDv7>',
    });
  }
  if (!expectedId) {
    findings.push({
      code: 'adr-filename-identity',
      file: rel,
      line: 1,
      message:
        'ADR filenames must equal the full canonical UUIDv7 identity plus .md',
    });
  }
  if (id && id.value !== expectedId) {
    findings.push({
      code: 'adr-id-drift',
      file: rel,
      line: id.line,
      message: `adr_id must match filename: ${expectedId}`,
    });
  }
  const headingIdentity = visibleAdrHeadingIdentity(text);
  if (!headingIdentity || (id && headingIdentity !== id.value)) {
    findings.push({
      code: 'adr-heading-id-drift',
      file: rel,
      line: (frontmatter?.endLine || 1) + 1,
      message: `ADR heading identity must match adr_id: ${String(id?.value || '')}`,
    });
  }
  const visible = visibleDecisionStatus(text);
  const decision = fields.get('decision_status');
  if (!visible) {
    findings.push({
      code: 'adr-status-projection',
      file: rel,
      line: (frontmatter?.endLine || 1) + 1,
      message: 'ADR body must project a visible decision status',
    });
  } else if (decision && visible !== decision.value) {
    findings.push({
      code: 'adr-status-drift',
      file: rel,
      line: (frontmatter?.endLine || 1) + 1,
      message: `visible status ${visible} differs from decision_status ${String(decision.value)}`,
    });
  }
}

/**
 * @param {MetadataValidationContext} context
 * @param {string} rel
 * @param {string} text
 * @param {string} adrRoot
 * @param {ReturnType<typeof parseFrontmatter>} frontmatter
 * @param {Map<string, {value: unknown, line: number}>} fields
 */
function validateAdrDocument(context, rel, text, adrRoot, frontmatter, fields) {
  const id = recordAdrRelations(context, rel, adrRoot, fields);
  validateAdrProjection(context, rel, text, frontmatter, fields, id);
  validateAdrEvidence(
    fields,
    rel,
    context.root,
    context.contract,
    context.findings,
    context.commitProblems,
  );
}

/** @param {MetadataValidationContext} context @param {string} id @param {AdrRecord} record */
function validateAdrState(context, id, record) {
  const terminal = ['superseded', 'rejected', 'withdrawn'].includes(
    record.decision,
  );
  if (terminal && record.implementation !== 'not-applicable') {
    context.findings.push({
      code: 'adr-terminal-implementation',
      file: record.rel,
      line: record.line,
      message: `${record.decision} decisions require implementation_status not-applicable`,
    });
  }
  if (record.decision === 'superseded' && record.supersededBy.length === 0) {
    context.findings.push({
      code: 'adr-supersession-missing',
      file: record.rel,
      line: record.line,
      message: `${id} is superseded but does not declare superseded_by`,
    });
  }
  if (record.decision !== 'superseded' && record.supersededBy.length > 0) {
    context.findings.push({
      code: 'adr-supersession-state',
      file: record.rel,
      line: record.supersededByLine,
      message: `${id} declares superseded_by but decision_status is ${record.decision}`,
    });
  }
}

/** @param {MetadataValidationContext} context @param {string} id @param {AdrRecord} record */
function validateAdrSupersession(context, id, record) {
  for (const targetId of record.supersedes) {
    const target = context.adrRecords.get(targetId);
    if (targetId === id || !target) {
      context.findings.push({
        code: 'adr-supersession-target',
        file: record.rel,
        line: record.supersedesLine,
        message: `${id} supersedes invalid target ${targetId}`,
      });
    } else if (
      target.decision !== 'superseded' ||
      !target.supersededBy.includes(id)
    ) {
      context.findings.push({
        code: 'adr-supersession-reciprocal',
        file: record.rel,
        line: record.supersedesLine,
        message: `${id} -> ${targetId} must be reciprocal and target a superseded decision`,
      });
    }
  }
  for (const successorId of record.supersededBy) {
    const successor = context.adrRecords.get(successorId);
    if (
      successorId === id ||
      !successor ||
      !successor.supersedes.includes(id)
    ) {
      context.findings.push({
        code: 'adr-supersession-reciprocal',
        file: record.rel,
        line: record.supersededByLine,
        message: `${id} <- ${successorId} must be reciprocal`,
      });
    }
  }
}

/** @param {MetadataValidationContext} context @param {string} id @param {AdrRecord} record */
function validateAdrAmendment(context, id, record) {
  for (const targetId of record.amends) {
    const target = context.adrRecords.get(targetId);
    if (targetId === id || !target || !target.amendedBy.includes(id)) {
      context.findings.push({
        code: 'adr-amendment-reciprocal',
        file: record.rel,
        line: record.amendsLine,
        message: `${id} -> ${targetId} amendment must name an existing reciprocal target`,
      });
    }
  }
  for (const successorId of record.amendedBy) {
    const successor = context.adrRecords.get(successorId);
    if (successorId === id || !successor || !successor.amends.includes(id)) {
      context.findings.push({
        code: 'adr-amendment-reciprocal',
        file: record.rel,
        line: record.amendedByLine,
        message: `${id} <- ${successorId} amendment must be reciprocal`,
      });
    }
  }
}

/** @param {Map<string, AdrRecord>} records @param {'supersedes' | 'amends'} relation */
function firstRelationCycle(records, relation) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const cyclic = (records.get(id)?.[relation] || []).some((target) =>
      visit(target),
    );
    visiting.delete(id);
    visited.add(id);
    return cyclic;
  };
  for (const id of records.keys()) {
    if (visit(id)) return id;
  }
  return null;
}

/**
 * @param {{root?: string, files: string[], contract?: MetadataContract, evidenceBaseCommit?: string}} options
 * @returns {Finding[]}
 */
export function validateDocumentMetadata(options) {
  const root = path.resolve(options.root || ROOT);
  const contract = options.contract || readMetadataContract(root);
  const pullRequestBaseCommit =
    options.evidenceBaseCommit ||
    (root === ROOT
      ? process.env.KUNGFU_ADR_EVIDENCE_BASE_SHA?.trim()
      : undefined) ||
    undefined;
  /** @type {Finding[]} */
  const findings = [];
  const metadataRegistry = readMetadataRegistry(root, contract);
  /** @type {MetadataValidationContext} */
  const context = {
    root,
    contract,
    findings,
    registered: metadataRegistry.documents,
    registryLabel: metadataRegistry.paths.join(', '),
    adrIds: new Set(),
    adrRecords: new Map(),
    commitProblems: batchReachableCommitProblems(
      root,
      evidenceCommitCandidates(root, options.files, contract),
      pullRequestBaseCommit,
    ),
  };

  for (const rel of options.files) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const route = selectMetadataProfile(context, rel, text);
    if (!route) continue;
    const resolved = resolveDocumentFields(context, rel, text, route.profile);
    if (!resolved) continue;
    validateSourceKinds(context, rel, resolved.fields);
    if (route.profile.id === 'architecture-decision') {
      validateAdrDocument(
        context,
        rel,
        text,
        route.adrRoot,
        resolved.frontmatter,
        resolved.fields,
      );
    }
  }

  const fileSet = new Set(options.files);
  for (const rel of Object.keys(context.registered)) {
    if (!fileSet.has(rel)) {
      findings.push({
        code: 'metadata-registry-orphan',
        file: metadataRegistry.sources.get(rel) || contract.metadataRegistry,
        line: 1,
        message: `registry entry has no tracked Markdown document: ${rel}`,
      });
    }
  }
  for (const id of Object.keys(
    contract.adrEvidence?.legacyEvidenceExemptions || {},
  )) {
    if (!context.adrIds.has(id)) {
      findings.push({
        code: 'adr-evidence-exemption-orphan',
        file: DEFAULT_CONTRACT,
        line: 1,
        message: `legacy evidence exemption has no ADR record: ${id}`,
      });
    }
  }

  for (const [id, record] of context.adrRecords) {
    validateAdrState(context, id, record);
    validateAdrSupersession(context, id, record);
    validateAdrAmendment(context, id, record);
  }

  const supersessionCycle = firstRelationCycle(
    context.adrRecords,
    'supersedes',
  );
  if (supersessionCycle) {
    const record = context.adrRecords.get(supersessionCycle);
    findings.push({
      code: 'adr-supersession-cycle',
      file: record.rel,
      line: record.line,
      message: `ADR supersession graph contains a cycle reachable from ${supersessionCycle}`,
    });
  }

  const amendmentCycle = firstRelationCycle(context.adrRecords, 'amends');
  if (amendmentCycle) {
    const record = context.adrRecords.get(amendmentCycle);
    findings.push({
      code: 'adr-amendment-cycle',
      file: record.rel,
      line: record.amendsLine,
      message: `ADR amendment graph contains a cycle through ${amendmentCycle}`,
    });
  }

  return findings.sort(
    (left, right) =>
      left.file.localeCompare(right.file) || left.line - right.line,
  );
}
