#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  sourceChangedFiles,
  sourceMergeBase,
} from '../../../scripts/source-acceptance.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const CONTRACT_PATH = 'framework/site/src/kfx-site-impact.contract.json';
const DECLARATION_PATH = 'framework/site/src/kfx-site-bundle.source.json';
const PROOF_PREFIX = 'framework/site/src/kfx-site-impact-proofs/';
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;

export class KfxSiteImpactError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'KfxSiteImpactError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new KfxSiteImpactError(code, message, details);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function rooted(value, field) {
  return { ...value, [field]: sha256(canonicalJson(value)) };
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function assertExactKeys(value, keys, label) {
  const actual = Object.keys(value || {}).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(
      'KFX_SITE_BUNDLE_IMPACT_CONTRACT_INVALID',
      `${label} fields must be exactly: ${expected.join(', ')}`,
    );
  }
}

function validateSelector(selector, label) {
  assertExactKeys(selector, ['kind', 'value'], label);
  if (!['contains', 'exact', 'prefix', 'suffix'].includes(selector.kind)) {
    fail(
      'KFX_SITE_BUNDLE_IMPACT_CONTRACT_INVALID',
      `${label} has unsupported selector kind: ${selector.kind}`,
    );
  }
  if (
    typeof selector.value !== 'string' ||
    !selector.value ||
    (['exact', 'prefix'].includes(selector.kind) &&
      path.isAbsolute(selector.value)) ||
    selector.value.split(/[\\/]/u).includes('..')
  ) {
    fail(
      'KFX_SITE_BUNDLE_IMPACT_CONTRACT_INVALID',
      `${label} must select one repository-relative path value`,
    );
  }
}

function selectorMatches(selector, relativePath) {
  const candidate = relativePath.toLowerCase();
  const value = selector.value.toLowerCase();
  if (selector.kind === 'exact') return candidate === value;
  if (selector.kind === 'prefix') return candidate.startsWith(value);
  if (selector.kind === 'suffix') return candidate.endsWith(value);
  return candidate.includes(value);
}

function anySelectorMatches(selectors, relativePath) {
  return selectors.some((selector) => selectorMatches(selector, relativePath));
}

function sourceFacetIndex(declaration) {
  const sources = new Map(
    declaration.sources.map((source) => [source.id, source.path]),
  );
  const index = new Map();
  for (const facet of declaration.facets) {
    for (const sourceId of facet.sourceIds) {
      const sourcePath = sources.get(sourceId);
      if (!sourcePath) continue;
      const facets = index.get(sourcePath) || [];
      facets.push(facet.id);
      index.set(sourcePath, uniqueSorted(facets));
    }
  }
  return index;
}

export function validateImpactContract(contract, declaration) {
  assertExactKeys(
    contract,
    [
      'contract',
      'declarationPath',
      'impactRules',
      'ownership',
      'proofDirectory',
    ],
    'impact contract',
  );
  if (contract.contract !== 'kungfu.kfx-site-impact/v1') {
    fail(
      'KFX_SITE_BUNDLE_IMPACT_CONTRACT_INVALID',
      `unexpected impact contract: ${contract.contract}`,
    );
  }
  if (
    contract.declarationPath !== DECLARATION_PATH ||
    contract.proofDirectory !== PROOF_PREFIX.slice(0, -1)
  ) {
    fail(
      'KFX_SITE_BUNDLE_IMPACT_CONTRACT_INVALID',
      'impact contract must bind the canonical KFX declaration and proof directory',
    );
  }
  assertExactKeys(
    contract.ownership,
    ['excludedSelectors', 'selectors'],
    'ownership',
  );
  if (
    !Array.isArray(contract.ownership.selectors) ||
    !contract.ownership.selectors.length ||
    !Array.isArray(contract.ownership.excludedSelectors)
  ) {
    fail(
      'KFX_SITE_BUNDLE_IMPACT_CONTRACT_INVALID',
      'ownership selectors must be non-empty arrays',
    );
  }
  contract.ownership.selectors.forEach((selector, index) =>
    validateSelector(selector, `ownership selector ${index}`),
  );
  contract.ownership.excludedSelectors.forEach((selector, index) =>
    validateSelector(selector, `ownership exclusion ${index}`),
  );

  const facetIds = new Set(declaration.facets.map(({ id }) => id));
  const ruleIds = new Set();
  if (!Array.isArray(contract.impactRules) || !contract.impactRules.length) {
    fail(
      'KFX_SITE_BUNDLE_IMPACT_CONTRACT_INVALID',
      'impactRules must be a non-empty array',
    );
  }
  for (const [index, rule] of contract.impactRules.entries()) {
    assertExactKeys(
      rule,
      ['disposition', 'facets', 'id', 'selectors'],
      `impact rule ${index}`,
    );
    if (!rule.id || ruleIds.has(rule.id)) {
      fail(
        'KFX_SITE_BUNDLE_IMPACT_CONTRACT_INVALID',
        `impact rule id is missing or duplicated: ${rule.id || '<empty>'}`,
      );
    }
    ruleIds.add(rule.id);
    if (
      !['proof-eligible', 'semantic-update-required'].includes(rule.disposition)
    ) {
      fail(
        'KFX_SITE_BUNDLE_IMPACT_CONTRACT_INVALID',
        `impact rule ${rule.id} has unsupported disposition`,
      );
    }
    if (!Array.isArray(rule.selectors) || !rule.selectors.length) {
      fail(
        'KFX_SITE_BUNDLE_IMPACT_CONTRACT_INVALID',
        `impact rule ${rule.id} requires selectors`,
      );
    }
    rule.selectors.forEach((selector, selectorIndex) =>
      validateSelector(
        selector,
        `impact rule ${rule.id} selector ${selectorIndex}`,
      ),
    );
    if (
      !Array.isArray(rule.facets) ||
      !rule.facets.length ||
      rule.facets.some((facet) => !facetIds.has(facet))
    ) {
      fail(
        'KFX_SITE_BUNDLE_IMPACT_CONTRACT_INVALID',
        `impact rule ${rule.id} references an empty or unknown facet set`,
      );
    }
  }
  return contract;
}

function canonicalSelector(selector) {
  return canonicalJson(selector);
}

export function assertContractNotWeakened(baseContract, contract) {
  if (!baseContract) return;
  const currentOwners = new Set(
    contract.ownership.selectors.map(canonicalSelector),
  );
  for (const selector of baseContract.ownership.selectors) {
    if (!currentOwners.has(canonicalSelector(selector))) {
      fail(
        'KFX_SITE_BUNDLE_IMPACT_CONTRACT_WEAKENED',
        `ownership selector was removed: ${canonicalJson(selector)}`,
      );
    }
  }
  const baseExclusions = new Set(
    baseContract.ownership.excludedSelectors.map(canonicalSelector),
  );
  for (const selector of contract.ownership.excludedSelectors) {
    if (!baseExclusions.has(canonicalSelector(selector))) {
      fail(
        'KFX_SITE_BUNDLE_IMPACT_CONTRACT_WEAKENED',
        `same-change ownership exclusions cannot be widened: ${canonicalJson(selector)}`,
      );
    }
  }
  const currentRules = new Map(
    contract.impactRules.map((rule) => [rule.id, rule]),
  );
  for (const baseRule of baseContract.impactRules) {
    const current = currentRules.get(baseRule.id);
    if (!current) {
      fail(
        'KFX_SITE_BUNDLE_IMPACT_CONTRACT_WEAKENED',
        `impact rule was removed: ${baseRule.id}`,
      );
    }
    if (
      canonicalJson(current.selectors) !== canonicalJson(baseRule.selectors)
    ) {
      fail(
        'KFX_SITE_BUNDLE_IMPACT_CONTRACT_WEAKENED',
        `impact rule selectors changed in place: ${baseRule.id}`,
      );
    }
    if (
      baseRule.disposition === 'semantic-update-required' &&
      current.disposition !== 'semantic-update-required'
    ) {
      fail(
        'KFX_SITE_BUNDLE_IMPACT_CONTRACT_WEAKENED',
        `public impact rule cannot become proof-eligible: ${baseRule.id}`,
      );
    }
    const currentFacets = new Set(current.facets);
    const removed = baseRule.facets.filter(
      (facet) => !currentFacets.has(facet),
    );
    if (removed.length) {
      fail(
        'KFX_SITE_BUNDLE_IMPACT_CONTRACT_WEAKENED',
        `impact rule ${baseRule.id} removed facets: ${removed.join(', ')}`,
      );
    }
  }
}

function isOwned(contract, declarationSources, relativePath) {
  if (declarationSources.has(relativePath)) return true;
  if (anySelectorMatches(contract.ownership.excludedSelectors, relativePath)) {
    return false;
  }
  return anySelectorMatches(contract.ownership.selectors, relativePath);
}

export function classifyKfxChanges(contract, declaration, changes) {
  const declared = sourceFacetIndex(declaration);
  const impacts = [];
  const unmapped = [];
  for (const change of changes) {
    if (change.path.startsWith(PROOF_PREFIX)) continue;
    if (!isOwned(contract, declared, change.path)) continue;
    if (declared.has(change.path)) {
      impacts.push({
        path: change.path,
        facets: declared.get(change.path),
        disposition: 'semantic-update-required',
        rules: ['declared-site-source'],
      });
      continue;
    }
    const matches = contract.impactRules.filter((rule) =>
      anySelectorMatches(rule.selectors, change.path),
    );
    if (!matches.length) {
      unmapped.push(change.path);
      continue;
    }
    impacts.push({
      path: change.path,
      facets: uniqueSorted(matches.flatMap((rule) => rule.facets)),
      disposition: matches.some(
        (rule) => rule.disposition === 'semantic-update-required',
      )
        ? 'semantic-update-required'
        : 'proof-eligible',
      rules: matches.map(({ id }) => id).sort(),
    });
  }
  if (unmapped.length) {
    fail(
      'KFX_SITE_BUNDLE_IMPACT_UNMAPPED',
      `KFX-owned paths have no Site Bundle impact mapping: ${unmapped.join(', ')}`,
      { paths: unmapped },
    );
  }
  return impacts;
}

export function semanticFacetUpdates(baseDeclaration, declaration, changes) {
  const changedPaths = new Set(changes.map((change) => change.path));
  const updated = new Set();
  const baseFacets = new Map(
    (baseDeclaration?.facets || []).map((facet) => [facet.id, facet]),
  );
  const currentFacets = new Map(
    declaration.facets.map((facet) => [facet.id, facet]),
  );
  for (const id of new Set([...baseFacets.keys(), ...currentFacets.keys()])) {
    if (
      canonicalJson(baseFacets.get(id) ?? null) !==
      canonicalJson(currentFacets.get(id) ?? null)
    ) {
      updated.add(id);
    }
  }
  for (const [sourcePath, facets] of sourceFacetIndex(declaration)) {
    if (changedPaths.has(sourcePath)) {
      for (const facet of facets) updated.add(facet);
    }
  }
  for (const [sourcePath, facets] of sourceFacetIndex(
    baseDeclaration || { sources: [], facets: [] },
  )) {
    if (changedPaths.has(sourcePath)) {
      for (const facet of facets) updated.add(facet);
    }
  }
  return [...updated].sort();
}

export function changeBinding(baseRevision, changes, affectedFacets) {
  return rooted(
    {
      schema: 'kungfu.kfx-site-impact-change/v1',
      baseRevision,
      changes: changes
        .filter((change) => !change.path.startsWith(PROOF_PREFIX))
        .map((change) => canonical(change))
        .sort((left, right) => left.path.localeCompare(right.path)),
      affectedFacets: uniqueSorted(affectedFacets),
    },
    'changeRoot',
  );
}

function validateRationale(rationale) {
  const value = String(rationale || '').trim();
  const generic =
    /^(?:internal(?: only)?|no public change|not user facing|refactor|test change)[.! ]*$/iu;
  if (
    value.length < 40 ||
    value.split(/\s+/u).length < 7 ||
    generic.test(value)
  ) {
    fail(
      'KFX_SITE_BUNDLE_IMPACT_PROOF_INVALID',
      'proof rationale must specifically explain why public behavior, contracts, and reader journeys are unchanged',
    );
  }
  return value;
}

export function createNoPublicChangeProof(binding, rationale) {
  return rooted(
    {
      contract: 'kungfu.kfx-site-impact-proof/v1',
      baseRevision: binding.baseRevision,
      changeRoot: binding.changeRoot,
      changes: binding.changes,
      affectedFacets: binding.affectedFacets,
      rationale: validateRationale(rationale),
      attestation: {
        publicBehaviorUnchanged: true,
        publicContractUnchanged: true,
        readerJourneyUnchanged: true,
      },
    },
    'proofRoot',
  );
}

export function validateNoPublicChangeProof(proof, binding, proofPath = '') {
  assertExactKeys(
    proof,
    [
      'affectedFacets',
      'attestation',
      'baseRevision',
      'changeRoot',
      'changes',
      'contract',
      'proofRoot',
      'rationale',
    ],
    'impact proof',
  );
  if (proof.contract !== 'kungfu.kfx-site-impact-proof/v1') {
    fail(
      'KFX_SITE_BUNDLE_IMPACT_PROOF_INVALID',
      'unexpected KFX Site impact proof contract',
    );
  }
  validateRationale(proof.rationale);
  assertExactKeys(
    proof.attestation,
    [
      'publicBehaviorUnchanged',
      'publicContractUnchanged',
      'readerJourneyUnchanged',
    ],
    'impact proof attestation',
  );
  if (Object.values(proof.attestation).some((value) => value !== true)) {
    fail(
      'KFX_SITE_BUNDLE_IMPACT_PROOF_INVALID',
      'all no-public-content-change attestations must be true',
    );
  }
  const expected = createNoPublicChangeProof(binding, proof.rationale);
  if (canonicalJson(proof) !== canonicalJson(expected)) {
    fail(
      'KFX_SITE_BUNDLE_IMPACT_PROOF_INVALID',
      'proof is stale or does not bind the exact base, changed paths, content roots, and affected facets',
    );
  }
  const expectedName = `${proof.proofRoot.slice('sha256:'.length)}.json`;
  if (proofPath && path.basename(proofPath) !== expectedName) {
    fail(
      'KFX_SITE_BUNDLE_IMPACT_PROOF_INVALID',
      `proof filename must be content-addressed as ${expectedName}`,
    );
  }
  return proof;
}

export function evaluateKfxSiteImpact({
  contract,
  baseContract,
  declaration,
  baseDeclaration,
  baseRevision,
  changes,
  proofs = [],
  refreshStaleProofs = false,
}) {
  validateImpactContract(contract, declaration);
  if (baseContract) {
    validateImpactContract(baseContract, baseDeclaration || declaration);
    assertContractNotWeakened(baseContract, contract);
  }
  const impacts = classifyKfxChanges(contract, declaration, changes);
  const changedProofPaths = changes
    .map((change) => change.path)
    .filter((relative) => relative.startsWith(PROOF_PREFIX));
  if (!impacts.length) {
    if (changedProofPaths.length) {
      fail(
        'KFX_SITE_BUNDLE_IMPACT_PROOF_INVALID',
        'proof-file-only changes are forbidden because no KFX impact exists',
      );
    }
    return {
      status: 'passing',
      impacts: [],
      semanticFacets: [],
      unresolvedFacets: [],
      proof: null,
    };
  }

  const semanticFacets = new Set(
    semanticFacetUpdates(baseDeclaration, declaration, changes),
  );
  const unresolved = uniqueSorted(
    impacts.flatMap((impact) =>
      impact.facets.filter((facet) => !semanticFacets.has(facet)),
    ),
  );
  const requiredPaths = impacts.filter(
    (impact) =>
      impact.disposition === 'semantic-update-required' &&
      impact.facets.some((facet) => unresolved.includes(facet)),
  );
  if (requiredPaths.length) {
    fail(
      'KFX_SITE_BUNDLE_UPDATE_REQUIRED',
      `public KFX changes require semantic Site Bundle updates for facets ${unresolved.join(', ')}; affected paths: ${requiredPaths.map(({ path: relative }) => relative).join(', ')}`,
      {
        facets: unresolved,
        paths: requiredPaths.map(({ path: relative }) => relative),
      },
    );
  }
  if (!unresolved.length) {
    if (changedProofPaths.length) {
      fail(
        'KFX_SITE_BUNDLE_IMPACT_PROOF_INVALID',
        'a no-public-content-change proof is forbidden when semantic updates already cover every affected facet',
      );
    }
    return {
      status: 'passing',
      impacts,
      semanticFacets: [...semanticFacets].sort(),
      unresolvedFacets: [],
      proof: null,
    };
  }

  const binding = changeBinding(baseRevision, changes, unresolved);
  let accepted = null;
  let proofFailure = null;
  for (const entry of proofs) {
    try {
      accepted = validateNoPublicChangeProof(entry.proof, binding, entry.path);
      break;
    } catch (error) {
      if (!(error instanceof KfxSiteImpactError)) throw error;
      proofFailure = error;
    }
  }
  if (!accepted) {
    if (proofFailure && !refreshStaleProofs) throw proofFailure;
    fail(
      'KFX_SITE_BUNDLE_UPDATE_REQUIRED',
      `eligible internal KFX changes require semantic updates or an exact no-public-content-change proof for facets ${unresolved.join(', ')}`,
      { binding, facets: unresolved },
    );
  }
  return {
    status: 'passing',
    impacts,
    semanticFacets: [...semanticFacets].sort(),
    unresolvedFacets: unresolved,
    proof: accepted.proofRoot,
  };
}

function git(
  args,
  { optional = false, root = ROOT, env = process.env, input } = {},
) {
  const result = spawnSync('git', args, {
    cwd: root,
    env,
    input,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (optional && result.status !== 0) return null;
  if (result.status !== 0) {
    fail(
      'KFX_SITE_BUNDLE_IMPACT_GIT_FAILED',
      `git ${args.join(' ')} failed: ${String(result.stderr || '').trim()}`,
    );
  }
  return Buffer.from(result.stdout || '');
}

function gitJson(revision, relativePath, optional = false) {
  const bytes = git(['show', `${revision}:${relativePath}`], { optional });
  if (bytes === null) return null;
  return JSON.parse(bytes.toString('utf8'));
}

export function repositoryChanges(baseRevision, changedFiles, root = ROOT) {
  const objectDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-kfx-canonical-'),
  );
  const canonicalEnv = {
    ...process.env,
    GIT_OBJECT_DIRECTORY: objectDirectory,
  };
  try {
    return uniqueSorted(changedFiles).flatMap((relativePath) => {
      const baseBytes = git(['show', `${baseRevision}:${relativePath}`], {
        optional: true,
        root,
      });
      const currentPath = path.join(root, relativePath);
      const worktreeBytes = fs.existsSync(currentPath)
        ? fs.readFileSync(currentPath)
        : null;
      const currentBytes =
        worktreeBytes === null
          ? null
          : (() => {
              const oid = git(
                ['hash-object', '-w', `--path=${relativePath}`, '--stdin'],
                { env: canonicalEnv, input: worktreeBytes, root },
              )
                .toString('utf8')
                .trim();
              return git(['cat-file', 'blob', oid], {
                env: canonicalEnv,
                root,
              });
            })();
      if (
        (baseBytes === null && currentBytes === null) ||
        (baseBytes !== null &&
          currentBytes !== null &&
          baseBytes.equals(currentBytes))
      ) {
        return [];
      }
      const status =
        baseBytes === null
          ? 'added'
          : currentBytes === null
            ? 'deleted'
            : 'modified';
      return [
        {
          path: relativePath,
          status,
          ...(baseBytes === null ? {} : { baseContentRoot: sha256(baseBytes) }),
          ...(currentBytes === null
            ? {}
            : { contentRoot: sha256(currentBytes) }),
        },
      ];
    });
  } finally {
    fs.rmSync(objectDirectory, { force: true, recursive: true });
  }
}

function readProofs() {
  const directory = path.join(ROOT, PROOF_PREFIX);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      path: `${PROOF_PREFIX}${name}`,
      proof: JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')),
    }));
}

function parseArgs(argv) {
  const options = {
    base: '',
    changedFiles: [],
    writeProof: false,
    rationale: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--base') options.base = argv[++index] || '';
    else if (value === '--changed-file')
      options.changedFiles.push(argv[++index] || '');
    else if (value === '--write-proof') options.writeProof = true;
    else if (value === '--rationale') options.rationale = argv[++index] || '';
    else
      fail(
        'KFX_SITE_BUNDLE_IMPACT_ARGUMENT_INVALID',
        `unknown argument: ${value}`,
      );
  }
  options.changedFiles = options.changedFiles.filter(Boolean);
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const baseRevision = options.base || sourceMergeBase().sha;
  if (!REVISION_PATTERN.test(baseRevision)) {
    fail(
      'KFX_SITE_BUNDLE_IMPACT_ARGUMENT_INVALID',
      `base must be an immutable Git revision: ${baseRevision}`,
    );
  }
  const changedFiles = options.changedFiles.length
    ? options.changedFiles
    : sourceChangedFiles();
  const contract = JSON.parse(
    fs.readFileSync(path.join(ROOT, CONTRACT_PATH), 'utf8'),
  );
  const declaration = JSON.parse(
    fs.readFileSync(path.join(ROOT, DECLARATION_PATH), 'utf8'),
  );
  const baseContract = gitJson(baseRevision, CONTRACT_PATH, true);
  const baseDeclaration =
    gitJson(baseRevision, DECLARATION_PATH, true) || declaration;
  const changes = repositoryChanges(baseRevision, changedFiles);
  try {
    const result = evaluateKfxSiteImpact({
      contract,
      baseContract,
      declaration,
      baseDeclaration,
      baseRevision,
      changes,
      proofs: readProofs(),
      refreshStaleProofs: options.writeProof,
    });
    console.log(
      JSON.stringify(
        {
          schema: 'kungfu.kfx-site-impact-check/v1',
          baseRevision,
          changedFiles: changes.length,
          ...result,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (
      options.writeProof &&
      error instanceof KfxSiteImpactError &&
      error.code === 'KFX_SITE_BUNDLE_UPDATE_REQUIRED' &&
      error.details.binding
    ) {
      const proof = createNoPublicChangeProof(
        error.details.binding,
        options.rationale,
      );
      if (!ROOT_PATTERN.test(proof.proofRoot)) {
        fail(
          'KFX_SITE_BUNDLE_IMPACT_PROOF_INVALID',
          'generated proof root is invalid',
        );
      }
      const target = path.join(
        ROOT,
        PROOF_PREFIX,
        `${proof.proofRoot.slice('sha256:'.length)}.json`,
      );
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const bytes = `${JSON.stringify(proof, null, 2)}\n`;
      if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') !== bytes) {
        fail(
          'KFX_SITE_BUNDLE_IMPACT_PROOF_INVALID',
          `content-addressed proof already exists with different bytes: ${target}`,
        );
      }
      if (!fs.existsSync(target))
        fs.writeFileSync(target, bytes, { flag: 'wx' });
      console.log(
        JSON.stringify(
          {
            schema: 'kungfu.kfx-site-impact-proof-write/v1',
            status: 'written',
            path: path.relative(ROOT, target),
            proofRoot: proof.proofRoot,
            changeRoot: proof.changeRoot,
          },
          null,
          2,
        ),
      );
      return;
    }
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    const code =
      error instanceof KfxSiteImpactError
        ? error.code
        : 'KFX_SITE_BUNDLE_IMPACT_CHECK_FAILED';
    console.error(
      `${code}: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(
      `Remediation: update ${DECLARATION_PATH} or a bound source; eligible internal-only changes may run ./shifu check:kfx-site-impact -- --write-proof --rationale "<specific explanation>".`,
    );
    process.exit(1);
  }
}
