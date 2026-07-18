// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync, spawnSync } from 'node:child_process';
import { posix, resolve } from 'node:path';

import {
  canonicalJson,
  parseRootJson,
  semanticRoot,
  sha256Bytes,
  verifyProjectCut,
  verifyProjectCutReceipt,
} from './project-cut.mjs';
import { sourceProjectionAtCommit } from './settlement.mjs';

export const COMPOSITION_SCHEMA = 'project.cut.composition/v1';
const ROOT = /^sha256:[0-9a-f]{64}$/u;
const MANIFEST =
  /^\.kungfu\/project-cuts\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\/manifest\.json$/u;
const PROTOCOL_PREFIX = '.kungfu/project-cuts/';

function git(root, args, encoding = 'utf8') {
  return execFileSync('git', args, { cwd: root, encoding }).trim();
}

function gitResult(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

function diagnostic(code, path, detail) {
  return { code, path, detail };
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareText);
}

function normalizeDiagnostics(values) {
  return [...values].sort((left, right) =>
    compareText(
      `${left.path}\0${left.code}\0${left.detail}`,
      `${right.path}\0${right.code}\0${right.detail}`,
    ),
  );
}

function commitFacts(root, input) {
  const commitOid = git(root, ['rev-parse', `${input}^{commit}`]);
  const treeOid = git(root, ['rev-parse', `${commitOid}^{tree}`]);
  const row = git(root, ['rev-list', '--parents', '-n', '1', commitOid]).split(
    ' ',
  );
  return { commitOid, treeOid, parentCommitOids: row.slice(1) };
}

function manifestPaths(root, commit) {
  return git(root, ['ls-tree', '-r', '-z', '--name-only', commit])
    .split('\0')
    .filter((path) => MANIFEST.test(path))
    .sort(compareText);
}

function episodeProviderRoots(root, commit) {
  const paths = git(root, ['ls-tree', '-r', '-z', '--name-only', commit])
    .split('\0')
    .filter(
      (path) =>
        path.includes('/episodes/sealed/') && path.endsWith('/manifest.json'),
    );
  const roots = [];
  for (const path of paths) {
    try {
      const manifest = parseRootJson(readAt(root, commit, path));
      const { providerRoot, ...preimage } = manifest;
      if (!ROOT.test(String(providerRoot ?? ''))) continue;
      if (semanticRoot(preimage) !== providerRoot) continue;
      const claimsPath = posix.join(
        posix.dirname(path),
        manifest.claims?.path ?? '',
      );
      const claims = readAt(root, commit, claimsPath);
      const rows = claims.split('\n').filter(Boolean);
      if (
        !claims.endsWith('\n') ||
        sha256Bytes(Buffer.from(claims, 'utf8')) !== manifest.claims?.digest ||
        rows.length !== manifest.claims?.count
      )
        continue;
      let canonical = true;
      for (const [index, row] of rows.entries()) {
        const value = parseRootJson(row);
        if (value.index !== index || canonicalJson(value) !== row)
          canonical = false;
      }
      if (canonical) roots.push(providerRoot);
    } catch {
      // A malformed provider is unavailable evidence, never an admission.
    }
  }
  return new Set(roots);
}

function readAt(root, commit, path) {
  return execFileSync('git', ['show', `${commit}:${path}`], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function cutAt(root, commit, path) {
  return parseRootJson(readAt(root, commit, path));
}

function receiptPath(path) {
  return posix.join(posix.dirname(path), 'receipt.json');
}

function publicationCommit(root, commit, path) {
  const rows = git(root, [
    'log',
    '--format=%H',
    '--diff-filter=A',
    commit,
    '--',
    path,
  ])
    .split('\n')
    .filter(Boolean);
  return rows.at(-1) ?? null;
}

function changedPaths(root, before, after) {
  if (!before) return [];
  return sortedUnique(
    git(root, ['diff', '--name-only', '--diff-filter=ACMRD', before, after])
      .split('\n')
      .filter((path) => path && !path.startsWith(PROTOCOL_PREFIX)),
  );
}

function changedManifestPaths(root, base, commit) {
  const rows = git(root, [
    'diff',
    '--name-only',
    '--diff-filter=ACMRD',
    base,
    commit,
    '--',
    '.kungfu/project-cuts',
  ])
    .split('\n')
    .filter((path) => MANIFEST.test(path));
  return sortedUnique(rows);
}

function findCutPath(paths, cuts, rootValue) {
  const index = cuts.findIndex((cut) => cut.cutRoot === rootValue);
  return index === -1 ? null : paths[index];
}

function emptyReceipt(base, target, diagnostics) {
  const preimage = {
    schema: COMPOSITION_SCHEMA,
    operation: 'scoped-compose',
    scope: { base, target, changedPaths: [], changedCutRoots: [] },
    inputs: [],
    mappings: [],
    output: { sourceProjectionRoot: null },
    omissions: [],
    conflicts: [],
    diagnostics: normalizeDiagnostics(diagnostics),
    status: diagnostics.length === 0 ? 'qualified' : 'incomplete',
  };
  return { ...preimage, compositionRoot: semanticRoot(preimage) };
}

export function observeComposition(rootInput, baseInput, commitInput) {
  const root = resolve(rootInput);
  const base = commitFacts(root, baseInput);
  const target = commitFacts(root, commitInput);
  const diagnostics = [];
  if (!isAncestor(root, base.commitOid, target.commitOid))
    diagnostics.push(
      diagnostic(
        'scope-not-ancestor',
        '$.scope',
        'composition base must be an ancestor of the candidate',
      ),
    );
  const allPaths = manifestPaths(root, target.commitOid);
  const cuts = allPaths.map((path) => cutAt(root, target.commitOid, path));
  const availableRoots = sortedUnique(cuts.map((cut) => cut.cutRoot));
  const admittedEpisodeRoots = episodeProviderRoots(root, target.commitOid);
  const scopedPaths = changedManifestPaths(
    root,
    base.commitOid,
    target.commitOid,
  );
  if (scopedPaths.length === 0) return emptyReceipt(base, target, diagnostics);

  const inputs = [];
  for (const path of scopedPaths) {
    let cut;
    try {
      cut = cutAt(root, target.commitOid, path);
    } catch (error) {
      diagnostics.push(diagnostic('invalid-cut', path, String(error.message)));
      continue;
    }
    const verified = verifyProjectCut(cut, {
      availableParentRoots: availableRoots,
    });
    diagnostics.push(
      ...verified.diagnostics.map((entry) =>
        diagnostic(entry.code, `${path}:${entry.path}`, entry.message),
      ),
    );
    const receipt = receiptPath(path);
    try {
      const receiptText = readAt(root, target.commitOid, receipt);
      const receiptValue = parseRootJson(receiptText);
      diagnostics.push(
        ...verifyProjectCutReceipt(
          receiptValue,
          cut,
          Buffer.from(readAt(root, target.commitOid, path), 'utf8'),
          { availableParentRoots: availableRoots },
        ).diagnostics.map((entry) =>
          diagnostic(entry.code, `${receipt}:${entry.path}`, entry.message),
        ),
      );
    } catch (error) {
      diagnostics.push(
        diagnostic('missing-cut-receipt', receipt, String(error.message)),
      );
    }
    for (const parentRoot of cut.parentCutRoots) {
      if (!availableRoots.includes(parentRoot))
        diagnostics.push(
          diagnostic(
            'missing-parent-cut',
            path,
            `parent ${parentRoot} is absent`,
          ),
        );
    }
    const published = publicationCommit(root, target.commitOid, path);
    if (!published) {
      diagnostics.push(
        diagnostic('missing-publication', path, 'introducing commit is absent'),
      );
      continue;
    }
    const publication = commitFacts(root, published);
    const projection = sourceProjectionAtCommit(root, published, cut);
    if (projection.root !== cut.sourceProjection.root)
      diagnostics.push(
        diagnostic(
          'source-drift',
          path,
          `publication projects ${projection.root}, expected ${cut.sourceProjection.root}`,
        ),
      );
    const parentPublications = [];
    for (const episodeRoot of cut.episodeDelta.nativeRoots.map(
      (entry) => entry.root,
    )) {
      if (!admittedEpisodeRoots.has(episodeRoot))
        diagnostics.push(
          diagnostic(
            'unadmitted-integration-episode',
            path,
            `Episode provider ${episodeRoot} is absent`,
          ),
        );
    }
    for (const parentRoot of cut.parentCutRoots) {
      const parentPath = findCutPath(allPaths, cuts, parentRoot);
      const parentCommit = parentPath
        ? publicationCommit(root, target.commitOid, parentPath)
        : null;
      if (parentCommit) parentPublications.push(parentCommit);
    }
    const deltaBase =
      parentPublications.length === 1 ? parentPublications[0] : base.commitOid;
    inputs.push({
      cutRoot: cut.cutRoot,
      sourceProjectionRoot: cut.sourceProjection.root,
      atlasRoot: cut.atlas.root,
      episodeRoots: sortedUnique(
        cut.episodeDelta.nativeRoots.map((entry) => entry.root),
      ),
      parentCutRoots: cut.parentCutRoots,
      publication,
      deltaBaseCommitOid: deltaBase,
      changedPaths: changedPaths(root, deltaBase, publication.commitOid),
    });
  }
  inputs.sort((left, right) => compareText(left.cutRoot, right.cutRoot));
  const conflicts = [];
  for (let left = 0; left < inputs.length; left += 1) {
    for (let right = left + 1; right < inputs.length; right += 1) {
      const overlap = inputs[left].changedPaths.filter((path) =>
        inputs[right].changedPaths.includes(path),
      );
      if (overlap.length === 0) continue;
      const admittedIntegration =
        inputs[left].episodeRoots.some((rootValue) =>
          admittedEpisodeRoots.has(rootValue),
        ) ||
        inputs[right].episodeRoots.some((rootValue) =>
          admittedEpisodeRoots.has(rootValue),
        );
      if (!admittedIntegration) {
        for (const path of overlap) {
          conflicts.push({
            code: 'ambiguous-n-m-mapping',
            path,
            inputCutRoots: [inputs[left].cutRoot, inputs[right].cutRoot],
          });
          diagnostics.push(
            diagnostic(
              'unadmitted-integration-episode',
              path,
              'overlapping Cut deltas require admitted integration evidence',
            ),
          );
        }
      }
    }
  }
  conflicts.sort((left, right) => compareText(left.path, right.path));
  const representative = inputs[0]
    ? (cuts.find((cut) => cut.cutRoot === inputs[0].cutRoot) ?? null)
    : null;
  const outputProjection = representative
    ? sourceProjectionAtCommit(root, target.commitOid, representative)
    : null;
  const scopePaths = sortedUnique(
    inputs.flatMap((input) => input.changedPaths),
  );
  const mappings = inputs.map((input) => ({
    inputCutRoot: input.cutRoot,
    disposition: 'retained',
    outputSourceProjectionRoot: outputProjection?.root ?? null,
  }));
  const normalized = normalizeDiagnostics(diagnostics);
  const preimage = {
    schema: COMPOSITION_SCHEMA,
    operation: 'scoped-compose',
    scope: {
      base,
      target,
      changedPaths: scopePaths,
      changedCutRoots: inputs.map((input) => input.cutRoot),
    },
    inputs,
    mappings,
    output: { sourceProjectionRoot: outputProjection?.root ?? null },
    omissions: [],
    conflicts,
    diagnostics: normalized,
    status: normalized.length === 0 ? 'qualified' : 'incomplete',
  };
  return { ...preimage, compositionRoot: semanticRoot(preimage) };
}

export function verifyComposition(rootInput, receipt) {
  const diagnostics = [];
  if (!receipt || receipt.schema !== COMPOSITION_SCHEMA)
    diagnostics.push(
      diagnostic(
        'unknown-version',
        '$.schema',
        'unsupported composition schema',
      ),
    );
  if (!ROOT.test(String(receipt?.compositionRoot ?? '')))
    diagnostics.push(
      diagnostic(
        'missing-root',
        '$.compositionRoot',
        'composition root is missing',
      ),
    );
  if (diagnostics.length === 0) {
    const { compositionRoot, ...preimage } = receipt;
    if (semanticRoot(preimage) !== compositionRoot)
      diagnostics.push(
        diagnostic(
          'root-mismatch',
          '$.compositionRoot',
          'composition root differs',
        ),
      );
    const rebuilt = observeComposition(
      rootInput,
      receipt.scope.base.commitOid,
      receipt.scope.target.commitOid,
    );
    if (rebuilt.compositionRoot !== compositionRoot)
      diagnostics.push(
        diagnostic('composition-drift', '$', 'clean reconstruction differs'),
      );
  }
  const normalized = normalizeDiagnostics(diagnostics);
  return {
    ok: normalized.length === 0 && receipt?.status === 'qualified',
    diagnostics: normalized,
  };
}

export function compositionChanged(rootInput, baseInput, commitInput) {
  const root = resolve(rootInput);
  const base = git(root, ['rev-parse', `${baseInput}^{commit}`]);
  const commit = git(root, ['rev-parse', `${commitInput}^{commit}`]);
  return changedManifestPaths(root, base, commit).length > 0;
}

export function isAncestor(rootInput, older, newer) {
  return (
    gitResult(resolve(rootInput), ['merge-base', '--is-ancestor', older, newer])
      .status === 0
  );
}
