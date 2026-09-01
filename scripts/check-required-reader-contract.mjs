#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONTRACT_PATH =
  'framework/format/kungfu-required-reader.contract.json';

const REQUIRED_PROFILES = [
  'preservation',
  'inspection',
  'structural-verification',
  'semantic-verification',
  'canonical-fold',
  'admission',
  'execution',
];
const AUTHORITY_PROFILES = new Set([
  'semantic-verification',
  'canonical-fold',
  'admission',
  'execution',
]);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Evaluate one bounded reader operation without interpreting unknown bytes.
 *
 * @param {Record<string, unknown>} contract
 * @param {{
 *   profile: string,
 *   materialState?: string,
 *   missingRequiredMaterial?: boolean
 * }} input
 */
export function evaluateRequiredReader(contract, input) {
  const profiles = Array.isArray(contract.readerProfiles)
    ? contract.readerProfiles
    : [];
  const profile = profiles.find(
    (entry) => isObject(entry) && entry.id === input.profile,
  );
  if (!isObject(profile))
    throw new Error(`unknown reader profile: ${input.profile}`);
  const state = input.missingRequiredMaterial
    ? 'missing-required-material'
    : input.materialState || 'known';
  let outcome = 'read';
  let code = null;
  if (state === 'malformed-framing') {
    outcome = 'reject';
    code = 'E_READER_MALFORMED_FRAMING';
  } else if (state === 'missing-required-material') {
    outcome = 'reject';
    code = 'E_READER_REQUIRED_MATERIAL_MISSING';
  } else if (state === 'unsupported-root-protocol') {
    outcome = String(profile.unsupportedRootOutcome || '');
    code = 'E_READER_UNSUPPORTED_ROOT_PROTOCOL';
  } else if (state === 'well-formed-unknown-carrier') {
    outcome = String(profile.unknownOutcome || '');
    code =
      outcome === 'read-degraded'
        ? 'E_READER_UNKNOWN_CARRIER'
        : outcome === 'migration-required'
          ? 'E_READER_SEMANTIC_SCOPE_INCOMPLETE'
          : 'E_READER_UNKNOWN_CARRIER';
  } else if (state === 'well-formed-unknown-schema') {
    outcome = String(profile.unknownOutcome || '');
    code =
      outcome === 'read-degraded'
        ? 'E_READER_UNKNOWN_SCHEMA'
        : outcome === 'migration-required'
          ? 'E_READER_SEMANTIC_SCOPE_INCOMPLETE'
          : 'E_READER_UNKNOWN_SCHEMA';
  } else if (state !== 'known') {
    throw new Error(`unknown material state: ${state}`);
  }
  const allowed = Array.isArray(profile.allowedOutcomes)
    ? profile.allowedOutcomes
    : [];
  if (!allowed.includes(outcome))
    throw new Error(`${input.profile} does not allow outcome ${outcome}`);
  return {
    profile: input.profile,
    materialState: state,
    outcome,
    code,
    exactBytesMustBePreserved:
      state !== 'known' && state !== 'missing-required-material',
    structuralVerification:
      outcome === 'read' || outcome === 'read-degraded'
        ? 'complete'
        : 'not-claimed',
    semanticVerification: outcome === 'read' ? 'complete' : 'incomplete',
    mayEnterCanonicalFold:
      outcome === 'read' &&
      ['canonical-fold', 'admission', 'execution'].includes(input.profile),
    mayAdmitAuthority: outcome === 'read' && input.profile === 'admission',
    mayExecute: outcome === 'read' && input.profile === 'execution',
  };
}

function validateOutcomeCatalog(contract, fail) {
  const outcomes = isObject(contract.outcomes) ? contract.outcomes : {};
  for (const outcome of [
    'read',
    'read-degraded',
    'preserve-only',
    'migration-required',
    'reject',
  ])
    if (!isObject(outcomes[outcome])) fail(`missing outcome: ${outcome}`);
  return outcomes;
}

function validateCapabilityCatalog(contract, fail) {
  const capabilities = Array.isArray(contract.capabilities)
    ? contract.capabilities
    : [];
  const capabilityIds = new Set(
    capabilities.map((entry) =>
      isObject(entry) ? String(entry.id || '') : '',
    ),
  );
  for (const required of REQUIRED_PROFILES)
    if (!capabilityIds.has(required)) fail(`missing capability: ${required}`);
}

function validateProfileCatalog(profiles, fail) {
  const profileIds = profiles.map((entry) =>
    isObject(entry) ? String(entry.id || '') : '',
  );
  if (
    profileIds.length !== REQUIRED_PROFILES.length ||
    new Set(profileIds).size !== profileIds.length
  )
    fail('reader profiles are incomplete or duplicated');
  for (const required of REQUIRED_PROFILES)
    if (!profileIds.includes(required))
      fail(`missing reader profile: ${required}`);
}

function validateProfileReferences(contract, profiles, outcomes, fail) {
  const errors = Array.isArray(contract.errorDictionary)
    ? contract.errorDictionary
    : [];
  const errorCodes = new Set(
    errors.map((entry) => (isObject(entry) ? String(entry.code || '') : '')),
  );
  for (const profile of profiles) {
    if (!isObject(profile)) continue;
    const id = String(profile.id || '');
    const allowed = Array.isArray(profile.allowedOutcomes)
      ? profile.allowedOutcomes.map(String)
      : [];
    for (const outcome of allowed)
      if (!isObject(outcomes[outcome]))
        fail(`${id} references unknown outcome: ${outcome}`);
    for (const code of Array.isArray(profile.failureCodes)
      ? profile.failureCodes.map(String)
      : [])
      if (!errorCodes.has(code))
        fail(`${id} references unknown failure code: ${code}`);
    if (
      AUTHORITY_PROFILES.has(id) &&
      ['read', 'read-degraded', 'preserve-only'].includes(
        String(profile.unknownOutcome || ''),
      )
    )
      fail(`${id} silently upgrades unknown material into authority`);
  }
}

function validateReaderProfiles(contract, outcomes, fail) {
  const profiles = Array.isArray(contract.readerProfiles)
    ? contract.readerProfiles
    : [];
  validateProfileCatalog(profiles, fail);
  validateProfileReferences(contract, profiles, outcomes, fail);
}

function validateImplementationBindings(contract, readSource, fail) {
  const bindings = isObject(contract.implementationBindings)
    ? contract.implementationBindings
    : {};
  for (const bindingId of ['episode', 'fact', 'publicSpec']) {
    const binding = isObject(bindings[bindingId]) ? bindings[bindingId] : {};
    const source = String(binding.source || '');
    let sourceText = '';
    try {
      sourceText = readSource(source);
    } catch {
      fail(`${bindingId} binding source is missing: ${source}`);
      continue;
    }
    for (const [key, marker] of Object.entries(binding))
      if (
        key !== 'source' &&
        typeof marker === 'string' &&
        !sourceText.includes(marker)
      )
        fail(`${bindingId} binding marker drifted: ${marker}`);
  }
}

function validateUnknownAuthorityBoundary(contract, fail) {
  for (const profile of REQUIRED_PROFILES) {
    const unknown = evaluateRequiredReader(contract, {
      profile,
      materialState: 'well-formed-unknown-schema',
    });
    if (
      AUTHORITY_PROFILES.has(profile) &&
      (unknown.mayEnterCanonicalFold ||
        unknown.mayAdmitAuthority ||
        unknown.mayExecute)
    )
      fail(`${profile} lets unknown material cross the authority boundary`);
  }
}

/**
 * @param {Record<string, unknown>} contract
 * @param {{root?: string, readSource?: (relative: string) => string}} [options]
 */
export function validateRequiredReaderContract(contract, options = {}) {
  const root = options.root || ROOT;
  const readSource =
    options.readSource ||
    ((relative) => fs.readFileSync(path.join(root, relative), 'utf8'));
  /** @type {string[]} */
  const issues = [];
  const fail = (message) => issues.push(message);
  if (
    contract.schema !== 'kungfu.required-reader.contract/v1' ||
    contract.id !== 'kungfu-required-reader' ||
    contract.version !== 1
  )
    fail('required-reader contract identity drifted');

  const outcomes = validateOutcomeCatalog(contract, fail);
  validateCapabilityCatalog(contract, fail);
  validateReaderProfiles(contract, outcomes, fail);
  validateImplementationBindings(contract, readSource, fail);
  validateUnknownAuthorityBoundary(contract, fail);
  return issues;
}

export function checkRequiredReaderContract(root = ROOT) {
  const contract = JSON.parse(
    fs.readFileSync(path.join(root, CONTRACT_PATH), 'utf8'),
  );
  const issues = validateRequiredReaderContract(contract, { root });
  if (issues.length)
    throw new Error(
      `required-reader contract drift:\n- ${issues.join('\n- ')}`,
    );
  return {
    contract: CONTRACT_PATH,
    profiles: contract.readerProfiles.length,
    errors: contract.errorDictionary.length,
  };
}

function main() {
  const result = checkRequiredReaderContract();
  console.log(
    `[required-reader] contract=${result.contract} profiles=${result.profiles} errors=${result.errors}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try {
    main();
  } catch (error) {
    console.error(
      `[required-reader] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
