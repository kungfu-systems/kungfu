#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyAdrIdentity,
  createUuidV7,
  findAdrReferences,
  formatAdrIdentity,
  identityFromAdrPath,
  resolveAdrIdentityPrefix,
} from './adr-identity.mjs';
import { parseFrontmatter } from './document-metadata-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY = 'docs/adr/legacy-identities.v1.json';
const ADR_INDEX = 'docs/adr/README.md';
const DOCS_CONTRACT = 'docs.contract.json';
const LEGACY_ADR_PUBLICATION_PATTERN =
  '^docs/adr/(?:KF|SHIFU)-ADR-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[^/]+\\\\.md$';
const ID_ONLY_ADR_PUBLICATION_PATTERN =
  '^docs/adr/(?:KF|SHIFU)-ADR-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\\\.md$';
const CURRENT_CONTEXT_QUALITY_CORPUS =
  'crates/xinfa/fixtures/golden/context-quality-corpus-v1.json';
const CURRENT_CONTEXT_QUALITY_QUALIFICATION =
  'crates/xinfa/qualification/context-quality-v1.json';
const CONTENT_ROOT_BOUND_ARTIFACTS = [
  '.xinfa/manifests/legacy-atlas-roots.json',
];
const SEMANTIC_LEGACY_FIXTURES = new Set([
  'scripts/adr-audit.test.mjs',
  'scripts/adr-identity.test.mjs',
  'scripts/adr-migration.test.mjs',
  'scripts/adr-release-gate.test.mjs',
  'scripts/document-metadata-contract.test.mjs',
]);
const REGENERATIONS = [
  {
    command: './shifu kfd:buildchain',
    checkCommand: './shifu kfd:buildchain:check',
    paths: [
      '.buildchain/kfd/kfd-3/surfaces.json',
      'developer/sdk/kfd/kfd-3-surfaces.json',
      'developer/sdk/kfd/upstream-aggregate.json',
      '.buildchain/kfd/kfd-1/contract-world.witness.json',
      '.buildchain/kfd/kfd-1/release-gate.json',
      '.buildchain/kfd/kfd-1/verify-result.json',
      '.buildchain/kfd/kfd-2/claims/',
      '.buildchain/kfd/kfd-2/release-claims.json',
      'developer/sdk/kfd/kfd-1/contract-world.witness.json',
      'developer/sdk/kfd/kfd-1/release-gate.json',
      'developer/sdk/kfd/kfd-1/verify-result.json',
      'developer/sdk/kfd/kfd-2/release-claims.json',
      'developer/sdk/kfd/kfd-2/claims/',
      '.buildchain/kfd/kfd-3/collaboration-interface.prebuild.json',
      '.buildchain/kfd/kfd-3/collaboration-interface.artifact.json',
      '.buildchain/kfd/kfd-3/capability-query.json',
      '.buildchain/kfd/buildchain-kfd-summary.json',
    ],
  },
  {
    command: './shifu node scripts/qualify-xinfa-context-quality.mjs --write',
    checkCommand: './shifu xinfa:quality',
    paths: [CURRENT_CONTEXT_QUALITY_QUALIFICATION],
  },
  {
    command: './shifu gate:workflow-authority:refresh',
    checkCommand: './shifu check:gate-catalog',
    paths: ['docs/qualification/gates/workflow-authority.json'],
  },
  {
    command: './shifu fix:cli-catalog-parity',
    checkCommand: './shifu check:cli-catalog-parity',
    paths: ['framework/core/src/python/kungfu/agent/cli_surface.catalog.json'],
  },
  {
    command: './shifu core:architecture:write',
    checkCommand: './shifu check:source',
    paths: [
      'framework/core/architecture/LAYERS.md',
      'framework/core/architecture/TARGETS.cmake',
      'framework/core/architecture/PUBLIC_CONTRACTS.cmake',
      'framework/core/architecture/ARCHITECTURE_INDEX.md',
      'framework/core/architecture/ARCHITECTURE_HEALTH.md',
      'framework/core/architecture/review-routes.json',
    ],
  },
];

/** @param {string} rel */
function isDeclaredRegenerationOutput(rel) {
  return REGENERATIONS.some((regeneration) =>
    regeneration.paths.some((output) =>
      output.endsWith('/') ? rel.startsWith(output) : rel === output,
    ),
  );
}

function regenerationDeclarations() {
  return REGENERATIONS.map((regeneration) => ({
    ...regeneration,
    paths: [...regeneration.paths],
  }));
}

function gitEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
}

/** @param {string} root @param {string[]} args @param {'utf8' | null} [encoding] */
function git(root, args, encoding = 'utf8') {
  const result = childProcess.spawnSync('git', args, {
    cwd: root,
    env: gitEnv(),
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${String(result.stderr || '').trim()}`,
    );
  }
  return result.stdout;
}

/** @param {unknown} value */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) =>
          Buffer.compare(Buffer.from(left), Buffer.from(right)),
        )
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

/** @param {unknown} value */
function digest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(`${JSON.stringify(canonical(value))}\n`)
    .digest('hex')}`;
}

/** @param {Buffer | string} value */
function bytesDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

/** @param {string} rel */
function lifecycle(rel) {
  if (SEMANTIC_LEGACY_FIXTURES.has(rel)) return 'semantic-fixture';
  if (rel === CURRENT_CONTEXT_QUALITY_CORPUS) return 'authored';
  if (isDeclaredRegenerationOutput(rel)) return 'generated';
  if (
    rel === CURRENT_CONTEXT_QUALITY_QUALIFICATION ||
    (rel.startsWith('.buildchain/kfd/kfd-2/') &&
      rel !== '.buildchain/kfd/kfd-2/registry.json') ||
    rel.startsWith('developer/sdk/kfd/kfd-2/')
  )
    return 'generated';
  if (rel.startsWith('.xinfa/generated/')) return 'generated';
  if (
    rel === INVENTORY ||
    rel.startsWith('.kungfu/episodes/sealed/') ||
    rel.startsWith('.kungfu/project-cuts/') ||
    rel.startsWith('.xinfa/baselines/') ||
    rel.startsWith('.xinfa/manifests/project-cuts/') ||
    rel.startsWith('crates/xinfa/fixtures/golden/') ||
    rel.startsWith('crates/xinfa/qualification/') ||
    rel.startsWith('docs/qualification/evidence/')
  ) {
    return 'historical-append-only';
  }
  if (
    /(?:^|\/)fixtures(?:\/|$)/.test(rel) ||
    /(?:^|\/)tests?(?:\/|$)/.test(rel) ||
    /\.test\.[^.]+$/.test(rel)
  ) {
    return 'test-fixture';
  }
  return 'authored';
}

/** @param {string} root @param {string} commit */
function treeSnapshot(root, commit) {
  const raw = String(git(root, ['ls-tree', '-r', '-z', commit]));
  const entries = raw
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const match = /^[0-7]+ blob ([0-9a-f]+)\t([\s\S]+)$/.exec(line);
      return match ? { oid: match[1], path: match[2] } : null;
    })
    .filter(Boolean)
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
    );
  const result = childProcess.spawnSync('git', ['cat-file', '--batch'], {
    cwd: root,
    env: gitEnv(),
    input: `${entries.map((entry) => entry.oid).join('\n')}\n`,
    encoding: null,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git cat-file --batch failed: ${String(result.stderr)}`);
  }
  const output = /** @type {Buffer} */ (result.stdout);
  const snapshot = new Map();
  let offset = 0;
  for (const entry of entries) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) throw new Error('git cat-file batch header is truncated');
    const header = output.subarray(offset, newline).toString('utf8').split(' ');
    const size = Number(header[2]);
    if (
      header[0] !== entry.oid ||
      header[1] !== 'blob' ||
      !Number.isSafeInteger(size)
    ) {
      throw new Error(
        `git cat-file returned an invalid header for ${entry.path}`,
      );
    }
    const start = newline + 1;
    const end = start + size;
    snapshot.set(entry.path, output.subarray(start, end));
    offset = end + 1;
  }
  return snapshot;
}

/** @param {Buffer} bytes */
function utf8(bytes) {
  if (bytes.includes(0)) return null;
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

/**
 * @param {string} text
 * @param {Map<string, {id: string, path: string, targetId: string, targetPath: string}>} mappings
 * @param {{identities?: boolean, revisions?: {beforeRoot: string, afterRoot: string}[]}} [options]
 */
function rewrite(text, mappings, options = {}) {
  let result = text;
  const pathReplacements = [];
  for (const row of mappings.values()) {
    pathReplacements.push([
      path.posix.basename(row.path),
      path.posix.basename(row.targetPath),
    ]);
  }
  pathReplacements.sort(([left], [right]) => right.length - left.length);
  for (const [before, after] of pathReplacements) {
    result = result.replaceAll(before, after);
  }
  if (options.identities !== false) {
    for (const row of mappings.values()) {
      const escaped = row.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(
        new RegExp(`(?<![A-Z0-9-])${escaped}(?![0-9])`, 'g'),
        row.targetId,
      );
    }
  }
  for (const row of options.revisions || []) {
    result = result.replaceAll(row.beforeRoot, row.afterRoot);
  }
  return result;
}

/** @param {string} text @param {Map<string, {path: string}>} mappings */
function retireAdrIndexRows(text, mappings) {
  const legacyPaths = new Set(
    [...mappings.values()].map((row) => path.posix.basename(row.path)),
  );
  return text
    .split('\n')
    .filter((line) => {
      const match = /^\|\s*\[[^\]]+\]\(([^)]+)\)\s*\|/.exec(line);
      return !match || !legacyPaths.has(match[1]);
    })
    .join('\n');
}

/** @param {string} text @param {string} needle */
function occurrenceCount(text, needle) {
  return text.split(needle).length - 1;
}

/**
 * @param {string} text
 * @param {Map<string, {id: string, path: string, targetId: string, targetPath: string}>} mappings
 * @param {string} mode
 * @param {{beforeRoot: string, afterRoot: string}[]} revisions
 */
function rewriteForMode(text, mappings, mode, revisions = []) {
  if (mode === 'none') return text;
  if (mode === 'index-retire') {
    return rewrite(retireAdrIndexRows(text, mappings), mappings, {
      identities: false,
    });
  }
  if (mode === 'publication-contract') {
    return text.replace(
      LEGACY_ADR_PUBLICATION_PATTERN,
      ID_ONLY_ADR_PUBLICATION_PATTERN,
    );
  }
  return rewrite(text, mappings, {
    identities: mode === 'full',
    revisions: mode === 'full' ? revisions : [],
  });
}

/** @param {string} rel */
function rewriteMode(rel) {
  const kind = lifecycle(rel);
  if (kind === 'semantic-fixture') return 'none';
  if (rel === ADR_INDEX) return 'index-retire';
  if (rel === DOCS_CONTRACT) return 'publication-contract';
  if (kind === 'test-fixture') return 'paths-only';
  return 'full';
}

/** @param {{root?: string, sourceCommit?: string}} [options] */
export function createAdrMigrationPlan(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const commit = String(
    git(root, ['rev-parse', `${options.sourceCommit || 'HEAD'}^{commit}`]),
  ).trim();
  const tree = String(git(root, ['rev-parse', `${commit}^{tree}`])).trim();
  const sourceTimestamp =
    Number(String(git(root, ['show', '-s', '--format=%ct', commit])).trim()) *
    1000;
  const snapshot = treeSnapshot(root, commit);
  const files = [...snapshot.keys()];
  if (!files.includes(INVENTORY)) {
    throw new Error(`${INVENTORY} is missing from ${commit}`);
  }
  const inventory = JSON.parse(snapshot.get(INVENTORY).toString());
  if (
    inventory.schema !== 'kungfu.adr-legacy-identities/v1' ||
    !Array.isArray(inventory.records)
  ) {
    throw new Error(`${INVENTORY} is invalid`);
  }
  let identityTimestamp = sourceTimestamp;
  const cutoverCommit = String(inventory.cutoverCommit || '');
  try {
    identityTimestamp =
      Number(
        String(
          git(root, [
            'show',
            '-s',
            '--format=%ct',
            `${cutoverCommit}^{commit}`,
          ]),
        ).trim(),
      ) * 1000;
  } catch {
    // Synthetic fixture repositories may retain a non-reachable cutover id.
  }

  const mappings = new Map();
  const targetIdentities = new Set();
  const problems = [];
  for (const record of inventory.records) {
    const id = String(record.id || '');
    const sourcePath = String(record.path || '');
    const identity = classifyAdrIdentity(id);
    if (identity?.kind !== 'legacy' || !files.includes(sourcePath)) {
      problems.push({ code: 'legacy-record-invalid', id, path: sourcePath });
      continue;
    }
    const random = crypto
      .createHash('sha256')
      .update(`${cutoverCommit}\0${id}\0${sourcePath}`)
      .digest()
      .subarray(0, 10);
    const targetId = formatAdrIdentity(
      identity.owner,
      createUuidV7({ timestamp: identityTimestamp, random }),
    );
    const targetPath = `docs/adr/${targetId}.md`;
    if (targetIdentities.has(targetId)) {
      problems.push({ code: 'generated-identity-collision', id, targetId });
    }
    targetIdentities.add(targetId);
    if (files.includes(targetPath)) {
      problems.push({
        code: 'rename-collision',
        id,
        path: sourcePath,
        targetPath,
      });
    }
    mappings.set(id, { id, path: sourcePath, targetId, targetPath });
  }

  const revisionMappings = [...mappings.values()]
    .map((row) => {
      const bytes = snapshot.get(row.path);
      const text = utf8(bytes);
      if (text === null) {
        problems.push({
          code: 'legacy-record-not-utf8',
          id: row.id,
          path: row.path,
        });
        return null;
      }
      return {
        id: row.id,
        path: row.path,
        targetPath: row.targetPath,
        beforeRoot: bytesDigest(bytes),
        afterRoot: bytesDigest(rewrite(text, mappings)),
      };
    })
    .filter(Boolean)
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)),
    );
  const artifactRevisionMappings = CONTENT_ROOT_BOUND_ARTIFACTS.filter((rel) =>
    files.includes(rel),
  )
    .map((rel) => {
      const bytes = snapshot.get(rel);
      const text = utf8(bytes);
      if (text === null) {
        problems.push({ code: 'bound-artifact-not-utf8', path: rel });
        return null;
      }
      return {
        path: rel,
        beforeRoot: bytesDigest(bytes),
        afterRoot: bytesDigest(
          rewriteForMode(text, mappings, rewriteMode(rel)),
        ),
      };
    })
    .filter(Boolean)
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
    );
  const allRevisionMappings = [
    ...revisionMappings,
    ...artifactRevisionMappings,
  ];

  const transformations = [];
  const preserved = [];
  const referenceCounts = new Map();
  const catalog = [];
  for (const rel of files) {
    const bytes = snapshot.get(rel);
    const text = utf8(bytes);
    if (text === null) continue;
    const refs = findAdrReferences(text);
    for (const ref of refs) {
      referenceCounts.set(ref, (referenceCounts.get(ref) || 0) + 1);
      if (
        lifecycle(rel) === 'authored' &&
        classifyAdrIdentity(ref)?.kind === 'legacy' &&
        !mappings.has(ref)
      ) {
        problems.push({
          code: 'unresolved-legacy-reference',
          id: ref,
          path: rel,
        });
      }
    }
    const identity = identityFromAdrPath(rel);
    if (identity) {
      const frontmatter = parseFrontmatter(text);
      catalog.push({
        id: String(frontmatter?.fields.get('adr_id')?.value || identity),
        path: rel,
        title: /^#\s+[^:]+:\s*(.+)$/m.exec(text)?.[1] || '',
        decisionStatus: String(
          frontmatter?.fields.get('decision_status')?.value || '',
        ),
        implementationStatus: String(
          frontmatter?.fields.get('implementation_status')?.value || '',
        ),
      });
    }
    const mode = rewriteMode(rel);
    const after = rewriteForMode(text, mappings, mode, allRevisionMappings);
    if (
      mode === 'publication-contract' &&
      occurrenceCount(text, LEGACY_ADR_PUBLICATION_PATTERN) !== 1
    ) {
      problems.push({
        code: 'publication-contract-pattern-cardinality',
        path: rel,
        expected: 1,
        actual: occurrenceCount(text, LEGACY_ADR_PUBLICATION_PATTERN),
      });
    }
    const renamed = mappings.get(identity || '')?.targetPath || rel;
    const mappedReferences = refs.filter((ref) => mappings.has(ref));
    if (after === text && renamed === rel && mappedReferences.length === 0)
      continue;
    const row = {
      path: rel,
      targetPath: renamed,
      beforeRoot: bytesDigest(bytes),
      afterRoot: bytesDigest(after),
      rewriteMode: mode,
      references: mappedReferences,
    };
    const kind = lifecycle(rel);
    if (kind === 'authored' || (kind === 'test-fixture' && after !== text))
      transformations.push(row);
    else preserved.push({ ...row, lifecycle: kind });
  }
  const transformationsByPath = new Map(
    transformations.map((row) => [row.path, row]),
  );
  for (const revision of revisionMappings) {
    const transformation = transformationsByPath.get(revision.path);
    if (transformation?.afterRoot !== revision.afterRoot) {
      problems.push({
        code: 'adr-revision-closure-nonterminal',
        id: revision.id,
        path: revision.path,
        expectedRoot: revision.afterRoot,
        actualRoot: transformation?.afterRoot || '',
      });
    }
  }
  for (const revision of artifactRevisionMappings) {
    const transformation = transformationsByPath.get(revision.path);
    if (transformation?.afterRoot !== revision.afterRoot) {
      problems.push({
        code: 'artifact-revision-closure-nonterminal',
        path: revision.path,
        expectedRoot: revision.afterRoot,
        actualRoot: transformation?.afterRoot || '',
      });
    }
  }

  const body = {
    schema: 'kungfu.adr-migration-plan/v1',
    mode: 'dry-run',
    source: {
      commit,
      tree,
      root: digest({ commit, tree }),
      scannedFiles: files.length,
      legacyCutoverCommit: cutoverCommit,
    },
    policy: {
      filenameProjection: 'canonical-id-only',
      identityDerivation: 'cutover-commit-time-path-sha256-v1',
      generated: 'preserve-until-declared-regeneration',
      historicalAppendOnly: 'preserve',
      testFixtures: 'rewrite-paths-only',
      semanticLegacyFixtures: 'preserve',
      adrIndex: 'retire-legacy-rows',
      adrPublication: 'id-only-implicit-collection',
    },
    mappings: [...mappings.values()].sort((left, right) =>
      Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)),
    ),
    revisionMappings,
    artifactRevisionMappings,
    transformations: transformations.sort((left, right) =>
      Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
    ),
    preserved: preserved.sort((left, right) =>
      Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
    ),
    catalog: catalog.sort((left, right) =>
      Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)),
    ),
    referenceCounts: Object.fromEntries(
      [...referenceCounts].sort(([left], [right]) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      ),
    ),
    regenerations: regenerationDeclarations(),
    problems: problems.sort((left, right) =>
      Buffer.compare(
        Buffer.from(JSON.stringify(left)),
        Buffer.from(JSON.stringify(right)),
      ),
    ),
    summary: {
      records: mappings.size,
      rewritableFiles: transformations.length,
      preservedFiles: preserved.length,
      problems: problems.length,
    },
    conservation: {
      sourceIdentities: mappings.size,
      targetIdentities: targetIdentities.size,
      oneToOne: mappings.size === targetIdentities.size,
    },
  };
  return { ...body, manifestRoot: digest(body) };
}

/** @param {string} root @param {any} plan @param {string} [expectedSourceRoot] */
export function applyAdrMigrationPlan(root, plan, expectedSourceRoot = '') {
  const { manifestRoot, ...body } = plan || {};
  if (
    plan?.schema !== 'kungfu.adr-migration-plan/v1' ||
    manifestRoot !== digest(body)
  ) {
    throw new Error('migration manifest root is invalid');
  }
  if (expectedSourceRoot && plan.source.root !== expectedSourceRoot) {
    throw new Error('expected source root differs from migration manifest');
  }
  if (plan.problems.length > 0) {
    throw new Error('migration manifest has unresolved problems');
  }

  const states = plan.transformations.map((row) => {
    const before = path.join(root, row.path);
    const after = path.join(root, row.targetPath);
    if (
      fs.existsSync(before) &&
      bytesDigest(fs.readFileSync(before)) === row.beforeRoot
    )
      return 'before';
    if (
      fs.existsSync(after) &&
      bytesDigest(fs.readFileSync(after)) === row.afterRoot
    )
      return 'after';
    return 'drift';
  });
  for (const row of plan.preserved) {
    const file = path.join(root, row.path);
    if (!fs.existsSync(file))
      throw new Error(`preserved migration input is missing: ${row.path}`);
    if (
      row.lifecycle !== 'generated' &&
      bytesDigest(fs.readFileSync(file)) !== row.beforeRoot
    )
      throw new Error(`preserved migration input drifted: ${row.path}`);
  }
  if (states.every((state) => state === 'after')) {
    return {
      schema: 'kungfu.adr-migration-apply-receipt/v1',
      changed: false,
      manifestRoot: plan.manifestRoot,
      status: 'regeneration-required',
      regenerations: plan.regenerations,
    };
  }
  if (!states.every((state) => state === 'before')) {
    throw new Error(
      'working tree differs from both manifest source and result',
    );
  }
  const head = String(git(root, ['rev-parse', 'HEAD^{commit}'])).trim();
  const tree = String(git(root, ['rev-parse', 'HEAD^{tree}'])).trim();
  if (head !== plan.source.commit || tree !== plan.source.tree) {
    throw new Error('working checkout is not at the manifest source Git cut');
  }
  if (String(git(root, ['status', '--porcelain'])).trim()) {
    throw new Error('working checkout must be clean before migration apply');
  }
  for (const row of plan.transformations) {
    const source = path.join(root, row.path);
    const target = path.join(root, row.targetPath);
    const rewritten = rewriteForMode(
      fs.readFileSync(source, 'utf8'),
      new Map(plan.mappings.map((item) => [item.id, item])),
      row.rewriteMode,
      [
        ...(plan.revisionMappings || []),
        ...(plan.artifactRevisionMappings || []),
      ],
    );
    if (bytesDigest(rewritten) !== row.afterRoot) {
      throw new Error(`migration algorithm drifted for ${row.path}`);
    }
    if (row.path === row.targetPath) {
      fs.writeFileSync(source, rewritten);
    } else {
      if (fs.existsSync(target))
        throw new Error(`rename collision: ${row.targetPath}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, rewritten);
      fs.unlinkSync(source);
    }
  }
  return {
    schema: 'kungfu.adr-migration-apply-receipt/v1',
    changed: true,
    manifestRoot: plan.manifestRoot,
    status: 'regeneration-required',
    regenerations: plan.regenerations,
  };
}

/** @param {string} root @param {string} rel */
function generatedPathRoot(root, rel) {
  const absolute = path.join(root, rel);
  if (!fs.existsSync(absolute)) {
    throw new Error(`declared regeneration output is missing: ${rel}`);
  }
  const stat = fs.lstatSync(absolute);
  if (stat.isFile()) return bytesDigest(fs.readFileSync(absolute));
  if (!stat.isDirectory()) {
    throw new Error(
      `declared regeneration output is not a file or directory: ${rel}`,
    );
  }
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        files.push({
          path: path.relative(absolute, file).split(path.sep).join('/'),
          root: bytesDigest(fs.readFileSync(file)),
        });
      } else {
        throw new Error(
          `declared regeneration output contains a non-file: ${rel}`,
        );
      }
    }
  };
  visit(absolute);
  if (files.length === 0) {
    throw new Error(`declared regeneration output directory is empty: ${rel}`);
  }
  return digest(
    files.sort((left, right) =>
      Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
    ),
  );
}

/** @param {string} root @param {string} command */
function runRegenerationCheck(root, command) {
  const allowed = new Map([
    ['./shifu kfd:buildchain:check', ['kfd:buildchain:check']],
    ['./shifu xinfa:quality', ['xinfa:quality']],
    ['./shifu check:gate-catalog', ['check:gate-catalog']],
    ['./shifu check:cli-catalog-parity', ['check:cli-catalog-parity']],
    ['./shifu check:source', ['check:source']],
  ]);
  const args = allowed.get(command);
  if (!args) throw new Error(`unrecognized regeneration check: ${command}`);
  const result = childProcess.spawnSync('./shifu', args, {
    cwd: root,
    env: gitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed: ${String(result.stderr || result.stdout || '').trim()}`,
    );
  }
}

/**
 * @param {string} root
 * @param {any} plan
 * @param {string} expectedSourceRoot
 * @param {(root: string, command: string) => void} [check]
 */
export function completeAdrMigrationPlan(
  root,
  plan,
  expectedSourceRoot,
  check = runRegenerationCheck,
) {
  const { manifestRoot, ...body } = plan || {};
  if (
    plan?.schema !== 'kungfu.adr-migration-plan/v1' ||
    manifestRoot !== digest(body)
  ) {
    throw new Error('migration manifest root is invalid');
  }
  if (!expectedSourceRoot || plan.source.root !== expectedSourceRoot) {
    throw new Error('expected source root differs from migration manifest');
  }
  for (const row of plan.transformations) {
    const target = path.join(root, row.targetPath);
    if (
      !fs.existsSync(target) ||
      bytesDigest(fs.readFileSync(target)) !== row.afterRoot
    ) {
      throw new Error(`migration result drifted: ${row.targetPath}`);
    }
    if (
      row.path !== row.targetPath &&
      fs.existsSync(path.join(root, row.path))
    ) {
      throw new Error(`legacy migration source still exists: ${row.path}`);
    }
  }
  for (const row of plan.preserved) {
    const file = path.join(root, row.path);
    if (!fs.existsSync(file)) {
      throw new Error(`preserved migration input is missing: ${row.path}`);
    }
    if (
      row.lifecycle !== 'generated' &&
      bytesDigest(fs.readFileSync(file)) !== row.beforeRoot
    ) {
      throw new Error(`preserved migration input drifted: ${row.path}`);
    }
  }
  const checks = [];
  for (const regeneration of plan.regenerations) {
    check(root, regeneration.checkCommand);
    checks.push(regeneration.checkCommand);
  }
  const outputs = plan.regenerations.flatMap((regeneration) =>
    regeneration.paths.map((outputPath) => ({
      path: outputPath,
      root: generatedPathRoot(root, outputPath),
    })),
  );
  const receipt = {
    schema: 'kungfu.adr-migration-completion-receipt/v1',
    status: 'complete',
    manifestRoot: plan.manifestRoot,
    checks,
    outputs,
  };
  return { ...receipt, resultRoot: digest(receipt) };
}

function parseArgs(argv) {
  const args = {
    sourceCommit: '',
    manifest: '',
    apply: false,
    complete: false,
    expectedRoot: '',
    resolvePrefix: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--source-commit') args.sourceCommit = argv[++index] || '';
    else if (arg === '--manifest') args.manifest = argv[++index] || '';
    else if (arg === '--expected-source-root')
      args.expectedRoot = argv[++index] || '';
    else if (arg === '--resolve-prefix')
      args.resolvePrefix = argv[++index] || '';
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--complete') args.complete = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.apply && args.complete) {
    throw new Error('--apply and --complete are mutually exclusive');
  }
  if (args.apply) {
    if (!args.manifest || !args.expectedRoot) {
      throw new Error('--apply requires --manifest and --expected-source-root');
    }
    const plan = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
    process.stdout.write(
      `${JSON.stringify(applyAdrMigrationPlan(ROOT, plan, args.expectedRoot), null, 2)}\n`,
    );
    return;
  }
  if (args.complete) {
    if (!args.manifest || !args.expectedRoot) {
      throw new Error(
        '--complete requires --manifest and --expected-source-root',
      );
    }
    const plan = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
    process.stdout.write(
      `${JSON.stringify(completeAdrMigrationPlan(ROOT, plan, args.expectedRoot), null, 2)}\n`,
    );
    return;
  }
  const plan = createAdrMigrationPlan({
    root: ROOT,
    sourceCommit: args.sourceCommit,
  });
  if (args.resolvePrefix) {
    const id = resolveAdrIdentityPrefix(
      plan.catalog.map((record) => record.id),
      args.resolvePrefix,
    );
    const record = plan.catalog.find((candidate) => candidate.id === id);
    process.stdout.write(
      `${JSON.stringify(
        {
          schema: 'kungfu.adr-lookup/v1',
          query: args.resolvePrefix,
          id,
          path: record?.path,
          title: record?.title,
          sourceRoot: plan.source.root,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(
      `[adr-migration] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
