// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync, spawnSync } from 'node:child_process';
import { posix, resolve } from 'node:path';

import { verifyGitEpisodeEvidence } from '../../episode-provider/src/git-workspace-episode-provider.mjs';
import {
  parseRootJson,
  semanticRoot,
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
      const manifestText = readAt(root, commit, path);
      const manifest = parseRootJson(manifestText);
      const claimsPath = posix.join(
        posix.dirname(path),
        manifest.claims?.path ?? '',
      );
      const claims = readAt(root, commit, claimsPath);
      const qualificationText = readAt(
        root,
        commit,
        posix.join(posix.dirname(path), 'qualification.json'),
      );
      const qualification = parseRootJson(qualificationText);
      const report = verifyGitEpisodeEvidence({
        manifest,
        manifestText,
        claims: Buffer.from(claims, 'utf8'),
        qualification,
        qualificationText,
      });
      if (report.ok) roots.push(manifest.providerRoot);
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

function changedEvidencePaths(root, base, commit) {
  return sortedUnique(
    git(root, [
      'diff',
      '--name-only',
      '--diff-filter=ACMRD',
      base,
      commit,
      '--',
      '.kungfu/project-cuts',
      '.kungfu/episodes/sealed',
    ])
      .split('\n')
      .filter(Boolean),
  );
}

function providerRootsForEvidence(root, base, commit, evidencePaths) {
  const roots = new Set();
  const manifests = sortedUnique(
    evidencePaths
      .filter((path) => path.includes('/episodes/sealed/'))
      .map((path) => posix.join(posix.dirname(path), 'manifest.json')),
  );
  for (const path of manifests) {
    for (const revision of [base, commit]) {
      try {
        const value = parseRootJson(readAt(root, revision, path));
        if (ROOT.test(String(value.providerRoot ?? '')))
          roots.add(value.providerRoot);
      } catch {
        // A deleted or malformed side is checked through the other side.
      }
    }
  }
  return roots;
}

function scopedManifestPaths(root, base, commit, allPaths, cuts) {
  const evidencePaths = changedEvidencePaths(root, base, commit);
  const paths = new Set();
  for (const path of evidencePaths) {
    if (MANIFEST.test(path)) paths.add(path);
    else if (path.startsWith(PROTOCOL_PREFIX) && path.endsWith('/receipt.json'))
      paths.add(posix.join(posix.dirname(path), 'manifest.json'));
  }
  const providerRoots = providerRootsForEvidence(
    root,
    base,
    commit,
    evidencePaths,
  );
  for (const [index, cut] of cuts.entries()) {
    if (
      cut.episodeDelta.nativeRoots.some((entry) =>
        providerRoots.has(entry.root),
      )
    )
      paths.add(allPaths[index]);
  }
  return { evidencePaths, manifestPaths: sortedUnique([...paths]) };
}

function findCutPath(paths, cuts, rootValue) {
  const index = cuts.findIndex((cut) => cut.cutRoot === rootValue);
  return index === -1 ? null : paths[index];
}

function emptyReceipt(base, target, diagnostics, evidencePaths = []) {
  const preimage = {
    schema: COMPOSITION_SCHEMA,
    operation: 'scoped-compose',
    scope: {
      base,
      target,
      changedPaths: [],
      changedEvidencePaths: evidencePaths,
      changedCutRoots: [],
    },
    inputs: [],
    mappings: [],
    output: { projects: [] },
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
  const scope = scopedManifestPaths(
    root,
    base.commitOid,
    target.commitOid,
    allPaths,
    cuts,
  );
  const scopedPaths = scope.manifestPaths;
  if (scopedPaths.length === 0)
    return emptyReceipt(base, target, diagnostics, scope.evidencePaths);

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
      project: cut.project,
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
  const outputProjects = [];
  const projectKeys = sortedUnique(
    inputs.map((input) => `${input.project.id}\0${input.project.identityRoot}`),
  );
  for (const key of projectKeys) {
    const representativeInput = inputs.find(
      (input) => `${input.project.id}\0${input.project.identityRoot}` === key,
    );
    const representative = cuts.find(
      (cut) => cut.cutRoot === representativeInput.cutRoot,
    );
    outputProjects.push({
      project: representativeInput.project,
      sourceProjectionRoot: sourceProjectionAtCommit(
        root,
        target.commitOid,
        representative,
      ).root,
    });
  }
  const conflicts = [];
  const referencedRoots = new Set(
    inputs.flatMap((input) => input.parentCutRoots),
  );
  const activeLeaves = inputs.filter(
    (input) => !referencedRoots.has(input.cutRoot),
  );
  for (let left = 0; left < activeLeaves.length; left += 1) {
    for (let right = left + 1; right < activeLeaves.length; right += 1) {
      const overlap = activeLeaves[left].changedPaths.filter((path) =>
        activeLeaves[right].changedPaths.includes(path),
      );
      if (overlap.length === 0) continue;
      for (const path of overlap) {
        conflicts.push({
          code: 'ambiguous-n-m-mapping',
          path,
          inputCutRoots: [
            activeLeaves[left].cutRoot,
            activeLeaves[right].cutRoot,
          ],
        });
        diagnostics.push(
          diagnostic(
            'unadmitted-integration-episode',
            path,
            'overlapping active Cut leaves require a successor Cut with admitted integration evidence',
          ),
        );
      }
    }
  }
  for (const successor of inputs.filter(
    (input) => input.parentCutRoots.length > 1,
  )) {
    const parents = inputs.filter((input) =>
      successor.parentCutRoots.includes(input.cutRoot),
    );
    const overlap = sortedUnique(
      parents.flatMap((left, index) =>
        parents
          .slice(index + 1)
          .flatMap((right) =>
            left.changedPaths.filter((path) =>
              right.changedPaths.includes(path),
            ),
          ),
      ),
    );
    if (overlap.length === 0) continue;
    const admitted = successor.episodeRoots.some((rootValue) =>
      admittedEpisodeRoots.has(rootValue),
    );
    const projectOutput = outputProjects.find(
      (entry) =>
        entry.project.id === successor.project.id &&
        entry.project.identityRoot === successor.project.identityRoot,
    );
    if (
      !admitted ||
      successor.sourceProjectionRoot !== projectOutput?.sourceProjectionRoot
    )
      diagnostics.push(
        diagnostic(
          'unadmitted-integration-episode',
          successor.cutRoot,
          'overlap resolution must bind exact parents, an admitted Episode, and the candidate output projection',
        ),
      );
  }
  conflicts.sort((left, right) => compareText(left.path, right.path));
  const scopePaths = sortedUnique(
    inputs.flatMap((input) => input.changedPaths),
  );
  const mappings = inputs.map((input) => ({
    project: input.project,
    inputCutRoot: input.cutRoot,
    disposition: 'retained',
    outputSourceProjectionRoot: outputProjects.find(
      (entry) =>
        entry.project.id === input.project.id &&
        entry.project.identityRoot === input.project.identityRoot,
    ).sourceProjectionRoot,
  }));
  const normalized = normalizeDiagnostics(diagnostics);
  const preimage = {
    schema: COMPOSITION_SCHEMA,
    operation: 'scoped-compose',
    scope: {
      base,
      target,
      changedPaths: scopePaths,
      changedEvidencePaths: scope.evidencePaths,
      changedCutRoots: inputs.map((input) => input.cutRoot),
    },
    inputs,
    mappings,
    output: { projects: outputProjects },
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
  return changedEvidencePaths(root, base, commit).length > 0;
}

export function isAncestor(rootInput, older, newer) {
  return (
    gitResult(resolve(rootInput), ['merge-base', '--is-ancestor', older, newer])
      .status === 0
  );
}
