// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';

import { classifyAdrIdentity, inspectAdrRecordPath } from './adr-identity.mjs';

const POLICY_SCHEMA = 'kungfu.libkungfu-symbol-policy/v2';
const ADMISSION_MODE = 'closed-world';
const ADMISSION_STATES = new Set(['authorized', 'qualified']);

const sortedUnique = (values) => [...new Set(values)].sort();

function requiredString(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert.notEqual(value.trim(), '', `${label} must not be empty`);
  return value;
}

function admissionEntries(policy) {
  assert.equal(policy.$schema, POLICY_SCHEMA);
  assert.equal(policy.bootstrapAdmission?.mode, ADMISSION_MODE);
  assert.equal(policy.bootstrapAdmission?.default, 'deny');
  assert.equal(
    policy.bootstrapAdmission?.capabilityEvolution,
    'new-interface-or-version-behind-an-admitted-bootstrap',
  );
  assert.equal(
    policy.bootstrapAdmission?.authorizationBoundary
      ?.candidateMustPreexistOnTargetBranch,
    true,
  );
  assert.equal(
    policy.bootstrapAdmission?.authorizationBoundary
      ?.implementationMaySelfAuthorize,
    false,
  );
  assert.equal(
    policy.bootstrapAdmission?.authorizationBoundary?.requiredReview,
    'independent-approved-pr',
  );
  assert.ok(Array.isArray(policy.bootstrapAdmission?.entries));
  return policy.bootstrapAdmission.entries;
}

function assertAuthorization(entry) {
  const prefix = `bootstrap admission ${entry.symbol}`;
  requiredString(entry.decision, `${prefix} decision`);
  assert.equal(entry.decisionStatus, 'accepted');
  assert.equal(entry.authorization?.mode, 'independent-pr-review');
  const change = requiredString(
    entry.authorization?.change,
    `${prefix} change`,
  );
  assert.match(
    change,
    /^https:\/\/github\.com\/kungfu-systems\/kungfu\/pull\/\d+$/,
  );
  const approval = requiredString(
    entry.authorization?.approval,
    `${prefix} approval`,
  );
  assert.match(
    approval,
    /^https:\/\/github\.com\/kungfu-systems\/kungfu\/pull\/\d+#pullrequestreview-\d+$/,
  );
  assert.ok(
    approval.startsWith(`${change}#pullrequestreview-`),
    `${prefix} approval must belong to the authorization change`,
  );
  const author = requiredString(
    entry.authorization?.changeAuthor,
    `${prefix} changeAuthor`,
  );
  const reviewer = requiredString(
    entry.authorization?.reviewer,
    `${prefix} reviewer`,
  );
  assert.notEqual(
    reviewer,
    author,
    `${prefix} reviewer must differ from the change author`,
  );
  assert.equal(entry.authorization?.state, 'approved');
}

function assertQualification(entry, releasePassport) {
  const qualification = entry.qualification;
  const requiredPlatforms = releasePassport.platformMatrix.required;
  assert.deepEqual(
    qualification?.requiredPlatforms,
    requiredPlatforms,
    `${entry.symbol} qualification platform set drifted from the Release Passport`,
  );
  if (entry.status === 'authorized') {
    assert.equal(qualification?.status, 'required');
    assert.equal(qualification?.sourceRevision, null);
    assert.equal(qualification?.workflowRun, null);
    return;
  }

  assert.equal(qualification?.status, 'passed');
  assert.equal(
    qualification?.releasePassport,
    'framework/core/architecture/kfd7-release-passport.json',
  );
  assert.equal(
    qualification?.sourceRevision,
    releasePassport.platformMatrix.qualification.sourceRevision,
    `${entry.symbol} qualification source revision drifted from the Release Passport`,
  );
  assert.equal(
    qualification?.workflowRun,
    releasePassport.platformMatrix.qualification.workflowRun,
    `${entry.symbol} qualification workflow run drifted from the Release Passport`,
  );
  assert.equal(
    releasePassport.platformMatrix.qualification.status,
    'passed',
    `${entry.symbol} cannot be qualified before the Release Passport passes`,
  );
  assert.equal(
    releasePassport.platformMatrix.qualification.reports.length,
    requiredPlatforms.length,
    `${entry.symbol} qualification does not cover every required platform`,
  );
}

export function extractKfApiExportSymbols(source) {
  const symbols = [];
  const pattern = /\bKF_API_EXPORT\b[^;{}#]*?\b(kungfu_[a-z0-9_]+)\s*\(/g;
  for (const match of source.matchAll(pattern)) symbols.push(match[1]);
  return sortedUnique(symbols);
}

export function qualifiedBootstrapSymbols(policy, releasePassport) {
  const entries = admissionEntries(policy);
  const seenIds = new Set();
  const seenSymbols = new Set();
  for (const entry of entries) {
    requiredString(entry.id, 'bootstrap admission id');
    requiredString(entry.symbol, `bootstrap admission ${entry.id} symbol`);
    assert.match(entry.symbol, /^kungfu_(?:[a-z0-9_]+_)?get_api$/);
    assert.ok(
      ADMISSION_STATES.has(entry.status),
      `${entry.symbol} has unsupported admission status ${entry.status}`,
    );
    assert.ok(
      !seenIds.has(entry.id),
      `duplicate bootstrap admission id ${entry.id}`,
    );
    assert.ok(
      !seenSymbols.has(entry.symbol),
      `duplicate bootstrap admission symbol ${entry.symbol}`,
    );
    seenIds.add(entry.id);
    seenSymbols.add(entry.symbol);
    assertAuthorization(entry);
    assertQualification(entry, releasePassport);
  }
  return sortedUnique(
    entries
      .filter((entry) => entry.status === 'qualified')
      .map((entry) => entry.symbol),
  );
}

export function assertBootstrapDecisionDocuments(policy, readDecision) {
  assert.equal(typeof readDecision, 'function');
  for (const entry of admissionEntries(policy)) {
    const decision = readDecision(entry.decision);
    assert.equal(
      typeof decision,
      'string',
      `${entry.symbol} decision document is missing`,
    );
    const identity = /^adr_id: (\S+)$/m.exec(decision)?.[1] ?? '';
    assert.ok(
      classifyAdrIdentity(identity),
      `${entry.symbol} decision is not an ADR`,
    );
    assert.equal(
      inspectAdrRecordPath(entry.decision, 'docs/adr').identity,
      identity,
      `${entry.symbol} decision path does not match its ADR identity`,
    );
    assert.match(
      decision,
      /^decision_status: accepted$/m,
      `${entry.symbol} decision is not accepted`,
    );
  }
}

function baseAdmissionEntry(basePolicy, symbol) {
  if (basePolicy?.$schema === POLICY_SCHEMA) {
    return basePolicy.bootstrapAdmission.entries.find(
      (entry) => entry.symbol === symbol,
    );
  }
  if (basePolicy?.definedExports?.includes(symbol)) {
    return { symbol, legacyQualifiedBaseline: true };
  }
  return null;
}

function assertPreauthorizedOnBase(policy, basePolicy, sourceSymbols) {
  const entries = new Map(
    policy.bootstrapAdmission.entries.map((entry) => [entry.symbol, entry]),
  );
  for (const symbol of sourceSymbols) {
    const baseEntry = baseAdmissionEntry(basePolicy, symbol);
    assert.ok(
      baseEntry,
      `${symbol} was not authorized on the target branch before implementation`,
    );
    if (baseEntry.legacyQualifiedBaseline) continue;
    const current = entries.get(symbol);
    assert.deepEqual(
      current.authorization,
      baseEntry.authorization,
      `${symbol} authorization changed in the implementation change`,
    );
    assert.equal(
      current.decision,
      baseEntry.decision,
      `${symbol} decision changed in the implementation change`,
    );
    assert.equal(
      current.decisionStatus,
      baseEntry.decisionStatus,
      `${symbol} decision status changed in the implementation change`,
    );
  }
}

export function assertBootstrapAdmission({
  policy,
  releasePassport,
  boundarySymbols,
  layerSymbols,
  headerSymbols,
  implementationSymbols,
  basePolicy,
}) {
  const qualified = qualifiedBootstrapSymbols(policy, releasePassport);
  const surfaces = {
    'symbol policy': policy.definedExports,
    'boundary contract': boundarySymbols,
    'layer registry': layerSymbols,
    'public header': headerSymbols,
    'export implementation': implementationSymbols,
  };
  for (const [label, symbols] of Object.entries(surfaces)) {
    assert.deepEqual(
      sortedUnique(symbols),
      qualified,
      `${label} drifted from the qualified bootstrap admission set`,
    );
  }
  if (basePolicy) {
    assertPreauthorizedOnBase(policy, basePolicy, qualified);
  }
  return qualified;
}

export function assertInstalledBootstrapExports({
  policy,
  releasePassport,
  actualSymbols,
}) {
  const qualified = qualifiedBootstrapSymbols(policy, releasePassport);
  assert.deepEqual(
    sortedUnique(actualSymbols),
    qualified,
    'installed libkungfu exports drifted from the qualified bootstrap admission set',
  );
  return qualified;
}
