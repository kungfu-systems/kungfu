#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyAdrIdentity, inspectAdrRecordPath } from './adr-identity.mjs';
import {
  parseFrontmatter,
  readMetadataContract,
  validateDocumentMetadata,
} from './document-metadata-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_CONTRACT = 'docs/adr-release.contract.json';
const IDENTITY_HISTORY_PREFIXES = [
  '.kungfu/episodes/sealed/',
  '.xinfa/baselines/',
  'docs/qualification/evidence/',
];
const SEQUENTIAL_ADR_TOKEN = new RegExp(
  '(?<![A-Z0-9-])(?:SHIFU-)?ADR-[0-9]{4}(?![0-9a-f-])',
  'g',
);

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
    { cwd: root, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `git ls-files failed: ${String(result.stderr || '').trim()}`,
    );
  }
  return String(result.stdout || '')
    .split('\0')
    .filter(Boolean)
    .filter((rel) => !rel.split('/').includes('node_modules'))
    .filter((rel) => fs.existsSync(path.join(root, rel)))
    .sort();
}

/** @param {string} root */
export function legacyAdrIdentityFindings(root) {
  const result = childProcess.spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'buffer' },
  );
  if (result.status !== 0) {
    throw new Error(
      `git ls-files failed: ${String(result.stderr || '').trim()}`,
    );
  }
  const findings = [];
  for (const rel of Buffer.from(result.stdout || '')
    .toString()
    .split('\0')
    .filter(Boolean)
    .sort()) {
    if (
      IDENTITY_HISTORY_PREFIXES.some((prefix) => rel.startsWith(prefix)) ||
      rel.split('/').includes('node_modules')
    ) {
      continue;
    }
    const absolute = path.join(root, rel);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    const bytes = fs.readFileSync(absolute);
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    for (const match of text.matchAll(SEQUENTIAL_ADR_TOKEN)) {
      findings.push({
        code: 'adr-sequential-identity-token',
        file: rel,
        line: text.slice(0, match.index).split('\n').length,
        message: `current authority contains retired sequential ADR identity ${match[0]}`,
      });
    }
  }
  return findings;
}

/** @param {unknown} value */
function strings(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

/** @param {Map<string, {value: unknown, line: number}>} fields @param {string} name */
function field(fields, name) {
  return fields.get(name)?.value;
}

/** @param {string} root @param {any} releaseContract */
export function readAdrRecords(root, releaseContract) {
  const records = [];
  for (const relRoot of releaseContract.adrRoots || []) {
    const directory = path.join(root, relRoot);
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.posix.join(relRoot, name);
      const inspected = inspectAdrRecordPath(file, relRoot);
      if (inspected.kind === 'invalid') {
        throw new Error(
          `${file}: identity-looking ADR paths must be direct lowercase .md files`,
        );
      }
      if (inspected.kind !== 'record') continue;
      const frontmatter = parseFrontmatter(
        fs.readFileSync(path.join(root, file), 'utf8'),
      );
      if (!frontmatter || frontmatter.malformed) continue;
      const fields = frontmatter.fields;
      const id = String(field(fields, 'adr_id') || '');
      records.push({
        id,
        owner: classifyAdrIdentity(id)?.owner || 'unknown',
        file,
        decisionStatus: String(field(fields, 'decision_status') || ''),
        implementationStatus: String(
          field(fields, 'implementation_status') || '',
        ),
        reviewState: String(field(fields, 'review_state') || ''),
        implementationCommits: strings(field(fields, 'implementation_commits')),
        implementationPrs: strings(field(fields, 'implementation_prs')),
        closureCommit: String(field(fields, 'closure_commit') || ''),
        closurePr: String(field(fields, 'closure_pr') || ''),
        qualificationRefs: strings(field(fields, 'qualification_refs')),
        supersedes: strings(field(fields, 'supersedes')),
        supersededBy: strings(field(fields, 'superseded_by')),
      });
    }
  }
  return records;
}

/** @param {Record<string, number>} counts @param {string} key */
function increment(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

/**
 * @param {{records: any[], releaseContract: any, structuralFindings?: any[], strict?: boolean, release?: string}} options
 */
export function auditAdrRegistry(options) {
  const records = [...options.records].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const structuralFindings = options.structuralFindings || [];
  const decisionStatuses = {};
  const implementationStatuses = {};
  const owners = {};
  const debt = [];
  const admitted = [];
  const blocked = [];
  const acceptedStatuses = new Set(
    options.releaseContract.stable.requiredDecisionStatuses || [],
  );
  const admittedStatuses = new Set(
    options.releaseContract.stable.admittedImplementationStatuses || [],
  );
  const exemptions = new Set(
    Object.keys(
      options.metadataContract?.adrEvidence?.legacyEvidenceExemptions || {},
    ),
  );

  for (const record of records) {
    increment(decisionStatuses, record.decisionStatus || 'missing');
    increment(implementationStatuses, record.implementationStatus || 'missing');
    increment(owners, record.owner || 'unknown');

    if (['legacy-unreviewed', 'unreviewed'].includes(record.reviewState)) {
      debt.push({
        adr: record.id,
        kind: 'review-debt',
        value: record.reviewState,
      });
    }
    if (
      record.decisionStatus === 'accepted' &&
      ['unknown', 'not-started'].includes(record.implementationStatus)
    ) {
      debt.push({
        adr: record.id,
        kind: 'implementation-debt',
        value: record.implementationStatus,
      });
    }
    if (
      record.decisionStatus === 'accepted' &&
      record.implementationStatus === 'implemented' &&
      record.qualificationRefs.length === 0
    ) {
      debt.push({ adr: record.id, kind: 'qualification-missing' });
    }
    if (exemptions.has(record.id)) {
      debt.push({ adr: record.id, kind: 'legacy-evidence-exemption' });
    }

    if (!acceptedStatuses.has(record.decisionStatus)) continue;
    const conditions = [];
    if (!admittedStatuses.has(record.implementationStatus)) {
      conditions.push(`implementation_status:${record.implementationStatus}`);
    } else if (
      record.implementationStatus === 'implemented' &&
      options.releaseContract.stable.requireQualificationForImplemented &&
      record.qualificationRefs.length === 0
    ) {
      conditions.push('qualification:missing');
    }
    if (conditions.length === 0) {
      admitted.push({ adr: record.id, status: record.implementationStatus });
    } else {
      blocked.push({ adr: record.id, conditions });
    }
  }

  const releaseBlocked = options.release === 'stable' && blocked.length > 0;
  const strictBlocked = Boolean(options.strict) && debt.length > 0;
  const debtKinds = {};
  for (const item of debt) increment(debtKinds, item.kind);
  return {
    schema: 'kungfu.adr-audit/v1',
    generatedFrom: 'repository-state',
    release: options.release || null,
    strict: Boolean(options.strict),
    ok: structuralFindings.length === 0 && !releaseBlocked && !strictBlocked,
    summary: {
      records: records.length,
      owners,
      decisionStatuses,
      implementationStatuses,
      structuralFindings: structuralFindings.length,
      debt: debt.length,
      debtKinds,
      stableAdmitted: admitted.length,
      stableBlocked: blocked.length,
    },
    stable: { admitted, blocked },
    debt,
    findings: structuralFindings,
    records,
  };
}

function parseArgs(argv) {
  const args = { json: false, strict: false, release: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--json') args.json = true;
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--release') args.release = argv[++index];
    else if (arg === '--report') args.report = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.release && args.release !== 'stable') {
    throw new Error('--release currently supports only stable');
  }
  return args;
}

/** @param {any} report */
function humanReport(report) {
  const lines = [
    '[adr-audit] canonical authority: docs/adr',
    `[adr-audit] records=${report.summary.records} kungfu=${report.summary.owners.kungfu || 0} shifu=${report.summary.owners.shifu || 0}`,
    `[adr-audit] structural=${report.summary.structuralFindings} debt=${report.summary.debt} stable-admitted=${report.summary.stableAdmitted} stable-blocked=${report.summary.stableBlocked}`,
  ];
  if (report.release === 'stable') {
    for (const item of report.stable.blocked) {
      lines.push(
        `[adr-audit] stable blocker ${item.adr}: ${item.conditions.join(', ')}`,
      );
    }
  }
  for (const finding of report.findings) {
    lines.push(
      `[adr-audit] ${finding.file}:${finding.line} ${finding.code}: ${finding.message}`,
    );
  }
  lines.push(`[adr-audit] result=${report.ok ? 'pass' : 'fail'}`);
  return `${lines.join('\n')}\n`;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const releaseContract = JSON.parse(
      fs.readFileSync(path.join(ROOT, RELEASE_CONTRACT), 'utf8'),
    );
    const metadataContract = readMetadataContract(ROOT);
    const files = markdownFiles(ROOT);
    const adrPaths = new Set(
      files.filter((file) => file.startsWith('docs/adr/')),
    );
    const structuralFindings = validateDocumentMetadata({
      root: ROOT,
      files,
      contract: metadataContract,
    }).filter(
      (finding) =>
        adrPaths.has(finding.file) || finding.code.startsWith('adr-'),
    );
    structuralFindings.push(...legacyAdrIdentityFindings(ROOT));
    const report = auditAdrRegistry({
      records: readAdrRecords(ROOT, releaseContract),
      releaseContract,
      metadataContract,
      structuralFindings,
      strict: args.strict,
      release: args.release,
    });
    if (args.report) {
      const destination = path.resolve(ROOT, args.report);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
    }
    process.stdout.write(
      args.json ? `${JSON.stringify(report, null, 2)}\n` : humanReport(report),
    );
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(
      `[adr-audit] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
