#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { evaluateDeprecationEnrollment } from './deprecation-surface-discovery.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const DEFAULT_CONTRACT =
  'developer/deprecation/deprecation-lifecycle.contract.json';
const DEFAULT_REGISTRY = 'developer/deprecation/deprecation-registry.json';
const DEFAULT_DISCOVERY =
  'developer/deprecation/deprecation-discovery.contract.json';
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

/** @param {unknown} value */
function isRealDate(value) {
  return (
    typeof value === 'string' &&
    DATE.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  );
}

/** @param {string} code @param {string} message */
function codedFinding(code, message) {
  return { code, message };
}

/** @param {any} entry */
function historicalGrandfatherSnapshot(entry) {
  return {
    id: entry.id,
    lifecycle: entry.lifecycle,
    surfaceClass: entry.surfaceClass,
    surface: {
      kind: entry.surface?.kind,
      path: entry.surface?.path,
    },
    deprecatedAt: entry.deprecatedAt,
    windows: entry.windows,
    earliestRemovalBoundary: entry.earliestRemovalBoundary,
    removalEvidence: entry.removalEvidence,
  };
}

/**
 * @param {string} root
 * @param {any} contract
 * @param {any} entry
 * @param {Array<string | {code: string, message: string}>} findings
 */
function validateHistoricalGrandfather(root, contract, entry, findings) {
  const policy = contract.historicalGrandfatherPolicy;
  const projection = entry.historicalGrandfather;
  const reservedRecord = policy?.records?.[entry.id];
  if (!projection && !reservedRecord) return false;
  if (!projection) {
    findings.push(
      codedFinding(
        'deprecation-historical-grandfather-invalid',
        'reserved historical exception requires an explicit grandfather projection',
      ),
    );
    return false;
  }
  const record = policy?.records?.[projection.recordId];
  let valid = true;
  const reject = (message) => {
    valid = false;
    findings.push(
      codedFinding('deprecation-historical-grandfather-invalid', message),
    );
  };
  if (projection.authority !== DEFAULT_CONTRACT) {
    reject(`historical grandfather authority must be ${DEFAULT_CONTRACT}`);
  }
  if (projection.recordId !== entry.id) {
    reject('historical grandfather recordId must equal the exact entry id');
  }
  if (!record) {
    reject('historical grandfather record is not reserved by the contract');
    return false;
  }
  if (
    !isDeepStrictEqual(historicalGrandfatherSnapshot(entry), record.exactEntry)
  ) {
    reject('historical grandfather exact entry snapshot does not match');
  }
  if (
    !isDeepStrictEqual(
      strings(projection.evidenceRefs),
      strings(record.evidenceRefs),
    )
  ) {
    reject('historical grandfather evidenceRefs do not match the exact record');
  }
  for (const evidence of strings(projection.evidenceRefs)) {
    requireFile(root, evidence, findings, 'historical grandfather evidence');
  }
  if (strings(projection.evidenceRefs).length === 0) {
    reject('historical grandfather evidenceRefs must not be empty');
  }
  return valid;
}

/** @param {string} surfacePath @param {any} rule */
function coreHeaderRuleMatches(surfacePath, rule) {
  const relative = surfacePath.startsWith('framework/core/')
    ? surfacePath.slice('framework/core/'.length)
    : surfacePath;
  if (strings(rule.exclude_files).includes(relative)) return false;
  if (strings(rule.include_files).includes(relative)) return true;
  return strings(rule.include_prefixes).some((prefix) =>
    relative.startsWith(prefix),
  );
}

/**
 * @param {string} root
 * @param {any} contract
 * @param {any} entry
 * @param {boolean} grandfatherValid
 * @param {Array<string | {code: string, message: string}>} findings
 */
function validateClassification(
  root,
  contract,
  entry,
  grandfatherValid,
  findings,
) {
  const classification = entry.classification;
  const policy = contract.classificationPolicy;
  const reject = (message) =>
    findings.push(
      codedFinding('deprecation-classification-integrity', message),
    );
  if (!classification || typeof classification !== 'object') {
    reject('classification provenance is required');
    return;
  }
  let allowedClasses = [];
  if (classification.authorityType === 'core-public-contract') {
    const authority = policy?.authorities?.corePublicContract;
    if (classification.authority !== authority?.path) {
      reject('core classification authority path is not exact');
      return;
    }
    const authorityPath = path.join(root, String(classification.authority));
    if (!fs.existsSync(authorityPath)) {
      reject(
        `classification authority is missing: ${classification.authority}`,
      );
      return;
    }
    const architecture = readJson(authorityPath);
    const rule = objects(architecture.public_contracts?.header_rules).find(
      (candidate) => candidate.id === classification.ruleId,
    );
    if (!rule) {
      reject(`classification rule is missing: ${classification.ruleId}`);
      return;
    }
    if (!coreHeaderRuleMatches(String(entry.surface?.path || ''), rule)) {
      reject(
        `surface path is outside classification rule ${classification.ruleId}`,
      );
      return;
    }
    allowedClasses = strings(policy?.coreLevelAllowedClasses?.[rule.level]);
    if (allowedClasses.length === 0) {
      reject(`unsupported core public-contract level ${rule.level}`);
      return;
    }
  } else if (classification.authorityType === 'cli-surface-registry') {
    const authority = policy?.authorities?.cliSurfaceRegistry;
    if (
      classification.authority !== authority?.path ||
      classification.ruleId !== authority?.ruleId
    ) {
      reject('CLI classification authority or rule is not exact');
      return;
    }
    const authorityPath = path.join(root, String(classification.authority));
    if (!fs.existsSync(authorityPath)) {
      reject(
        `classification authority is missing: ${classification.authority}`,
      );
      return;
    }
    const cliRegistry = readJson(authorityPath);
    const maturity = jsonPointer(cliRegistry, String(authority.pointer));
    allowedClasses = strings(authority.maturityClasses?.[maturity]);
    if (allowedClasses.length === 0) {
      reject(`unsupported CLI maturity ${String(maturity)}`);
      return;
    }
  } else if (classification.authorityType === 'kind-policy') {
    if (
      classification.authority !== DEFAULT_CONTRACT ||
      classification.ruleId !== entry.surface?.kind
    ) {
      reject('kind-policy classification authority or rule is not exact');
      return;
    }
    allowedClasses = strings(
      policy?.kindAllowedClasses?.[classification.ruleId],
    );
    if (allowedClasses.length === 0) {
      reject(`unsupported governed surface kind ${classification.ruleId}`);
      return;
    }
  } else {
    reject(
      `unsupported classification authority type ${String(classification.authorityType)}`,
    );
    return;
  }
  if (!allowedClasses.includes(entry.surfaceClass) && !grandfatherValid) {
    reject(
      `surface class ${entry.surfaceClass} is weaker or incompatible; authority allows ${allowedClasses.join(', ')}`,
    );
  }
  const markers = objects(entry.surface?.markers);
  if (
    !['removed', 'settled'].includes(entry.lifecycle) &&
    markers.length === 0
  ) {
    reject('live entry requires at least one exact marker dialect');
  }
  for (const marker of markers) {
    const dialectClasses = strings(
      policy?.dialectAllowedClasses?.[marker.dialect],
    );
    if (dialectClasses.length === 0) {
      reject(`unsupported classification marker dialect ${marker.dialect}`);
    } else if (
      !dialectClasses.includes(entry.surfaceClass) &&
      !grandfatherValid
    ) {
      reject(
        `marker dialect ${marker.dialect} is incompatible with ${entry.surfaceClass}; dialect allows ${dialectClasses.join(', ')}`,
      );
    }
  }
}

/** @param {string} root @param {any} contract @param {any} registry @param {string} asOfDate @param {any[]} findings */
function validateAuthorityEnvelope(
  root,
  contract,
  registry,
  asOfDate,
  findings,
) {
  if (contract.schema !== 'kungfu.deprecation-lifecycle.contract/v1') {
    findings.push('unsupported deprecation lifecycle contract schema');
  }
  if (registry.schema !== contract.registrySchema) {
    findings.push('registry schema does not match the lifecycle contract');
  }
  if (registry.contract !== DEFAULT_CONTRACT) {
    findings.push(`registry must bind ${DEFAULT_CONTRACT}`);
  }
  if (
    fs.existsSync(path.join(root, DEFAULT_DISCOVERY)) &&
    (contract.discoveryContract !== DEFAULT_DISCOVERY ||
      registry.discoveryContract !== DEFAULT_DISCOVERY)
  ) {
    findings.push(
      `lifecycle contract and registry must bind ${DEFAULT_DISCOVERY}`,
    );
  }
  if (!parseSemver(String(registry.productVersion || ''))) {
    findings.push('registry productVersion must be semantic version');
  }
  if (!isRealDate(asOfDate)) {
    findings.push('authority as-of date must be a real YYYY-MM-DD date');
  }
  if (!Array.isArray(registry.releaseHistory)) {
    findings.push('releaseHistory must be an explicit array');
  }
}

/** @param {any} registry @param {string} asOfDate @param {any[]} findings */
function validateReleaseHistory(registry, asOfDate, findings) {
  const releaseVersions = new Set();
  for (const release of objects(registry.releaseHistory)) {
    if (!parseSemver(String(release.version || ''))) {
      findings.push('release history contains an invalid semantic version');
    } else if (
      parseSemver(String(registry.productVersion || '')) &&
      compareSemver(release.version, registry.productVersion) > 0
    ) {
      findings.push(
        codedFinding(
          'deprecation-version-after-context',
          `release history version ${release.version} is after registry productVersion ${registry.productVersion}`,
        ),
      );
    }
    requireDate(String(release.date || ''), findings, 'release history date');
    if (
      isRealDate(release.date) &&
      isRealDate(asOfDate) &&
      release.date > asOfDate
    ) {
      findings.push(
        codedFinding(
          'deprecation-date-after-context',
          `release history date ${release.date} is after authority context ${asOfDate}`,
        ),
      );
    }
    if (!['alpha', 'stable'].includes(release.channel)) {
      findings.push(`${release.version}: release history channel is invalid`);
    }
    if (typeof release.qualified !== 'boolean') {
      findings.push(`${release.version}: qualified must be boolean`);
    }
    if (releaseVersions.has(release.version)) {
      findings.push(`duplicate release history version: ${release.version}`);
    }
    releaseVersions.add(release.version);
  }
}

/** @param {any} contract @param {any} entry @param {Set<any>} ids @param {any[]} findings */
function validateEntryIdentity(contract, entry, ids, findings) {
  for (const field of strings(contract.requiredEntryFields)) {
    if (
      entry[field] === undefined ||
      entry[field] === null ||
      entry[field] === ''
    ) {
      findings.push(`required field ${field} is missing`);
    }
  }
  if (ids.has(entry.id)) findings.push('entry id is duplicated');
  ids.add(entry.id);
  if (!strings(contract.lifecycle?.authored).includes(entry.lifecycle)) {
    findings.push(`unsupported authored lifecycle ${entry.lifecycle}`);
  }
  const surfacePolicy = contract.surfaceClasses?.[entry.surfaceClass];
  if (!surfacePolicy) {
    findings.push(`unknown surface class ${entry.surfaceClass}`);
  }
  return surfacePolicy;
}

/** @param {string} root @param {any} entry @param {any[]} findings */
function validateEntrySurface(root, entry, findings) {
  if (!entry.surface?.path || !entry.surface?.kind) {
    findings.push('surface requires kind and path');
  } else {
    requireFile(root, entry.surface.path, findings, 'surface path');
  }
  requireFile(
    root,
    String(entry.migrationGuidance || ''),
    findings,
    'migration guidance',
  );
}

/** @param {string} root @param {any} registry @param {string} asOfDate @param {any} entry @param {any[]} findings */
function validateEntryDeprecationPoint(
  root,
  registry,
  asOfDate,
  entry,
  findings,
) {
  requireDate(
    String(entry.deprecatedAt?.date || ''),
    findings,
    'deprecatedAt.date',
  );
  if (
    isRealDate(entry.deprecatedAt?.date) &&
    isRealDate(asOfDate) &&
    entry.deprecatedAt.date > asOfDate
  ) {
    findings.push(
      codedFinding(
        'deprecation-date-after-context',
        `deprecatedAt.date ${entry.deprecatedAt.date} is after authority context ${asOfDate}`,
      ),
    );
  }
  if (!parseSemver(String(entry.deprecatedAt?.productVersion || ''))) {
    findings.push('deprecatedAt.productVersion must be semantic version');
  } else if (
    parseSemver(String(registry.productVersion || '')) &&
    compareSemver(entry.deprecatedAt.productVersion, registry.productVersion) >
      0
  ) {
    findings.push(
      codedFinding(
        'deprecation-version-after-context',
        `deprecatedAt.productVersion ${entry.deprecatedAt.productVersion} is after registry productVersion ${registry.productVersion}`,
      ),
    );
  }
  requireFile(
    root,
    String(entry.deprecatedAt?.decision || ''),
    findings,
    'deprecation decision',
  );
}

/** @param {string} root @param {any} entry @param {any[]} findings */
function validateKnownConsumers(root, entry, findings) {
  if (objects(entry.knownConsumers).length === 0) {
    findings.push('knownConsumers must not be empty');
  }
  for (const consumer of objects(entry.knownConsumers)) {
    if (
      !consumer.id ||
      !['known', 'migrated', 'retired'].includes(consumer.status)
    ) {
      findings.push('consumer requires id and known/migrated/retired status');
    }
    requireFile(
      root,
      String(consumer.evidence || ''),
      findings,
      `consumer ${consumer.id || '<missing>'} evidence`,
    );
  }
}

/** @param {string} root @param {any} contract @param {any} entry @param {any} surfacePolicy @param {boolean} grandfatherValid @param {any[]} findings */
function validateEntryWindowsAndEvidence(
  root,
  contract,
  entry,
  surfacePolicy,
  grandfatherValid,
  findings,
) {
  for (const [field, fallback] of [
    ['minimumCalendarDays', surfacePolicy?.defaultMinimumCalendarDays],
    [
      'minimumQualifiedReleases',
      surfacePolicy?.defaultMinimumQualifiedReleases,
    ],
  ]) {
    const value = entry.windows?.[field];
    if (!Number.isInteger(value) || value < 0) {
      findings.push(`windows.${field} must be a non-negative integer`);
    }
    if (fallback === undefined) {
      findings.push(`${entry.surfaceClass} lacks a default ${field}`);
    } else if (
      Number.isInteger(value) &&
      value < fallback &&
      !grandfatherValid
    ) {
      findings.push(
        codedFinding(
          'deprecation-window-below-minimum',
          `windows.${field} ${value} is below ${entry.surfaceClass} minimum ${fallback}`,
        ),
      );
    }
  }
  if (
    surfacePolicy &&
    entry.earliestRemovalBoundary !== surfacePolicy.eligibleBoundary
  ) {
    findings.push(
      `earliestRemovalBoundary must be ${surfacePolicy.eligibleBoundary}`,
    );
  }
  if (strings(entry.removalConditions).length === 0) {
    findings.push('removalConditions must not be empty');
  }
  for (const evidence of strings(entry.retainedEvidence)) {
    requireFile(root, evidence, findings, 'retained evidence');
  }
  if (strings(entry.retainedEvidence).length === 0) {
    findings.push('retainedEvidence must not be empty');
  }
  if (!objects(entry.zeroReferenceAudit?.checks).length) {
    findings.push('zeroReferenceAudit must declare checks');
  }
}

/** @param {string} root @param {any} entry @param {any[]} findings */
function validateEntrySupportPolicy(root, entry, findings) {
  if (
    entry.surfaceClass === 'persisted-schema-wire-protocol' &&
    (!entry.supportPolicy?.historicalReaderOrMigrationQualified ||
      !entry.supportPolicy?.authority ||
      strings(entry.supportPolicy?.evidence).length === 0)
  ) {
    findings.push(
      codedFinding(
        'deprecation-support-evidence-invalid',
        'persisted schema or protocol needs exact authority and qualified historical reader, export, or migration evidence',
      ),
    );
  } else if (entry.surfaceClass === 'persisted-schema-wire-protocol') {
    requireFile(
      root,
      String(entry.supportPolicy.authority),
      findings,
      'support policy authority',
    );
    for (const evidence of strings(entry.supportPolicy.evidence)) {
      requireFile(root, evidence, findings, 'support policy evidence');
    }
  }
}

/** @param {string} root @param {any} entry @param {any[]} findings */
function validateEntryRestoration(root, entry, findings) {
  if (entry.lifecycle !== 'active') return;
  const restoration = entry.restorationEvidence;
  if (!restoration) {
    findings.push('restored active entry needs explicit restorationEvidence');
    return;
  }
  requireDate(
    String(restoration.restoredAt?.date || ''),
    findings,
    'restorationEvidence.restoredAt.date',
  );
  if (!parseSemver(String(restoration.restoredAt?.productVersion || ''))) {
    findings.push(
      'restorationEvidence.restoredAt.productVersion must be semantic version',
    );
  }
  requireFile(
    root,
    String(restoration.decision || ''),
    findings,
    'restoration decision',
  );
  for (const file of strings(restoration.qualification)) {
    requireFile(root, file, findings, 'restoration qualification');
  }
  if (strings(restoration.qualification).length === 0) {
    findings.push('restoration qualification must not be empty');
  }
}

/** @param {string} root @param {any} contract @param {any} entry @param {any[]} findings */
function validateEntryWarrant(root, contract, entry, findings) {
  if (!entry.extensionWarrant) return;
  const warrant = entry.extensionWarrant;
  for (const field of strings(
    contract.warrantPolicy?.requiredProjectionFields,
  )) {
    if (!warrant[field]) findings.push(`extension Warrant lacks ${field}`);
  }
  for (const field of strings(
    contract.warrantPolicy?.forbiddenProjectionFields,
  )) {
    if (warrant[field] !== undefined && warrant[field] !== null) {
      findings.push(`extension Warrant forbids ${field}`);
    }
  }
  if (warrant.authority !== contract.warrantPolicy.authority) {
    findings.push('extension Warrant authority is not kungfu.warrant');
  }
  if (!SHA256_ROOT.test(String(warrant.warrantRoot || ''))) {
    findings.push('extension Warrant needs an exact sha256 root');
  }
  if (warrant.entryId !== entry.id) {
    findings.push('extension Warrant entryId is not exact');
  }
  requireDate(
    String(warrant.issuedAt || ''),
    findings,
    'extension Warrant issuedAt',
  );
  requireDate(
    String(warrant.expiresOn || ''),
    findings,
    'extension Warrant expiresOn',
  );
  if (!parseSemver(String(warrant.expiresAfterRelease || ''))) {
    findings.push(
      'extension Warrant expiresAfterRelease must be semantic version',
    );
  }
  requireFile(
    root,
    String(warrant.evidenceRef || ''),
    findings,
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
    if (warrant.expiresOn > maximum) {
      findings.push('extension Warrant exceeds maximum calendar bound');
    }
  }
}

/** @param {any} registry @param {string} asOfDate @param {any} entry @param {any} evidence @param {any[]} findings */
function validateRemovalTemporalContext(
  registry,
  asOfDate,
  entry,
  evidence,
  findings,
) {
  requireDate(
    String(evidence.removedAt?.date || ''),
    findings,
    'removalEvidence.removedAt.date',
  );
  if (
    isRealDate(evidence.removedAt?.date) &&
    isRealDate(asOfDate) &&
    evidence.removedAt.date > asOfDate
  ) {
    findings.push(
      codedFinding(
        'deprecation-date-after-context',
        `removalEvidence.removedAt.date ${evidence.removedAt.date} is after authority context ${asOfDate}`,
      ),
    );
  }
  if (!parseSemver(String(evidence.removedAt?.productVersion || ''))) {
    findings.push(
      'removalEvidence.removedAt.productVersion must be semantic version',
    );
  } else if (
    parseSemver(String(registry.productVersion || '')) &&
    compareSemver(evidence.removedAt.productVersion, registry.productVersion) >
      0
  ) {
    findings.push(
      codedFinding(
        'deprecation-version-after-context',
        `removalEvidence.removedAt.productVersion ${evidence.removedAt.productVersion} is after registry productVersion ${registry.productVersion}`,
      ),
    );
  }
  if (
    isRealDate(evidence.removedAt?.date) &&
    isRealDate(entry.deprecatedAt?.date) &&
    evidence.removedAt.date < entry.deprecatedAt.date
  ) {
    findings.push(
      codedFinding(
        'deprecation-removal-boundary-invalid',
        'removalEvidence.removedAt.date precedes deprecatedAt.date',
      ),
    );
  }
  if (
    parseSemver(String(evidence.removedAt?.productVersion || '')) &&
    parseSemver(String(entry.deprecatedAt?.productVersion || '')) &&
    compareSemver(
      evidence.removedAt.productVersion,
      entry.deprecatedAt.productVersion,
    ) < 0
  ) {
    findings.push(
      codedFinding(
        'deprecation-removal-boundary-invalid',
        'removalEvidence.removedAt.productVersion precedes deprecatedAt.productVersion',
      ),
    );
  }
}

/** @param {string} root @param {any} entry @param {any} evidence @param {any[]} findings */
function validateRemovalArtifacts(root, entry, evidence, findings) {
  if (!/^[0-9a-f]{40}$/u.test(String(evidence.gitCommit || ''))) {
    findings.push('removalEvidence.gitCommit must be exact');
  }
  for (const file of strings(evidence.migrationQualification)) {
    requireFile(root, file, findings, 'migration qualification');
  }
  if (strings(evidence.migrationQualification).length === 0) {
    findings.push('migration qualification must not be empty');
  }
  requireFile(
    root,
    String(evidence.releaseNote || ''),
    findings,
    'release note',
  );
  for (const file of strings(evidence.retainedEvidence)) {
    requireFile(root, file, findings, 'settlement retained evidence');
  }
  if (strings(evidence.retainedEvidence).length === 0) {
    findings.push('settlement retained evidence must not be empty');
  }
  const zero = evaluateZeroReferenceAudit(root, entry.zeroReferenceAudit);
  findings.push(...zero.findings);
}

/** @param {string} root @param {any} registry @param {string} asOfDate @param {any} entry @param {any[]} findings */
function validateEntrySettlement(root, registry, asOfDate, entry, findings) {
  if (!['removed', 'settled'].includes(entry.lifecycle)) return;
  const evidence = entry.removalEvidence;
  if (!evidence) {
    findings.push('removed or settled entry needs removalEvidence');
    return;
  }
  validateRemovalTemporalContext(registry, asOfDate, entry, evidence, findings);
  validateRemovalArtifacts(root, entry, evidence, findings);
}

/** @param {any[]} findings @param {string} prefix @param {any[]} entryFindings */
function appendEntryFindings(findings, prefix, entryFindings) {
  findings.push(
    ...entryFindings.map((finding) => ({
      code:
        typeof finding === 'string' ? 'deprecation-authority' : finding.code,
      entry: prefix,
      message: `${prefix}: ${
        typeof finding === 'string' ? finding : finding.message
      }`,
    })),
  );
}

/**
 * @param {{root?: string, contract: any, registry: any, asOfDate?: string}} options
 */
export function validateDeprecationAuthority(options) {
  const root = path.resolve(options.root || ROOT);
  const { contract, registry } = options;
  const asOfDate = options.asOfDate || new Date().toISOString().slice(0, 10);
  const findings = [];
  validateAuthorityEnvelope(root, contract, registry, asOfDate, findings);
  validateReleaseHistory(registry, asOfDate, findings);

  const ids = new Set();
  for (const entry of objects(registry.entries)) {
    const prefix = entry.id || '<missing-entry-id>';
    const entryFindings = [];
    const surfacePolicy = validateEntryIdentity(
      contract,
      entry,
      ids,
      entryFindings,
    );
    validateEntrySurface(root, entry, entryFindings);
    validateEntryDeprecationPoint(
      root,
      registry,
      asOfDate,
      entry,
      entryFindings,
    );
    validateKnownConsumers(root, entry, entryFindings);
    const grandfatherValid = validateHistoricalGrandfather(
      root,
      contract,
      entry,
      entryFindings,
    );
    validateClassification(
      root,
      contract,
      entry,
      grandfatherValid,
      entryFindings,
    );
    validateEntryWindowsAndEvidence(
      root,
      contract,
      entry,
      surfacePolicy,
      grandfatherValid,
      entryFindings,
    );

    validateEntrySupportPolicy(root, entry, entryFindings);

    validateEntryRestoration(root, entry, entryFindings);

    validateEntryWarrant(root, contract, entry, entryFindings);

    validateEntrySettlement(root, registry, asOfDate, entry, entryFindings);
    appendEntryFindings(findings, prefix, entryFindings);
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
 * @param {{root?: string, contract?: any, registry?: any, discovery?: any, contractPath?: string, registryPath?: string, discoveryPath?: string, changedFiles?: string[], release?: string, releaseDate?: string, channel?: string, strictDue?: boolean}} options
 */
export function auditDeprecations(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const contract =
    options.contract ||
    readJson(path.join(root, options.contractPath || DEFAULT_CONTRACT));
  const registry =
    options.registry ||
    readJson(path.join(root, options.registryPath || DEFAULT_REGISTRY));
  const discoveryPath = path.join(
    root,
    options.discoveryPath || DEFAULT_DISCOVERY,
  );
  const discovery =
    options.discovery ||
    (fs.existsSync(discoveryPath) ? readJson(discoveryPath) : null);
  const release = String(options.release || '');
  const releaseDate = String(
    options.releaseDate || new Date().toISOString().slice(0, 10),
  );
  const channel = String(options.channel || 'audit');
  const authority = validateDeprecationAuthority({
    root,
    contract,
    registry,
    asOfDate: releaseDate,
  });
  const findings = [...authority.findings];
  const enrollment = discovery
    ? evaluateDeprecationEnrollment({
        root,
        contract: discovery,
        registry,
        changedFiles: options.changedFiles,
      })
    : null;
  if (enrollment) findings.push(...enrollment.findings);
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
    inventory: enrollment
      ? {
          ...enrollment.inventory,
          roots: {
            lifecycle: authority.roots.contract,
            ...enrollment.inventory.roots,
          },
        }
      : null,
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
    discoveryPath: DEFAULT_DISCOVERY,
    changedFiles: [],
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
    else if (arg === '--discovery') args.discoveryPath = argv[++index] || '';
    else if (arg === '--changed-file')
      args.changedFiles.push(argv[++index] || '');
    else if (arg === '--report') args.report = argv[++index] || '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

/** @param {any} report */
function humanReport(report) {
  const lines = [
    '[deprecation-audit] canonical authority: developer/deprecation/deprecation-registry.json',
    `[deprecation-audit] entries=${report.summary.entries} not-due=${report.summary.dispositions['not-due'] || 0} due=${report.summary.dispositions.due || 0} removed=${report.summary.dispositions.removed || 0} extended=${report.summary.dispositions['extended-by-warrant'] || 0}`,
    `[deprecation-audit] inventory scope=${report.inventory?.scope || 'unavailable'} live=${report.inventory?.live.length || 0} settled=${report.inventory?.settled.length || 0} generated=${report.inventory?.classifications.generatedCode.length || 0} historical=${report.inventory?.classifications.historicalEvidence.length || 0}`,
  ];
  for (const entry of report.entries) {
    lines.push(
      `[deprecation-audit] ${entry.id} disposition=${entry.disposition} eligible=${entry.eligibleRelease?.version || entry.nextEligibleRelease?.versionFloor || 'support-policy'} next=${entry.nextAction}`,
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
      discoveryPath: args.discoveryPath,
      changedFiles:
        args.changedFiles.length > 0
          ? args.changedFiles.filter(Boolean)
          : undefined,
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
