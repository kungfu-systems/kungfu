#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

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
 *   frontmatterRequired: boolean,
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
 *   sourceKinds?: string[],
 *   externalFrontmatterSchemas: {id: string, patterns: string[]}[],
 *   profiles: MetadataProfile[],
 *   adrRegistries: {index: string, recordPattern: string}[]
 * }} MetadataContract
 */

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

/** @param {string} rel @param {{files?: string[], patterns?: string[]}} rule */
function matches(rel, rule) {
  return (
    (rule.files || []).includes(rel) ||
    (rule.patterns || []).some((pattern) => new RegExp(pattern).test(rel))
  );
}

/** @param {string} value */
function canonicalDecisionStatus(value) {
  const match = /^(accepted|proposed|superseded)\b/i.exec(value.trim());
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

  for (const rel of options.files) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    documents.set(rel, text);
    if (
      contract.externalFrontmatterSchemas.some((schema) => matches(rel, schema))
    ) {
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
    if (!frontmatter) {
      if (profile.frontmatterRequired) {
        findings.push({
          code: 'metadata-required',
          file: rel,
          line: 1,
          message: `frontmatter required by ${profile.id} profile`,
        });
      }
      continue;
    }
    if (frontmatter.malformed) {
      findings.push({
        code: 'metadata-malformed',
        file: rel,
        line: 1,
        message: 'frontmatter is missing its closing delimiter',
      });
      continue;
    }
    for (const duplicate of frontmatter.duplicates || []) {
      findings.push({
        code: 'metadata-duplicate',
        file: rel,
        line: duplicate.line,
        message: `duplicate frontmatter field: ${duplicate.key}`,
      });
    }
    for (const key of profile.required) {
      if (!frontmatter.fields.has(key)) {
        findings.push({
          code: 'metadata-required-field',
          file: rel,
          line: 1,
          message: `${profile.id} requires frontmatter field ${key}`,
        });
      }
    }
    for (const key of profile.forbidden || []) {
      const field = frontmatter.fields.get(key);
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
      const field = frontmatter.fields.get(key);
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
      const field = frontmatter.fields.get(key);
      if (field && !allowed.includes(/** @type {string} */ (field.value))) {
        findings.push({
          code: 'metadata-enum',
          file: rel,
          line: field.line,
          message: `${key} must be one of: ${allowed.join(', ')}`,
        });
      }
    }
    const sources = frontmatter.fields.get('sources');
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
      const id = frontmatter.fields.get('adr_id');
      if (id && id.value !== expectedId) {
        findings.push({
          code: 'adr-id-drift',
          file: rel,
          line: id.line,
          message: `adr_id must match filename: ${expectedId}`,
        });
      }
      const visible = visibleDecisionStatus(text);
      const decision = frontmatter.fields.get('decision_status');
      if (!visible) {
        findings.push({
          code: 'adr-status-projection',
          file: rel,
          line: frontmatter.endLine + 1,
          message: 'ADR body must project a visible decision status',
        });
      } else if (decision && visible !== decision.value) {
        findings.push({
          code: 'adr-status-drift',
          file: rel,
          line: frontmatter.endLine + 1,
          message: `visible status ${visible} differs from decision_status ${String(decision.value)}`,
        });
      }
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
