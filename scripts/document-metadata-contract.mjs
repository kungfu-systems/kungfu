#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONTRACT = 'docs/document-metadata.contract.json';

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
 *   optionalFields?: string[],
 *   sourceKinds?: string[],
 *   externalFrontmatterSchemas: {id: string, patterns: string[]}[],
 *   profiles: MetadataProfile[],
 *   adrRegistries: {index: string, recordPattern: string}[],
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
  return /** @type {MetadataContract} */ (contract);
}

/** @param {string} root @param {MetadataContract} contract */
function readMetadataRegistry(root, contract) {
  const registry = JSON.parse(
    fs.readFileSync(path.join(root, contract.metadataRegistry), 'utf8'),
  );
  if (
    registry.schemaVersion !== 1 ||
    registry.metadataSchema !== contract.metadataSchema ||
    typeof registry.documents !== 'object' ||
    Array.isArray(registry.documents)
  ) {
    throw new Error(
      `${contract.metadataRegistry}: invalid document metadata registry`,
    );
  }
  return /** @type {MetadataRegistry} */ (registry);
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
function indexStatuses(text) {
  const result = new Map();
  const row = /^\|\s*\[([^\]]+)]\(([^)]+)\)\s*\|\s*([^|]+)\|/gm;
  for (const match of text.matchAll(row)) {
    const rawStatus = match[3].trim();
    const status = canonicalDecisionStatus(rawStatus);
    const targetId = /(SHIFU-ADR-[0-9]{4}|ADR-[0-9]{4})-/.exec(match[2])?.[1];
    if (status)
      result.set(targetId || match[1], {
        status,
        rawStatus,
        target: match[2],
      });
  }
  return result;
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

/** @param {string} root @param {string} commit */
function validateReachableCommit(root, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit))
    return 'must be a full 40-character lowercase Git SHA';
  const exists = childProcess.spawnSync(
    'git',
    ['cat-file', '-e', `${commit}^{commit}`],
    { cwd: root, env: isolatedGitEnvironment(), stdio: 'ignore' },
  );
  if (exists.status !== 0) return 'does not identify a commit in this checkout';
  const reachable = childProcess.spawnSync(
    'git',
    ['merge-base', '--is-ancestor', commit, 'HEAD'],
    { cwd: root, env: isolatedGitEnvironment(), stdio: 'ignore' },
  );
  return reachable.status === 0
    ? null
    : 'is not reachable from the checked-out mainline history';
}

/** @param {string} value @param {string} field @param {string} rel @param {number} line @param {string} root @param {Finding[]} findings */
function checkCommit(value, field, rel, line, root, findings) {
  const problem = validateReachableCommit(root, value);
  if (problem) {
    findings.push({
      code: 'adr-evidence-commit',
      file: rel,
      line,
      message: `${field} ${value} ${problem}`,
    });
  }
}

/** @param {Map<string, {value: unknown, line: number}>} fields @param {string} rel @param {string} root @param {MetadataContract} contract @param {Finding[]} findings */
function validateAdrEvidence(fields, rel, root, contract, findings) {
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
        root,
        findings,
      );
  }
  if (closureCommit) {
    checkCommit(
      String(closureCommit.value),
      evidence.closureCommitField,
      rel,
      closureCommit.line,
      root,
      findings,
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
          root,
          findings,
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
 * @param {{root?: string, files: string[], contract?: MetadataContract}} options
 * @returns {Finding[]}
 */
export function validateDocumentMetadata(options) {
  const root = path.resolve(options.root || ROOT);
  const contract = options.contract || readMetadataContract(root);
  /** @type {Finding[]} */
  const findings = [];
  const documents = new Map();
  const metadataRegistry = readMetadataRegistry(root, contract);
  const registered = metadataRegistry.documents;
  const fileSet = new Set(options.files);
  const adrIds = new Set();
  const adrRecords = new Map();

  for (const rel of options.files) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    documents.set(rel, text);
    if (
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
      continue;
    }
    const profile = contract.profiles.find((candidate) =>
      matches(rel, candidate),
    );
    if (!profile) {
      findings.push({
        code: 'metadata-profile',
        file: rel,
        line: 1,
        message: 'document is not routed to a metadata profile',
      });
      continue;
    }
    const frontmatter = parseFrontmatter(text);
    const registryEntry = registered[rel];
    if (profile.metadataMode === 'registry') {
      if (frontmatter) {
        findings.push({
          code: 'metadata-authority-duplicate',
          file: rel,
          line: 1,
          message: `${profile.id} metadata belongs in ${contract.metadataRegistry}, not visible frontmatter`,
        });
      }
      if (!registryEntry) {
        findings.push({
          code: 'metadata-registry-required',
          file: rel,
          line: 1,
          message: `${profile.id} requires one entry in ${contract.metadataRegistry}`,
        });
        continue;
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
      continue;
    }
    if (
      profile.metadataMode === 'inline-optional' &&
      !frontmatter &&
      !registryEntry
    ) {
      continue;
    }
    if (frontmatter?.malformed) {
      findings.push({
        code: 'metadata-malformed',
        file: rel,
        line: 1,
        message: 'frontmatter is missing its closing delimiter',
      });
      continue;
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
    if (profile.id === 'adr-redirect') {
      const movedTo = String(fields.get('moved_to')?.value || '');
      const canonicalDirectory = path.posix.dirname(
        contract.adrRegistries[0]?.index || 'docs/adr/README.md',
      );
      const expected = `${canonicalDirectory}/${path.basename(rel)}`;
      if (movedTo !== expected) {
        findings.push({
          code: 'adr-redirect-target',
          file: rel,
          line: fields.get('moved_to')?.line || 1,
          message: `ADR redirect must target its canonical record: ${expected}`,
        });
      } else if (!fileSet.has(movedTo)) {
        findings.push({
          code: 'adr-redirect-missing',
          file: rel,
          line: fields.get('moved_to')?.line || 1,
          message: `ADR redirect target is not a tracked Markdown document: ${movedTo}`,
        });
      }
    }
    const sources = fields.get('sources');
    if (sources) {
      const allowed = contract.sourceKinds || [];
      if (!Array.isArray(sources.value)) {
        findings.push({
          code: 'metadata-sources',
          file: rel,
          line: sources.line,
          message: 'sources must be an inline YAML list',
        });
      } else {
        for (const source of sources.value) {
          if (!allowed.includes(source)) {
            findings.push({
              code: 'metadata-sources',
              file: rel,
              line: sources.line,
              message: `unknown source kind: ${String(source)}`,
            });
          }
        }
      }
    }

    if (profile.id === 'architecture-decision') {
      const expectedId = /\/(SHIFU-ADR-[0-9]{4}|ADR-[0-9]{4})-/.exec(
        `/${rel}`,
      )?.[1];
      const id = fields.get('adr_id');
      if (id) adrIds.add(String(id.value));
      const supersedesField = fields.get('supersedes');
      const supersededByField = fields.get('superseded_by');
      for (const [name, field] of [
        ['supersedes', supersedesField],
        ['superseded_by', supersededByField],
      ]) {
        if (field && !Array.isArray(field.value)) {
          findings.push({
            code: 'adr-supersession-list',
            file: rel,
            line: field.line,
            message: `${name} must be an inline YAML list`,
          });
        }
      }
      if (id) {
        adrRecords.set(String(id.value), {
          rel,
          decision: String(fields.get('decision_status')?.value || ''),
          implementation: String(
            fields.get('implementation_status')?.value || '',
          ),
          supersedes: Array.isArray(supersedesField?.value)
            ? supersedesField.value.map(String)
            : [],
          supersededBy: Array.isArray(supersededByField?.value)
            ? supersededByField.value.map(String)
            : [],
          line: id.line,
          supersedesLine: supersedesField?.line || id.line,
          supersededByLine: supersededByField?.line || id.line,
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
      validateAdrEvidence(fields, rel, root, contract, findings);
    }
  }

  for (const rel of Object.keys(registered)) {
    if (!fileSet.has(rel)) {
      findings.push({
        code: 'metadata-registry-orphan',
        file: contract.metadataRegistry,
        line: 1,
        message: `registry entry has no tracked Markdown document: ${rel}`,
      });
    }
  }
  for (const id of Object.keys(
    contract.adrEvidence?.legacyEvidenceExemptions || {},
  )) {
    if (!adrIds.has(id)) {
      findings.push({
        code: 'adr-evidence-exemption-orphan',
        file: DEFAULT_CONTRACT,
        line: 1,
        message: `legacy evidence exemption has no ADR record: ${id}`,
      });
    }
  }

  for (const [id, record] of adrRecords) {
    const terminal = ['superseded', 'rejected', 'withdrawn'].includes(
      record.decision,
    );
    if (terminal && record.implementation !== 'not-applicable') {
      findings.push({
        code: 'adr-terminal-implementation',
        file: record.rel,
        line: record.line,
        message: `${record.decision} decisions require implementation_status not-applicable`,
      });
    }
    if (record.decision === 'superseded' && record.supersededBy.length === 0) {
      findings.push({
        code: 'adr-supersession-missing',
        file: record.rel,
        line: record.line,
        message: `${id} is superseded but does not declare superseded_by`,
      });
    }
    if (record.decision !== 'superseded' && record.supersededBy.length > 0) {
      findings.push({
        code: 'adr-supersession-state',
        file: record.rel,
        line: record.supersededByLine,
        message: `${id} declares superseded_by but decision_status is ${record.decision}`,
      });
    }
    for (const targetId of record.supersedes) {
      const target = adrRecords.get(targetId);
      if (targetId === id || !target) {
        findings.push({
          code: 'adr-supersession-target',
          file: record.rel,
          line: record.supersedesLine,
          message: `${id} supersedes invalid target ${targetId}`,
        });
      } else if (
        target.decision !== 'superseded' ||
        !target.supersededBy.includes(id)
      ) {
        findings.push({
          code: 'adr-supersession-reciprocal',
          file: record.rel,
          line: record.supersedesLine,
          message: `${id} -> ${targetId} must be reciprocal and target a superseded decision`,
        });
      }
    }
    for (const successorId of record.supersededBy) {
      const successor = adrRecords.get(successorId);
      if (
        successorId === id ||
        !successor ||
        !successor.supersedes.includes(id)
      ) {
        findings.push({
          code: 'adr-supersession-reciprocal',
          file: record.rel,
          line: record.supersededByLine,
          message: `${id} <- ${successorId} must be reciprocal`,
        });
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const cyclic = (adrRecords.get(id)?.supersedes || []).some((target) =>
      visit(target),
    );
    visiting.delete(id);
    visited.add(id);
    return cyclic;
  };
  for (const [id, record] of adrRecords) {
    if (visit(id)) {
      findings.push({
        code: 'adr-supersession-cycle',
        file: record.rel,
        line: record.line,
        message: `ADR supersession graph contains a cycle reachable from ${id}`,
      });
      break;
    }
  }

  for (const registry of contract.adrRegistries) {
    const indexText = documents.get(registry.index);
    if (!indexText) continue;
    const statuses = indexStatuses(indexText);
    const recordPattern = new RegExp(registry.recordPattern);
    for (const rel of options.files) {
      const record = recordPattern.exec(rel);
      if (!record) continue;
      const frontmatter = parseFrontmatter(documents.get(rel) || '');
      const decision = frontmatter?.fields.get('decision_status')?.value;
      const indexed = statuses.get(record[1]);
      if (!indexed) {
        findings.push({
          code: 'adr-index-missing',
          file: registry.index,
          line: 1,
          message: `ADR index is missing ${record[1]}`,
        });
      } else if (indexed.status !== decision) {
        findings.push({
          code: 'adr-index-drift',
          file: registry.index,
          line: 1,
          message: `${record[1]} index status ${indexed.status} differs from decision_status ${String(decision)}`,
        });
      } else if (indexed.rawStatus !== indexed.status) {
        findings.push({
          code: 'adr-index-compound-status',
          file: registry.index,
          line: 1,
          message: `${record[1]} index status must contain decision state only; implementation belongs in metadata`,
        });
      }
    }
  }

  return findings.sort(
    (left, right) =>
      left.file.localeCompare(right.file) || left.line - right.line,
  );
}
