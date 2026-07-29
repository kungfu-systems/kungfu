#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const DEFAULT_CONTRACT =
  'framework/deprecation/deprecation-lifecycle.contract.json';
const DEFAULT_REGISTRY = 'framework/deprecation/deprecation-registry.json';
const SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const SHA256_ROOT = /^sha256:[0-9a-f]{64}$/u;

/** @param {string} file */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** @param {unknown} value */
function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : [];
}

/** @param {unknown} value */
function objects(value) {
  return Array.isArray(value) &&
    value.every(
      (item) => item && typeof item === 'object' && !Array.isArray(item),
    )
    ? value
    : [];
}

/** @param {unknown} value */
function hashJson(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')}`;
}

/** @param {string} value */
export function parseSemver(value) {
  const match = SEMVER.exec(value);
  if (!match) return null;
  return {
    raw: value,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/** @param {ReturnType<typeof parseSemver>} left @param {ReturnType<typeof parseSemver>} right */
function compareParsed(left, right) {
  if (!left || !right)
    throw new Error('cannot compare invalid semantic versions');
  for (const key of ['major', 'minor', 'patch']) {
    const delta = Number(left[key]) - Number(right[key]);
    if (delta !== 0) return Math.sign(delta);
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === b) continue;
    const aNumber = /^[0-9]+$/u.test(a);
    const bNumber = /^[0-9]+$/u.test(b);
    if (aNumber && bNumber) return Number(a) < Number(b) ? -1 : 1;
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

/** @param {string} left @param {string} right */
export function compareSemver(left, right) {
  return compareParsed(parseSemver(left), parseSemver(right));
}

/** @param {string} date @param {number} days */
function addDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** @param {string} anchor @param {string} boundary */
function versionFloor(anchor, boundary) {
  const parsed = parseSemver(anchor);
  if (!parsed) return null;
  if (
    boundary === 'next-major' ||
    boundary === 'next-major-and-support-policy'
  ) {
    return `${parsed.major + 1}.0.0`;
  }
  if (parsed.prerelease.length > 0) {
    const next = [...parsed.prerelease];
    const tail = next.at(-1);
    if (tail && /^[0-9]+$/u.test(tail)) {
      next[next.length - 1] = String(Number(tail) + 1);
    } else {
      next.push('1');
    }
    return `${parsed.major}.${parsed.minor}.${parsed.patch}-${next.join('.')}`;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

/** @param {string} candidate @param {string} anchor @param {string} boundary @param {any} entry */
function boundaryAllows(candidate, anchor, boundary, entry) {
  const selected = parseSemver(candidate);
  const deprecated = parseSemver(anchor);
  if (!selected || !deprecated || compareParsed(selected, deprecated) <= 0)
    return false;
  if (boundary === 'any-qualified-release') return true;
  if (boundary === 'pre-stable-or-major') {
    return deprecated.prerelease.length > 0
      ? selected.major >= deprecated.major
      : selected.major > deprecated.major;
  }
  if (boundary === 'next-major') {
    return (
      selected.prerelease.length === 0 && selected.major > deprecated.major
    );
  }
  if (boundary === 'next-major-and-support-policy') {
    return (
      selected.prerelease.length === 0 &&
      selected.major > deprecated.major &&
      Boolean(entry.supportPolicy?.historicalReaderOrMigrationQualified)
    );
  }
  return false;
}

/** @param {string} root */
function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return [root];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

/** @param {unknown} document @param {string} pointer */
function jsonPointer(document, pointer) {
  if (pointer === '') return document;
  if (!pointer.startsWith('/')) return undefined;
  let current = document;
  for (const token of pointer
    .slice(1)
    .split('/')
    .map((item) => item.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[token];
  }
  return current;
}

/**
 * @param {string} root
 * @param {any} audit
 * @returns {{ok: boolean, findings: string[]}}
 */
export function evaluateZeroReferenceAudit(root, audit) {
  const findings = [];
  for (const check of objects(audit?.checks)) {
    if (check.kind === 'json-array-empty') {
      const file = path.join(root, String(check.path || ''));
      if (!fs.existsSync(file)) {
        findings.push(`zero-reference JSON is missing: ${check.path}`);
        continue;
      }
      const value = jsonPointer(readJson(file), String(check.pointer || ''));
      if (!Array.isArray(value) || value.length !== 0) {
        findings.push(
          `${check.path}${check.pointer || ''} must be an empty array`,
        );
      }
      continue;
    }
    if (check.kind === 'text-absent') {
      const files = strings(check.roots).flatMap((item) =>
        walkFiles(path.join(root, item)),
      );
      if (files.length === 0) {
        findings.push('zero-reference text audit matched no files');
        continue;
      }
      for (const pattern of strings(check.patterns)) {
        const matches = files
          .filter((file) => !fs.readFileSync(file).includes(0))
          .filter((file) => fs.readFileSync(file, 'utf8').includes(pattern))
          .map((file) => path.relative(root, file).split(path.sep).join('/'));
        if (matches.length > 0) {
          findings.push(
            `current-head reference ${JSON.stringify(pattern)} remains in ${matches.join(', ')}`,
          );
        }
      }
      continue;
    }
    findings.push(`unsupported zero-reference check: ${String(check.kind)}`);
  }
  if (objects(audit?.checks).length === 0) {
    findings.push('zero-reference audit must declare at least one check');
  }
  return { ok: findings.length === 0, findings };
}

/** @param {string} root @param {string} value @param {string[]} findings @param {string} label */
function requireFile(root, value, findings, label) {
  if (!value || !fs.existsSync(path.join(root, value))) {
    findings.push(`${label} is missing: ${value || '<empty>'}`);
  }
}

/** @param {string} value @param {string[]} findings @param {string} label */
function requireDate(value, findings, label) {
  if (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    findings.push(`${label} must be a real YYYY-MM-DD date`);
  }
}

/**
 * @param {{root?: string, contract: any, registry: any}} options
 */
export function validateDeprecationAuthority(options) {
  const root = path.resolve(options.root || ROOT);
  const { contract, registry } = options;
  const findings = [];
  if (contract.schema !== 'kungfu.deprecation-lifecycle.contract/v1') {
    findings.push('unsupported deprecation lifecycle contract schema');
  }
  if (registry.schema !== contract.registrySchema) {
    findings.push('registry schema does not match the lifecycle contract');
  }
  if (registry.contract !== DEFAULT_CONTRACT) {
    findings.push(`registry must bind ${DEFAULT_CONTRACT}`);
  }
  if (!parseSemver(String(registry.productVersion || ''))) {
    findings.push('registry productVersion must be semantic version');
  }
  if (!Array.isArray(registry.releaseHistory)) {
    findings.push('releaseHistory must be an explicit array');
  }
  const releaseVersions = new Set();
  for (const release of objects(registry.releaseHistory)) {
    if (!parseSemver(String(release.version || '')))
      findings.push('release history contains an invalid semantic version');
    requireDate(String(release.date || ''), findings, 'release history date');
    if (!['alpha', 'stable'].includes(release.channel))
      findings.push(`${release.version}: release history channel is invalid`);
    if (typeof release.qualified !== 'boolean')
      findings.push(`${release.version}: qualified must be boolean`);
    if (releaseVersions.has(release.version))
      findings.push(`duplicate release history version: ${release.version}`);
    releaseVersions.add(release.version);
  }

  const ids = new Set();
  for (const entry of objects(registry.entries)) {
    const prefix = entry.id || '<missing-entry-id>';
    const entryFindings = [];
    for (const field of strings(contract.requiredEntryFields)) {
      if (
        entry[field] === undefined ||
        entry[field] === null ||
        entry[field] === ''
      ) {
        entryFindings.push(`required field ${field} is missing`);
      }
    }
    if (ids.has(entry.id)) entryFindings.push('entry id is duplicated');
    ids.add(entry.id);
    if (!strings(contract.lifecycle?.authored).includes(entry.lifecycle)) {
      entryFindings.push(`unsupported authored lifecycle ${entry.lifecycle}`);
    }
    const surfacePolicy = contract.surfaceClasses?.[entry.surfaceClass];
    if (!surfacePolicy)
      entryFindings.push(`unknown surface class ${entry.surfaceClass}`);
    if (!entry.surface?.path || !entry.surface?.kind)
      entryFindings.push('surface requires kind and path');
    else requireFile(root, entry.surface.path, entryFindings, 'surface path');
    requireFile(
      root,
      String(entry.migrationGuidance || ''),
      entryFindings,
      'migration guidance',
    );
    requireDate(
      String(entry.deprecatedAt?.date || ''),
      entryFindings,
      'deprecatedAt.date',
    );
    if (!parseSemver(String(entry.deprecatedAt?.productVersion || ''))) {
      entryFindings.push(
        'deprecatedAt.productVersion must be semantic version',
      );
    }
    requireFile(
      root,
      String(entry.deprecatedAt?.decision || ''),
      entryFindings,
      'deprecation decision',
    );
    if (objects(entry.knownConsumers).length === 0) {
      entryFindings.push('knownConsumers must not be empty');
    }
    for (const consumer of objects(entry.knownConsumers)) {
      if (
        !consumer.id ||
        !['known', 'migrated', 'retired'].includes(consumer.status)
      )
        entryFindings.push(
          'consumer requires id and known/migrated/retired status',
        );
      requireFile(
        root,
        String(consumer.evidence || ''),
        entryFindings,
        `consumer ${consumer.id || '<missing>'} evidence`,
      );
    }
    for (const [field, fallback] of [
      ['minimumCalendarDays', surfacePolicy?.defaultMinimumCalendarDays],
      [
        'minimumQualifiedReleases',
        surfacePolicy?.defaultMinimumQualifiedReleases,
      ],
    ]) {
      const value = entry.windows?.[field];
      if (!Number.isInteger(value) || value < 0)
        entryFindings.push(`windows.${field} must be a non-negative integer`);
      if (fallback === undefined)
        entryFindings.push(`${entry.surfaceClass} lacks a default ${field}`);
    }
    if (
      surfacePolicy &&
      entry.earliestRemovalBoundary !== surfacePolicy.eligibleBoundary
    ) {
      entryFindings.push(
        `earliestRemovalBoundary must be ${surfacePolicy.eligibleBoundary}`,
      );
    }
    if (strings(entry.removalConditions).length === 0)
      entryFindings.push('removalConditions must not be empty');
    for (const evidence of strings(entry.retainedEvidence)) {
      requireFile(root, evidence, entryFindings, 'retained evidence');
    }
    if (strings(entry.retainedEvidence).length === 0)
      entryFindings.push('retainedEvidence must not be empty');
    if (!objects(entry.zeroReferenceAudit?.checks).length)
      entryFindings.push('zeroReferenceAudit must declare checks');

    if (
      entry.surfaceClass === 'persisted-schema-wire-protocol' &&
      !entry.supportPolicy?.historicalReaderOrMigrationQualified
    ) {
      entryFindings.push(
        'persisted schema or protocol needs qualified historical reader, export, or migration evidence',
      );
    }

    if (entry.lifecycle === 'active') {
      const restoration = entry.restorationEvidence;
      if (!restoration) {
        entryFindings.push(
          'restored active entry needs explicit restorationEvidence',
        );
      } else {
        requireDate(
          String(restoration.restoredAt?.date || ''),
          entryFindings,
          'restorationEvidence.restoredAt.date',
        );
        if (
          !parseSemver(String(restoration.restoredAt?.productVersion || ''))
        ) {
          entryFindings.push(
            'restorationEvidence.restoredAt.productVersion must be semantic version',
          );
        }
        requireFile(
          root,
          String(restoration.decision || ''),
          entryFindings,
          'restoration decision',
        );
        for (const file of strings(restoration.qualification)) {
          requireFile(root, file, entryFindings, 'restoration qualification');
        }
        if (strings(restoration.qualification).length === 0) {
          entryFindings.push('restoration qualification must not be empty');
        }
      }
    }

    if (entry.extensionWarrant) {
      const warrant = entry.extensionWarrant;
      for (const field of strings(
        contract.warrantPolicy?.requiredProjectionFields,
      )) {
        if (!warrant[field])
          entryFindings.push(`extension Warrant lacks ${field}`);
      }
      for (const field of strings(
        contract.warrantPolicy?.forbiddenProjectionFields,
      )) {
        if (warrant[field] !== undefined && warrant[field] !== null)
          entryFindings.push(`extension Warrant forbids ${field}`);
      }
      if (warrant.authority !== contract.warrantPolicy.authority)
        entryFindings.push('extension Warrant authority is not kungfu.warrant');
      if (!SHA256_ROOT.test(String(warrant.warrantRoot || '')))
        entryFindings.push('extension Warrant needs an exact sha256 root');
      if (warrant.entryId !== entry.id)
        entryFindings.push('extension Warrant entryId is not exact');
      requireDate(
        String(warrant.issuedAt || ''),
        entryFindings,
        'extension Warrant issuedAt',
      );
      requireDate(
        String(warrant.expiresOn || ''),
        entryFindings,
        'extension Warrant expiresOn',
      );
      if (!parseSemver(String(warrant.expiresAfterRelease || '')))
        entryFindings.push(
          'extension Warrant expiresAfterRelease must be semantic version',
        );
      requireFile(
        root,
        String(warrant.evidenceRef || ''),
        entryFindings,
        'extension Warrant evidence',
      );
      if (
        DATE.test(String(warrant.issuedAt || '')) &&
        DATE.test(String(warrant.expiresOn || ''))
      ) {
        const maximum = addDays(
          warrant.issuedAt,
          contract.warrantPolicy.maximumCalendarExtensionDays,
        );
        if (warrant.expiresOn > maximum)
          entryFindings.push(
            'extension Warrant exceeds maximum calendar bound',
          );
      }
    }

    if (['removed', 'settled'].includes(entry.lifecycle)) {
      const evidence = entry.removalEvidence;
      if (!evidence) {
        entryFindings.push('removed or settled entry needs removalEvidence');
      } else {
        requireDate(
          String(evidence.removedAt?.date || ''),
          entryFindings,
          'removalEvidence.removedAt.date',
        );
        if (!parseSemver(String(evidence.removedAt?.productVersion || '')))
          entryFindings.push(
            'removalEvidence.removedAt.productVersion must be semantic version',
          );
        if (!/^[0-9a-f]{40}$/u.test(String(evidence.gitCommit || '')))
          entryFindings.push('removalEvidence.gitCommit must be exact');
        for (const file of strings(evidence.migrationQualification))
          requireFile(root, file, entryFindings, 'migration qualification');
        if (strings(evidence.migrationQualification).length === 0)
          entryFindings.push('migration qualification must not be empty');
        requireFile(
          root,
          String(evidence.releaseNote || ''),
          entryFindings,
          'release note',
        );
        for (const file of strings(evidence.retainedEvidence))
          requireFile(
            root,
            file,
            entryFindings,
            'settlement retained evidence',
          );
        if (strings(evidence.retainedEvidence).length === 0)
          entryFindings.push('settlement retained evidence must not be empty');
        const zero = evaluateZeroReferenceAudit(root, entry.zeroReferenceAudit);
        entryFindings.push(...zero.findings);
      }
    }
    findings.push(
      ...entryFindings.map((message) => ({
        code: 'deprecation-authority',
        entry: prefix,
        message: `${prefix}: ${message}`,
      })),
    );
  }
  if (objects(registry.entries).length === 0) {
    findings.push({
      code: 'deprecation-authority',
      entry: null,
      message: 'deprecation registry must not be empty',
    });
  }
  const normalizedFindings = findings.map((finding) =>
    typeof finding === 'string'
      ? {
          code: 'deprecation-authority',
          entry: null,
          message: finding,
        }
      : finding,
  );
  return {
    ok: normalizedFindings.length === 0,
    findings: normalizedFindings,
    roots: {
      contract: hashJson(contract),
      registry: hashJson(registry),
    },
  };
}

/** @param {any} warrant @param {string} release @param {string} releaseDate */
function warrantCovers(warrant, release, releaseDate) {
  return (
    warrant &&
    warrant.authority === 'kungfu.warrant' &&
    SHA256_ROOT.test(String(warrant.warrantRoot || '')) &&
    releaseDate <= warrant.expiresOn &&
    compareSemver(release, warrant.expiresAfterRelease) <= 0
  );
}

/**
 * @param {any} entry
 * @param {any} contract
 * @param {any[]} releaseHistory
 * @param {{release?: string, releaseDate: string, channel: string}} context
 */
export function evaluateDeprecationEntry(
  entry,
  contract,
  releaseHistory,
  context,
) {
  const surfacePolicy = contract.surfaceClasses[entry.surfaceClass];
  const notBefore = addDays(
    entry.deprecatedAt.date,
    entry.windows.minimumCalendarDays,
  );
  const floor = versionFloor(
    entry.deprecatedAt.productVersion,
    entry.earliestRemovalBoundary,
  );
  const candidate =
    context.release && context.channel !== 'audit'
      ? {
          version: context.release,
          date: context.releaseDate,
          channel: context.channel,
          qualified: true,
          candidate: true,
        }
      : null;
  const releases = [...releaseHistory, ...(candidate ? [candidate] : [])]
    .filter(
      (release) =>
        release.qualified === true &&
        compareSemver(release.version, entry.deprecatedAt.productVersion) > 0,
    )
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date) ||
        compareSemver(left.version, right.version),
    );
  let qualifyingCount = 0;
  let firstEligibleRelease = null;
  for (const release of releases) {
    qualifyingCount += 1;
    if (
      firstEligibleRelease === null &&
      release.date >= notBefore &&
      qualifyingCount >= entry.windows.minimumQualifiedReleases &&
      boundaryAllows(
        release.version,
        entry.deprecatedAt.productVersion,
        entry.earliestRemovalBoundary,
        entry,
      )
    ) {
      firstEligibleRelease = {
        version: release.version,
        date: release.date,
        channel: release.channel,
      };
    }
  }
  const base = {
    id: entry.id,
    lifecycle: entry.lifecycle,
    surfaceClass: entry.surfaceClass,
    owner: entry.owner,
    replacement: entry.replacement,
    knownConsumers: entry.knownConsumers,
    eligibleRelease: firstEligibleRelease,
    nextEligibleRelease: {
      versionFloor: floor,
      notBefore,
      minimumQualifiedReleases: entry.windows.minimumQualifiedReleases,
      boundary: entry.earliestRemovalBoundary,
      supportPolicy:
        entry.surfaceClass === 'persisted-schema-wire-protocol'
          ? 'qualified historical reader, export, or migration required'
          : null,
    },
    warrant: entry.extensionWarrant
      ? {
          root: entry.extensionWarrant.warrantRoot,
          expiresOn: entry.extensionWarrant.expiresOn,
          expiresAfterRelease: entry.extensionWarrant.expiresAfterRelease,
        }
      : null,
    blocker: null,
    nextAction: null,
  };
  if (entry.lifecycle === 'active') {
    return {
      ...base,
      disposition: 'not-due',
      nextAction:
        'Keep the restored surface supported and retain restoration evidence.',
    };
  }
  if (['removed', 'settled'].includes(entry.lifecycle)) {
    return {
      ...base,
      disposition: 'removed',
      nextAction:
        entry.lifecycle === 'settled'
          ? 'Preserve historical evidence; no executable debt remains.'
          : 'Complete retained-evidence settlement without restoring executable debt.',
    };
  }
  if (!firstEligibleRelease) {
    return {
      ...base,
      disposition: 'not-due',
      nextAction:
        'Migrate known consumers and retain evidence before the next eligible release.',
    };
  }
  const currentRelease = context.release || firstEligibleRelease.version;
  if (
    entry.extensionWarrant &&
    warrantCovers(entry.extensionWarrant, currentRelease, context.releaseDate)
  ) {
    return {
      ...base,
      disposition: 'extended-by-warrant',
      nextAction:
        'Settle removal, restore support, or stop before the exact Warrant expiry; the extension does not renew.',
    };
  }
  return {
    ...base,
    lifecycle: 'removal-due',
    disposition: 'due',
    blocker: entry.extensionWarrant
      ? 'extension-warrant-expired-or-stale'
      : 'qualified-removal-or-exact-warrant-required',
    nextAction:
      'Provide qualified removal and migration evidence, restore supported status, or bind one exact bounded non-renewing Warrant.',
  };
}

/**
 * @param {{root?: string, contract?: any, registry?: any, contractPath?: string, registryPath?: string, release?: string, releaseDate?: string, channel?: string, strictDue?: boolean}} options
 */
export function auditDeprecations(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const contract =
    options.contract ||
    readJson(path.join(root, options.contractPath || DEFAULT_CONTRACT));
  const registry =
    options.registry ||
    readJson(path.join(root, options.registryPath || DEFAULT_REGISTRY));
  const release = String(options.release || '');
  const releaseDate = String(
    options.releaseDate || new Date().toISOString().slice(0, 10),
  );
  const channel = String(options.channel || 'audit');
  const authority = validateDeprecationAuthority({ root, contract, registry });
  const findings = [...authority.findings];
  if (release && !parseSemver(release)) {
    findings.push({
      code: 'deprecation-release',
      entry: null,
      message: `invalid candidate release: ${release}`,
    });
  }
  const dateFindings = [];
  requireDate(releaseDate, dateFindings, 'release date');
  findings.push(
    ...dateFindings.map((message) => ({
      code: 'deprecation-release',
      entry: null,
      message,
    })),
  );
  if (!['audit', 'alpha', 'stable'].includes(channel)) {
    findings.push({
      code: 'deprecation-release',
      entry: null,
      message: `unsupported release channel: ${channel}`,
    });
  }

  const entries =
    findings.length === 0
      ? registry.entries.map((entry) =>
          evaluateDeprecationEntry(entry, contract, registry.releaseHistory, {
            release: release || undefined,
            releaseDate,
            channel,
          }),
        )
      : objects(registry.entries).map((entry) => ({
          id: entry.id || '<missing-entry-id>',
          lifecycle: entry.lifecycle || null,
          surfaceClass: entry.surfaceClass || null,
          owner: entry.owner || null,
          replacement: entry.replacement || null,
          knownConsumers: objects(entry.knownConsumers),
          eligibleRelease: null,
          nextEligibleRelease: null,
          warrant: null,
          disposition: 'invalid',
          blocker: 'deprecation-authority-invalid',
          nextAction:
            'Repair the common lifecycle authority before making a release or removal decision.',
        }));
  const due = entries.filter(
    (entry) =>
      entry.disposition === 'due' &&
      contract.surfaceClasses[entry.surfaceClass].gateChannels.includes(
        channel,
      ),
  );
  if (options.strictDue) {
    for (const entry of due) {
      findings.push({
        code: 'deprecation-overdue',
        entry: entry.id,
        message: `${entry.id}: ${entry.blocker}; ${entry.nextAction}`,
      });
    }
  }
  const counts = Object.fromEntries(
    strings(contract.dueDispositions).map((value) => [
      value,
      entries.filter((entry) => entry.disposition === value).length,
    ]),
  );
  return {
    schema: contract.projectionSchema,
    generatedFrom: 'repository-state',
    readOnly: true,
    release: release || null,
    releaseDate,
    channel,
    strictDue: Boolean(options.strictDue),
    roots: authority.roots,
    ok: findings.length === 0,
    summary: {
      entries: entries.length,
      dispositions: counts,
      gateBlockers: due.length,
      findings: findings.length,
    },
    entries,
    blockers: due,
    findings,
  };
}

function parseArgs(argv) {
  const args = {
    json: false,
    strictDue: false,
    channel: 'audit',
    release: '',
    releaseDate: '',
    contractPath: DEFAULT_CONTRACT,
    registryPath: DEFAULT_REGISTRY,
    report: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--json') args.json = true;
    else if (arg === '--strict-due') args.strictDue = true;
    else if (arg === '--channel') args.channel = argv[++index] || '';
    else if (arg === '--release') args.release = argv[++index] || '';
    else if (arg === '--release-date' || arg === '--as-of')
      args.releaseDate = argv[++index] || '';
    else if (arg === '--contract') args.contractPath = argv[++index] || '';
    else if (arg === '--registry') args.registryPath = argv[++index] || '';
    else if (arg === '--report') args.report = argv[++index] || '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

/** @param {any} report */
function humanReport(report) {
  const lines = [
    '[deprecation-audit] canonical authority: framework/deprecation/deprecation-registry.json',
    `[deprecation-audit] entries=${report.summary.entries} not-due=${report.summary.dispositions['not-due'] || 0} due=${report.summary.dispositions.due || 0} removed=${report.summary.dispositions.removed || 0} extended=${report.summary.dispositions['extended-by-warrant'] || 0}`,
  ];
  for (const entry of report.entries) {
    lines.push(
      `[deprecation-audit] ${entry.id} disposition=${entry.disposition} eligible=${entry.eligibleRelease?.version || entry.nextEligibleRelease.versionFloor || 'support-policy'} next=${entry.nextAction}`,
    );
  }
  for (const finding of report.findings) {
    lines.push(
      `[deprecation-audit] ${finding.code}${finding.entry ? ` ${finding.entry}` : ''}: ${finding.message}`,
    );
  }
  lines.push(`[deprecation-audit] result=${report.ok ? 'pass' : 'fail'}`);
  return `${lines.join('\n')}\n`;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = auditDeprecations({
      root: ROOT,
      contractPath: args.contractPath,
      registryPath: args.registryPath,
      release: args.release,
      releaseDate: args.releaseDate || undefined,
      channel: args.channel,
      strictDue: args.strictDue,
    });
    if (args.report) {
      const output = path.resolve(ROOT, args.report);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    }
    process.stdout.write(
      args.json ? `${JSON.stringify(report, null, 2)}\n` : humanReport(report),
    );
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(
      `[deprecation-audit] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
