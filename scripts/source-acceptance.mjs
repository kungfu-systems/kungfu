#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  checkDevChannelAuthority,
  devMergeBaseCandidates,
} from './candidate-timeline-events.cjs';
import {
  SOURCE_ACCEPTANCE_RECOVERY,
  SOURCE_ACCEPTANCE_RUNTIME_OWNER,
  assertSourceCheckoutUnchanged,
  prepareSourceAcceptanceRuntime,
  sourceCheckoutSnapshot,
} from './readonly-source-toolchain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CPP = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/;
const WEB = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonc|css)$/;
const GENERATED_EVIDENCE_ROOTS = ['.kungfu/', '.xinfa/'];
const RUFF_CONFIG = 'framework/core/pyproject.toml';
// Repo-relative roots of the mypy-checked surface. Mirrors `files` under
// [tool.mypy] in framework/core/pyproject.toml, which stays the single source of
// truth for what gets checked; this list only decides whether a changed file
// makes the type baseline worth running at all.
const TYPED_PYTHON_ROOTS = [
  'framework/core/src/python/',
  'framework/storage/python/kungfu_sdk/',
  'framework/api/src/capability/guest-harness/',
  'extensions/work-control/work-control-actions/',
];
const isWin = process.platform === 'win32';

/** @typedef {{label: string, command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv}} Command */

const SOURCE_ACCEPTANCE_GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export function readSourceAcceptanceGit(
  args,
  { cwd = ROOT, optional = false } = {},
) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: SOURCE_ACCEPTANCE_GIT_MAX_BUFFER_BYTES,
  });
  if (optional) return result.status === 0 ? result.stdout.trim() : '';
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`,
    );
  }
  return result.stdout.trim();
}

function git(args) {
  return readSourceAcceptanceGit(args);
}

function gitMaybe(args) {
  return readSourceAcceptanceGit(args, { optional: true });
}

function commandAvailable(command) {
  return (
    spawnSync(isWin ? 'where' : 'which', [command], {
      stdio: 'ignore',
      shell: isWin,
    }).status === 0
  );
}

function commandProbe(command, args) {
  return spawnSync(command, args, { encoding: 'utf8' });
}

export function sourcePythonCommand(args, available = commandAvailable) {
  if (available('ruff')) return { command: 'ruff', args };
  if (available('uvx')) return { command: 'uvx', args: ['ruff', ...args] };
  if (available('uv')) {
    return { command: 'uv', args: ['tool', 'run', 'ruff', ...args] };
  }
  throw new Error('source acceptance requires ruff, uvx, or uv');
}

export function sourceMypyCommand(
  args,
  available = commandAvailable,
  probe = commandProbe,
) {
  if (available('mypy')) {
    const result = probe('mypy', ['--version']);
    const version = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.status === 0 && /(?:^|\n)mypy 1\.20\.2(?:\s|$)/.test(version)) {
      return { command: 'mypy', args };
    }
  }
  if (available('uvx')) {
    return {
      command: 'uvx',
      args: ['--from', 'mypy==1.20.2', 'mypy', ...args],
    };
  }
  if (available('uv')) {
    return {
      command: 'uv',
      args: ['tool', 'run', '--from', 'mypy==1.20.2', 'mypy', ...args],
    };
  }
  throw new Error('source acceptance requires mypy 1.20.2, uvx, or uv');
}

export function sourceClangFormatCommand(
  args,
  available = commandAvailable,
  probe = commandProbe,
) {
  if (available('clang-format')) {
    const result = probe('clang-format', ['--version']);
    const version = `${result.stdout || ''}${result.stderr || ''}`;
    if (
      result.status === 0 &&
      /clang-format version 20\.1\.8(?:\s|$)/u.test(version)
    )
      return { command: 'clang-format', args };
  }
  if (available('uvx'))
    return { command: 'uvx', args: ['clang-format@20.1.8', ...args] };
  if (available('uv')) {
    return {
      command: 'uv',
      args: [
        'tool',
        'run',
        '--from',
        'clang-format==20.1.8',
        'clang-format',
        ...args,
      ],
    };
  }
  throw new Error('source acceptance requires clang-format 20.1.8, uvx, or uv');
}

export function sourceMergeBase() {
  const mergeGroupBase = sourceMergeGroupBase();
  if (mergeGroupBase) return mergeGroupBase;
  const candidates = sourceAcceptanceMergeBaseCandidates();
  for (const ref of candidates) {
    const sha = gitMaybe(['merge-base', ref, 'HEAD']);
    if (sha) return { ref, sha };
  }
  throw new Error(
    `cannot resolve source-acceptance merge base from: ${candidates.join(', ')}`,
  );
}

export function sourceAcceptanceMergeBaseCandidates(
  devCandidates = devMergeBaseCandidates(),
) {
  return [...devCandidates, 'refs/buildchain/source-proof/current-base'];
}

export function fetchSourceAcceptanceCommit(commit, spawn = spawnSync) {
  const options = {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: SOURCE_ACCEPTANCE_GIT_MAX_BUFFER_BYTES,
  };
  const shallowProbe = spawn(
    'git',
    ['rev-parse', '--is-shallow-repository'],
    options,
  );
  if (shallowProbe.status !== 0) {
    throw new Error(
      `cannot inspect source-acceptance checkout depth: ${(shallowProbe.stderr || '').trim()}`,
    );
  }
  const fetchArgs = [
    'fetch',
    '--no-tags',
    '--no-write-fetch-head',
    '--filter=blob:none',
  ];
  if ((shallowProbe.stdout || '').trim() === 'true') {
    fetchArgs.push('--unshallow');
  }
  fetchArgs.push('origin', commit);
  const result = spawn('git', fetchArgs, options);
  if (result.status !== 0) {
    throw new Error(
      `cannot fetch source-acceptance merge-group base ${commit}: ${(result.stderr || '').trim()}`,
    );
  }
}

export function sourceMergeGroupBase({
  env = process.env,
  readFile = fs.readFileSync,
  gitRead = gitMaybe,
  fetchCommit = fetchSourceAcceptanceCommit,
} = {}) {
  const coordinates = githubMergeGroupCoordinates(env, readFile);
  if (!coordinates) return null;
  const observedHead = gitRead(['rev-parse', 'HEAD']);
  if (observedHead !== coordinates.headSha) {
    throw new Error(
      `merge-group event head ${coordinates.headSha} does not match source checkout ${observedHead || 'unavailable'}`,
    );
  }
  if (gitRead(['cat-file', '-t', coordinates.baseSha]) !== 'commit') {
    fetchCommit(coordinates.baseSha);
  }
  if (gitRead(['cat-file', '-t', coordinates.baseSha]) !== 'commit') {
    throw new Error(
      `source-acceptance merge-group base is unavailable after fetch: ${coordinates.baseSha}`,
    );
  }
  return {
    ref: 'github.merge_group.base_sha',
    sha: coordinates.baseSha,
    diffOperator: '..',
  };
}

export function sourceChangedFiles() {
  const base = sourceMergeBase();
  const revisionRange = `${base.sha}${base.diffOperator || '...'}HEAD`;
  /** @type {Set<string>} */
  const files = new Set();
  for (const args of [
    [
      'diff',
      '--name-only',
      '--no-renames',
      '--diff-filter=ACDMR',
      revisionRange,
    ],
    ['diff', '--name-only', '--no-renames', '--diff-filter=ACDMR'],
    ['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=ACDMR'],
    ['ls-files', '--others', '--exclude-standard'],
  ]) {
    for (const file of git(args).split('\n')) {
      const rel = file.trim();
      if (rel && !isLocalQualificationRuntime(rel)) files.add(rel);
    }
  }
  console.log(
    `[source-acceptance] revision=${git(['rev-parse', 'HEAD'])} base=${base.ref}@${base.sha}`,
  );
  return [...files];
}

export function isLocalQualificationRuntime(relativePath) {
  return (
    relativePath === '.kungfu/qualification' ||
    relativePath.startsWith('.kungfu/qualification/')
  );
}

function assertYijinjingWriterInterface() {
  const negativeGuard =
    'framework/core/src/libyijinjing/tests/writer_interface_surface_tests.cpp';
  const textFile = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|py|pyi|md|json|mjs)$/u;
  const forbidden = [
    ['open', 'frame'].join('_'),
    ['close', 'frame'].join('_'),
    ['write', 'raw'].join('_'),
    ['write', 'raw', 'at', 'as'].join('_'),
    ['open', 'data'].join('_'),
    ['open', 'custom', 'data'].join('_'),
    ['close', 'data'].join('_'),
    ['on', 'open', 'frame'].join('_'),
    ['on', 'close', 'frame'].join('_'),
    ['core.yijinjing.writer', 'split-frame-api'].join('-'),
  ];
  const findings = [];
  for (const relative of git([
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
  ]).split('\n')) {
    if (
      !relative ||
      relative === negativeGuard ||
      relative === 'scripts/source-acceptance.mjs' ||
      GENERATED_EVIDENCE_ROOTS.some((root) => relative.startsWith(root)) ||
      !textFile.test(relative)
    )
      continue;
    const content = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    for (const token of forbidden) {
      if (content.includes(token))
        findings.push(`${relative}: forbidden ${token}`);
    }
  }

  const contracts = [
    [
      'framework/core/src/libyijinjing/include/kungfu/yijinjing/journal/journal.h',
      'void write_bytes(int64_t trigger_time, int32_t carrier_type, std::span<const std::byte> data);',
      'canonical span overload is absent',
    ],
    [
      'framework/core/src/bindings/python/binding/py-runtime.cpp',
      'py::buffer payload',
      'Python write_bytes must accept one bytes-like buffer',
    ],
    [
      'framework/core/stubs/pykungfu/runtime.pyi',
      'payload: typing_extensions.Buffer',
      'typing must carry the payload extent',
    ],
  ];
  for (const [relative, required, message] of contracts) {
    if (!fs.readFileSync(path.join(ROOT, relative), 'utf8').includes(required))
      findings.push(`${relative}: ${message}`);
  }
  const uniqueBindings = [
    [
      'framework/core/src/bindings/python/binding/py-runtime.cpp',
      /"write_bytes"/gu,
      'Python must expose exactly one write_bytes binding',
    ],
    [
      'framework/core/stubs/pykungfu/runtime.pyi',
      /def write_bytes\(/gu,
      'typing must expose exactly one write_bytes signature',
    ],
  ];
  for (const [relative, pattern, message] of uniqueBindings) {
    const content = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    if ((content.match(pattern) || []).length !== 1)
      findings.push(`${relative}: ${message}`);
  }
  if (findings.length)
    throw new Error(
      `yijinjing writer interface check failed:\n${findings.map((finding) => `- ${finding}`).join('\n')}`,
    );
}

const KFD_REBASE_EQUIVALENCE_ANCESTOR_LIMIT = 4096;

function findFirstParentTreeEquivalent(sourceTree, headSha, gitRead) {
  for (const line of gitRead([
    'log',
    '--first-parent',
    `--max-count=${KFD_REBASE_EQUIVALENCE_ANCESTOR_LIMIT}`,
    '--format=%H %T',
    headSha,
  ]).split('\n')) {
    const [commitSha, treeSha] = line.trim().split(/\s+/u);
    if (treeSha === sourceTree) return commitSha;
  }
  return '';
}

function findFirstParentPatchEquivalent(
  sourceSha,
  baseParent,
  candidateParent,
  gitRead,
) {
  const sourceBase = gitRead(['merge-base', sourceSha, candidateParent]);
  if (!/^[0-9a-f]{40}$/u.test(sourceBase)) return '';
  const sourcePatch = gitRead([
    'diff',
    '--binary',
    '--full-index',
    '--no-renames',
    sourceBase,
    sourceSha,
    '--',
  ]);
  if (!sourcePatch) return '';

  const candidates = gitRead([
    'log',
    '--first-parent',
    `--max-count=${KFD_REBASE_EQUIVALENCE_ANCESTOR_LIMIT}`,
    '--format=%H',
    candidateParent,
  ])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const baseIndex = candidates.indexOf(baseParent);
  if (baseIndex < 0) return '';
  for (const commitSha of candidates.slice(0, baseIndex)) {
    const replayPatch = gitRead([
      'diff',
      '--binary',
      '--full-index',
      '--no-renames',
      baseParent,
      commitSha,
      '--',
    ]);
    if (replayPatch === sourcePatch) return commitSha;
  }
  return '';
}

export function githubMergeGroupCoordinates(
  env = process.env,
  readFile = fs.readFileSync,
) {
  if (env.GITHUB_EVENT_NAME !== 'merge_group' || !env.GITHUB_EVENT_PATH)
    return null;
  try {
    const event = JSON.parse(readFile(env.GITHUB_EVENT_PATH, 'utf8'));
    const baseSha = String(event?.merge_group?.base_sha || '');
    const headSha = String(event?.merge_group?.head_sha || '');
    if (!/^[0-9a-f]{40}$/u.test(baseSha) || !/^[0-9a-f]{40}$/u.test(headSha))
      return null;
    return { baseSha, headSha };
  } catch {
    return null;
  }
}

export function findGitTreeEquivalentAncestor(
  sourceSha,
  headSha,
  gitRead = gitMaybe,
  mergeGroup = githubMergeGroupCoordinates(),
) {
  if (gitRead(['cat-file', '-t', sourceSha]) !== 'commit') return '';
  const sourceTree = gitRead(['rev-parse', `${sourceSha}^{tree}`]);
  if (!/^[0-9a-f]{40}$/u.test(sourceTree)) return '';

  const directMatch = findFirstParentTreeEquivalent(
    sourceTree,
    headSha,
    gitRead,
  );
  if (directMatch) return directMatch;

  // GitHub tests a pull request through a synthetic two-parent merge commit.
  // Its first parent is the protected base, so a first-parent-only lookup
  // cannot see a tree-equivalent commit retained on the candidate branch. Only
  // enter the candidate parent when it has the exact checked merge tree; a
  // conflict-resolved or otherwise changed merge remains ineligible.
  const [mergeSha, baseParent, candidateParent, ...extraParents] = gitRead([
    'rev-list',
    '--parents',
    '-n',
    '1',
    headSha,
  ])
    .trim()
    .split(/\s+/u);

  // GitHub merge queue currently emits a linear replay rather than the
  // historical two-parent synthetic merge. Trust that shape only when the
  // merge_group event binds this exact checked head and protected base, then
  // require the same bounded byte-for-byte cumulative patch equivalence used
  // for the synthetic form. Ordinary local and PR checkouts cannot enter this
  // path by merely resembling a replay graph.
  if (
    mergeSha === headSha &&
    baseParent &&
    !candidateParent &&
    mergeGroup?.headSha === headSha &&
    /^[0-9a-f]{40}$/u.test(mergeGroup.baseSha)
  ) {
    return findFirstParentPatchEquivalent(
      sourceSha,
      mergeGroup.baseSha,
      headSha,
      gitRead,
    );
  }
  if (
    mergeSha !== headSha ||
    !baseParent ||
    !candidateParent ||
    extraParents.length > 0
  )
    return '';
  const headTree = gitRead(['rev-parse', `${headSha}^{tree}`]);
  const candidateTree = gitRead(['rev-parse', `${candidateParent}^{tree}`]);
  if (headTree !== candidateTree) return '';
  const treeMatch = findFirstParentTreeEquivalent(
    sourceTree,
    candidateParent,
    gitRead,
  );
  if (treeMatch) return treeMatch;

  // A protected base may advance in unrelated paths while GitHub exactly
  // replays the candidate's Project Cut. The whole trees then differ even
  // though the cumulative binary patch is byte-for-byte identical. Admit only
  // a bounded first-parent candidate whose complete patch from the protected
  // base exactly matches sourceSha's complete patch from their merge base.
  return findFirstParentPatchEquivalent(
    sourceSha,
    baseParent,
    candidateParent,
    gitRead,
  );
}

export function assertKfdEvidenceSourceBinding({
  sourceSha,
  headSha,
  isAncestor,
  findTreeEquivalentAncestor = () => '',
}) {
  const gitSha = /^[0-9a-f]{40}$/u;
  if (!gitSha.test(sourceSha) || !gitSha.test(headSha)) {
    throw new Error(
      `KFD evidence requires exact 40-hex Git coordinates, got source=${sourceSha || '<empty>'} head=${headSha || '<empty>'}`,
    );
  }
  if (
    !isAncestor(sourceSha, headSha) &&
    !gitSha.test(findTreeEquivalentAncestor(sourceSha, headSha))
  ) {
    throw new Error(
      `KFD evidence source ${sourceSha} is not an ancestor of checked head ${headSha} and has no exact protected-replay equivalent ancestor; regenerate the evidence after rebasing`,
    );
  }
  return sourceSha;
}

export function selectKfdEvidenceSourceSha({
  write,
  configured,
  committed,
  headSha,
}) {
  if (write) return configured || headSha;
  return committed || configured;
}

export function resolveKfdProductGateCheckedAt({
  write,
  now,
  retainedGateResults,
  sourceSha,
  commitTimestamp,
}) {
  if (write) return now();
  for (const gate of retainedGateResults) {
    const checkedAt = String(gate?.checkedAt || '');
    if (checkedAt) return checkedAt;
  }
  const checkedAt = commitTimestamp(sourceSha);
  if (!checkedAt || Number.isNaN(Date.parse(checkedAt))) {
    throw new Error(
      `KFD product-gate evidence cannot resolve a checkedAt timestamp for ${sourceSha}`,
    );
  }
  return checkedAt;
}

/**
 * @param {string[]} files
 * @param {string} [evidenceBaseCommit]
 * @param {string[]} [deletedFiles]
 */
export function sourceAcceptancePlan(
  files,
  evidenceBaseCommit = '',
  deletedFiles = [],
) {
  const deleted = new Set(deletedFiles);
  const materialFiles = files.filter((file) => !deleted.has(file));
  const settlementPublicationPresent = fs.existsSync(
    path.join(ROOT, 'framework/project-cut/publication.contract.json'),
  );
  const coldReadOnlySourceAcceptance =
    process.env.KUNGFU_READONLY_NESTED_SOURCE_ACCEPTANCE === '1';
  const nodeChecks = [
    ['no Bash scripts', 'scripts/no-bash-guard.mjs'],
    ['Shifu entry contract', 'scripts/check-shifu-entry-contract.mjs'],
    ['Shifu cache contract', 'scripts/check-shifu-cache-contract.mjs'],
    ...(coldReadOnlySourceAcceptance
      ? []
      : [
          [
            'Shifu Production Graph contract',
            'framework/production-graph/check.mjs',
          ],
        ]),
    [
      'Shifu Documentation Protocol',
      'scripts/check-shifu-documentation-contract.mjs',
    ],
    ...(coldReadOnlySourceAcceptance
      ? []
      : [
          [
            'documentation material lane',
            'scripts/run-documentation-material-tests.mjs',
          ],
        ]),
    [
      'read-only source and Agent route inventory',
      'scripts/check-readonly-source-routes.mjs',
    ],
    ['Shifu Gate contract', 'scripts/check-shifu-gate-contract.mjs'],
    ['Kungfu Gate catalog', 'scripts/check-kungfu-gate-catalog.mjs'],
    ['Xinfa standalone boundary', 'crates/xinfa/tooling/check-boundary.mjs'],
    ['carrier/action envelope', 'scripts/check-carrier-action-envelope.mjs'],
    ['runtime greenfield', 'scripts/check-runtime-greenfield.mjs'],
    ['trademark public-use gate', 'scripts/check-trademark-public-use.mjs'],
    [
      'Alpha attention operations',
      'scripts/check-alpha-attention-operations.mjs',
    ],
    [
      'community health baseline',
      'scripts/check-community-health-baseline.mjs',
    ],
    ['npm Release package registry', 'scripts/check-npm-package-registry.mjs'],
    [
      'component distribution boundary',
      'scripts/check-npm-package-registry.mjs',
      '--component-distribution',
    ],
    ['schema authority', 'scripts/check-schema-authority.mjs'],
    [
      'Project Work Agent first-layer product model',
      'scripts/check-project-work-agent-product.test.mjs',
    ],
    ['incubation passport governance', 'scripts/check-incubation-passport.mjs'],
    [
      'Hub Starter Docker concept',
      'scripts/check-hub-starter-docker-concept.mjs',
    ],
    [
      'primitive catalog projection',
      'scripts/generate-primitive-catalog.mjs',
      '--check',
    ],
    [
      'Primitive authority consumption closure',
      'scripts/check-primitive-authority-boundary.mjs',
    ],
    [
      'core architecture contract',
      'framework/core/architecture/check-layers.mjs',
    ],
    [
      'core architecture negative fixtures',
      'framework/core/architecture/check-layers.mjs',
      '--self-test',
    ],
    ['code complexity budget ratchet', 'scripts/code-complexity-budget.mjs'],
    [
      'changed-code function-risk ratchet and advisory projection',
      'framework/maintainability/function-risk-ratchet.mjs',
      '--base',
      evidenceBaseCommit,
    ],
    ...(coldReadOnlySourceAcceptance
      ? []
      : [
          [
            'Python structure boundary ratchet',
            'scripts/check-code-complexity.mjs',
          ],
        ]),
    [
      'semantic amplification and task graph',
      'framework/maintainability/semantic-amplification.mjs',
      '--check',
    ],
    [
      'core architecture query and health contract',
      'framework/core/architecture/query-health.mjs',
    ],
    [
      'core architecture query negative and navigation fixtures',
      'framework/core/architecture/query-health.mjs',
      '--self-test',
    ],
    [
      'core build capability contract',
      'framework/core/architecture/check-build-capabilities.mjs',
    ],
    [
      'core build capability negative fixtures',
      'framework/core/architecture/check-build-capabilities.mjs',
      '--self-test',
    ],
    [
      'core affected-native negative fixtures',
      'scripts/run-core-affected-native.mjs',
      '--self-test',
    ],
    [
      'journal authority boundary',
      'scripts/check-journal-authority-boundary.mjs',
    ],
    ['live runtime terminology', 'scripts/check-live-runtime-terminology.mjs'],
    ['runtime activation contract', 'scripts/check-runtime-contract.mjs'],
    ['runtime upgrade contract', 'scripts/check-upgrade-contract.mjs'],
    [
      'product upgrade qualification',
      'scripts/check-upgrade-qualification.mjs',
    ],
    ['agent session contract', 'scripts/check-agent-session-contract.mjs'],
    ['CLI catalog parity', 'scripts/check-cli-catalog-parity.mjs'],
    [
      'KFX Site Bundle impact dispositions',
      'framework/site/tooling/check-kfx-site-impact.mjs',
      ...(evidenceBaseCommit ? ['--base', evidenceBaseCommit] : []),
      ...files.flatMap((file) => ['--changed-file', file]),
    ],
    [
      'deprecation lifecycle authority',
      'framework/deprecation/deprecation-lifecycle.mjs',
      '--as-of',
      '2026-07-29',
    ],
    ...(files.length
      ? [
          [
            'changed deprecation surface enrollment',
            'framework/deprecation/deprecation-lifecycle.mjs',
            '--as-of',
            '2026-07-29',
            ...files.flatMap((file) => ['--changed-file', file]),
          ],
        ]
      : []),
    ['Project Cut contract', 'scripts/check-project-cut-contract.mjs'],
    [
      'Project Cut settlement contract',
      'scripts/check-project-cut-settlement.mjs',
    ],
    ['Project Cut history contract', 'scripts/check-project-cut-history.mjs'],
    [
      'Work history selector contract',
      'framework/work-history-selector/tooling/check-work-history-selector.mjs',
    ],
    [
      'Work design advisor contract',
      'framework/work-design-advisor/tooling/check-work-design-advisor.mjs',
    ],
    [
      'Work design policy replay contract',
      'framework/work-design-policy-replay/tooling/check-work-design-policy-replay.mjs',
    ],
    [
      'Work design work-design contract',
      'framework/work-design-preflight/tooling/check-work-design-preflight.mjs',
    ],
    [
      'Project Cut composition contract',
      'scripts/check-project-cut-composition.mjs',
    ],
    ...(settlementPublicationPresent
      ? [
          [
            'Project Cut settlement publication contract',
            'framework/project-cut/bin/project-cut.mjs',
            'publication-contract-check',
            '--json',
          ],
        ]
      : []),
    [
      'Project Cut scoped composition admission',
      'scripts/check-project-cut-composition-gate.mjs',
    ],
    [
      'workspace continuation contract',
      'scripts/check-workspace-continuation.mjs',
    ],
    [
      'Episode Admission contract',
      'scripts/check-episode-admission-contract.mjs',
    ],
    [
      'durability production-candidate admission',
      'scripts/check-durability-production-candidate.mjs',
    ],
    [
      'Buildchain KFD release evidence',
      'scripts/buildchain-kfd-evidence.mjs',
      '--check',
    ],
    [
      'Work Profile conformance gate',
      'framework/work-profile-conformance/work-profile-conformance.mjs',
      '--check',
      '--json',
    ],
    ...(coldReadOnlySourceAcceptance
      ? []
      : [
          [
            'agent-first canonical policy',
            'developer/sdk/src/sdk.js',
            'contract',
            'policy',
            '--check',
            '--json',
          ],
          [
            'agent-first contract audit',
            'developer/sdk/src/sdk.js',
            'contract',
            'audit',
            '--json',
          ],
        ]),
    [
      'KFD-4 perspective qualification',
      'framework/core/tests/qualification/kfd4-perspective.mjs',
    ],
    [
      'release publication control plane',
      'framework/release/publication-control-plane.mjs',
      'check',
    ],
    [
      'version-line authority',
      'framework/version-line/check-version-line-authority.mjs',
    ],
    ['KFD support matrix', 'scripts/kfd-support-matrix.mjs', '--check'],
    [
      'Darwin x64 retirement policy',
      'scripts/platform-command.mjs',
      '--check-darwin-x64-retirement',
    ],
    [
      'KFD support matrix negative fixtures',
      '--test',
      'scripts/kfd-support-matrix.test.mjs',
    ],
    [
      'KFD-4 perspective qualification negative fixtures',
      '--test',
      'scripts/kfd4-perspective-qualification.test.mjs',
    ],
    [
      'Native component version sync',
      'scripts/sync-shifu-version.mjs',
      '--check',
    ],
    ['layered SDK projections', 'scripts/generate-layered-sdk.mjs', '--check'],
    [
      'Work lifecycle matrix materialization',
      'scripts/materialize-work-lifecycle-operation-matrix.mjs',
      '--check',
    ],
    [
      'Work lifecycle SDK projections',
      'scripts/generate-work-lifecycle-sdk.mjs',
      '--check',
    ],
    [
      'registry envelope projections',
      'scripts/registry-envelope.mjs',
      '--check',
    ],
    ['documentation contracts', 'scripts/run-docs-source-check.mjs'],
  ];
  /** @type {Command[]} */
  const plan = [
    { label: 'diff hygiene', command: 'git', args: ['diff', '--check'] },
    ...nodeChecks.map(([label, ...args]) => ({
      label,
      command: process.execPath,
      args,
      env:
        evidenceBaseCommit &&
        (label === 'documentation contracts' ||
          label === 'code complexity budget ratchet')
          ? {
              ...(label === 'documentation contracts'
                ? {
                    KUNGFU_ADR_EVIDENCE_BASE_SHA: evidenceBaseCommit,
                    KUNGFU_EVOLUTION_BASE: evidenceBaseCommit,
                  }
                : {}),
              ...(label === 'code complexity budget ratchet'
                ? { KUNGFU_COMPLEXITY_PROTECTED_REF: evidenceBaseCommit }
                : {}),
            }
          : undefined,
    })),
    ...(coldReadOnlySourceAcceptance
      ? []
      : [
          {
            label: 'source-acceptance contract tests',
            command: process.execPath,
            args: [
              '--test',
              'scripts/buildchain-install.test.mjs',
              'scripts/run-shifu-lifecycle.test.mjs',
              'scripts/check-typescript-files.test.mjs',
              'scripts/source-acceptance-git.test.mjs',
              'scripts/source-acceptance-kfd-runtime.test.mjs',
              'scripts/source-acceptance.test.mjs',
              'scripts/platform-command.test.mjs',
              'product/scripts/dist.test.mjs',
              'product/scripts/finalize-macos-release-artifacts.test.mjs',
              'product/scripts/dist-cli-executable-layout.test.mjs',
              'product/scripts/installed-kungfu/index.test.mjs',
              'scripts/opencode-local-model-canary-workflow.test.mjs',
              'scripts/kungfu-workflow-authority.test.mjs',
              'scripts/code-complexity-budget.test.mjs',
              'scripts/check-code-complexity.test.mjs',
              'framework/report-projection/authority.test.mjs',
              'framework/maintainability/function-risk.test.mjs',
              'framework/maintainability/semantic-amplification.test.mjs',
              'framework/maintainability/terminal-evidence-matrix.test.mjs',
              ...(coldReadOnlySourceAcceptance
                ? []
                : ['scripts/readonly-agent-bootstrap.test.mjs']),
              'scripts/check-readonly-source-routes.test.mjs',
              'scripts/check-shifu-entry-contract.test.mjs',
              'scripts/check-shifu-cache-contract.test.mjs',
              ...(coldReadOnlySourceAcceptance
                ? []
                : ['framework/production-graph/check.test.mjs']),
              'scripts/check-health-diagnostics-contract.test.mjs',
              'scripts/shifu-cache-runtime.test.mjs',
              'scripts/shifu-conan-hit-evidence.test.mjs',
              'scripts/shifu-conan-legacy.test.mjs',
              'scripts/shifu-conan-publish.test.mjs',
              'scripts/shifu-uv-cache-adapter.test.mjs',
              'scripts/shifu-gate-runtime.test.mjs',
              'scripts/shifu-gate-executor.test.mjs',
              'scripts/shifu-documentation-runtime.test.mjs',
              'scripts/shifu-documentation-surfaces.test.mjs',
              'scripts/shifu-documentation-consumers.test.mjs',
              'scripts/kungfu-xinfa-consumer.test.mjs',
              'scripts/check-kungfu-gate-catalog.test.mjs',
              'scripts/linux-arm64-alpha-qualification-workflow.test.mjs',
              'scripts/affected-native-proof.test.mjs',
              'scripts/affected-native-semantic-source.test.mjs',
              'scripts/qualified-assignment-core-artifact.test.mjs',
              'scripts/assemble-kungfu-publication-gate.test.mjs',
              'scripts/verify-kungfu-release-admission.test.mjs',
              'scripts/release-publication-control-plane.test.mjs',
              'scripts/version-line-authority.test.mjs',
              'crates/xinfa/tooling/check-boundary.test.mjs',
              'scripts/check-schema-authority.test.mjs',
              'scripts/check-incubation-passport.test.mjs',
              'scripts/check-hub-starter-docker-concept.test.mjs',
              'scripts/check-canonical-json.test.mjs',
              'scripts/check-primitive-catalog.test.mjs',
              'scripts/check-primitive-authority-boundary.test.mjs',
              'scripts/check-runtime-contract.test.mjs',
              'scripts/check-trademark-public-use.test.mjs',
              'scripts/prepare-ungfu-release-evidence.test.mjs',
              'scripts/check-npm-package-registry.test.mjs',
              'scripts/npm-release-inventory.test.mjs',
              'scripts/check-upgrade-contract.test.mjs',
              'scripts/probe-cpp-cmake-contract.test.mjs',
              'scripts/check-upgrade-qualification.test.mjs',
              'scripts/check-agent-session-contract.test.mjs',
              'scripts/check-cli-catalog-parity.test.mjs',
              'scripts/check-kfx-site-impact.test.mjs',
              'framework/deprecation/deprecation-surface-discovery.test.mjs',
              'scripts/check-fact-cut-kernel-contract.test.mjs',
              'scripts/check-temporal-relation-contract.test.mjs',
              'scripts/check-release-provenance-object.test.mjs',
              'scripts/check-data-protection-contract.test.mjs',
              'scripts/check-durable-history-qualification.test.mjs',
              'scripts/check-durable-provenance-authority.test.mjs',
              'scripts/check-work-agent-history-continuity.test.mjs',
              'scripts/check-project-cut-dogfood-history.test.mjs',
              'scripts/check-exit-bundle-contract.test.mjs',
              'scripts/check-fact-root-canonical.test.mjs',
              'scripts/kungfu-invariant.test.mjs',
              'scripts/check-evidence-envelope.test.mjs',
              'scripts/check-kfd7-library-boundary.test.mjs',
              'scripts/check-layered-api-encoding-boundary.test.mjs',
              'scripts/check-work-lifecycle-native.test.mjs',
              'scripts/check-work-lifecycle-operation-matrix.test.mjs',
              'framework/work-profile-conformance/work-profile-conformance.test.mjs',
              'scripts/check-project-work-agent-product.test.mjs',
              'scripts/registry-envelope.test.mjs',
              'scripts/check-kfd-agent-runtime-boundary.mjs',
              'scripts/check-fact-root-canonical.test.mjs',
              'scripts/check-project-cut-contract.test.mjs',
              'scripts/check-git-episode-provider.test.mjs',
              'scripts/check-project-cut-settlement.test.mjs',
              'scripts/check-project-cut-history.test.mjs',
              'scripts/check-work-history-selector.test.mjs',
              'scripts/check-work-design-advisor.test.mjs',
              'scripts/check-work-design-policy-replay.test.mjs',
              'scripts/check-work-design-preflight.test.mjs',
              'scripts/check-project-cut-composition.test.mjs',
              ...(settlementPublicationPresent
                ? ['scripts/check-project-cut-publication.test.mjs']
                : []),
              'scripts/project-cut-merge-queue-admission.test.mjs',
              'scripts/check-workspace-continuation.test.mjs',
              'framework/assignment-capture/assignment-capture.test.mjs',
              'scripts/run-continuity-pilot.test.mjs',
              'scripts/check-episode-admission-contract.test.mjs',
              'framework/agent-session/tests/capsule-host.test.mjs',
              'framework/agent-session/tests/peer-transport.test.mjs',
              'framework/agent-session/tests/runtime-port.test.mjs',
              'framework/agent-session/tests/provider-adapters.test.mjs',
              'framework/agent-session/tests/interaction-port.test.mjs',
              'framework/agent-session/tests/codex-app-server-contract.test.mjs',
              'framework/agent-session/tests/codex-app-server-interaction.test.mjs',
              'framework/agent-session/tests/codex-app-server-recovery.test.mjs',
              'framework/agent-session/tests/codex-app-server-runtime.test.mjs',
              'framework/agent-session/tests/codex-app-server-product.test.mjs',
              'framework/agent-session/tests/product-surface.test.mjs',
              'framework/agent-session/tests/product-detached-host.test.mjs',
              'extensions/terminal/tests/agent-session-snapshot.test.ts',
              'framework/core/tests/qualification/runtime-activation/run.test.mjs',
              'framework/core/tests/qualification/durability/run.test.mjs',
              'framework/core/tests/qualification/durability/powercut_plan.test.mjs',
              'framework/core/tests/qualification/durability/fault_campaign.test.mjs',
              'framework/core/tests/qualification/durability/candidate_evidence.test.mjs',
              'framework/core/tests/qualification/durability/retained_evidence.test.mjs',
              'framework/core/tests/qualification/durability/institutional_evidence.test.mjs',
              'framework/core/tests/qualification/durability/product_contract.test.mjs',
              'framework/core/tests/qualification/durability/slo_evidence.test.mjs',
              'framework/core/tests/qualification/durability/offhost_evidence.test.mjs',
              'framework/core/tests/qualification/durability/clean_restart_evidence.test.mjs',
              'framework/core/tests/qualification/durability/production_candidate_admission.test.mjs',
              'scripts/run-durability-powercut-qemu.test.mjs',
              'scripts/prepare-durability-powercut-qemu.test.mjs',
              'scripts/run-durability-fault-campaign.test.mjs',
              'scripts/run-durability-institutional-qemu.test.mjs',
              'scripts/run-durability-slo.test.mjs',
              'scripts/run-durability-offhost-restore.test.mjs',
              'scripts/run-durability-clean-host-restart.test.mjs',
            ],
          },
        ]),
    {
      label: 'Phase B package identity contract tests',
      command: 'python3',
      args: [
        '-B',
        '-m',
        'unittest',
        'scripts.test_prepare_kungfu_phase_b_package',
      ],
    },
    ...(coldReadOnlySourceAcceptance
      ? []
      : [
          {
            label: 'agent work state contract and CLI parity',
            command: process.execPath,
            args: ['scripts/run-agent-work-state-tests.mjs'],
          },
          {
            label: 'runtime upgrade control-plane tests',
            command: process.execPath,
            args: ['scripts/run-runtime-upgrade-tests.mjs'],
          },
          {
            label: 'desktop update adapter tests',
            command: process.execPath,
            args: ['scripts/run-desktop-update-tests.mjs'],
          },
        ]),
    ...(coldReadOnlySourceAcceptance
      ? []
      : [
          {
            label: 'tooling type check',
            command: process.execPath,
            args: [
              'node_modules/typescript/bin/tsc',
              '-p',
              'tsconfig.tools.json',
            ],
          },
        ]),
  ];

  if (coldReadOnlySourceAcceptance) {
    const nestedContractIndex = plan.findIndex(
      (step) => step.label === 'source-acceptance contract tests',
    );
    if (nestedContractIndex >= 0) plan.splice(nestedContractIndex, 1);
  }

  const web = materialFiles.filter(
    (file) =>
      WEB.test(file) &&
      !GENERATED_EVIDENCE_ROOTS.some((root) => file.startsWith(root)),
  );
  if (web.length) {
    plan.push({
      label: 'changed web source format and lint',
      command: process.execPath,
      args: [
        process.env.KUNGFU_READONLY_BIOME ||
          'node_modules/@biomejs/biome/bin/biome',
        'check',
        '--no-errors-on-unmatched',
        ...web,
      ],
    });
  }

  const guiTypeScript = materialFiles.filter(
    (file) => file.startsWith('framework/gui/src/') && /\.tsx?$/.test(file),
  );
  if (guiTypeScript.length && !coldReadOnlySourceAcceptance) {
    plan.push({
      label: 'changed GUI TypeScript check',
      command: process.execPath,
      args: [
        'scripts/check-typescript-files.mjs',
        '--project',
        'framework/gui/tsconfig.json',
        ...guiTypeScript,
      ],
    });
  }

  const python = materialFiles.filter((file) => file.endsWith('.py'));
  if (python.length) {
    const format = sourcePythonCommand([
      'format',
      '--no-cache',
      '--config',
      RUFF_CONFIG,
      '--check',
      '--force-exclude',
      ...python,
    ]);
    const lint = sourcePythonCommand([
      'check',
      '--no-cache',
      '--config',
      RUFF_CONFIG,
      '--force-exclude',
      ...python,
    ]);
    plan.push(
      {
        label: 'changed Python format',
        ...format,
      },
      {
        label: 'changed Python lint',
        ...lint,
      },
    );
  }

  const typedPython = python.filter((file) =>
    TYPED_PYTHON_ROOTS.some((root) => file.startsWith(root)),
  );
  if (typedPython.length && !coldReadOnlySourceAcceptance) {
    const mypy = sourceMypyCommand(['--config-file', 'pyproject.toml']);
    plan.push({
      label: 'Python type baseline',
      ...mypy,
      cwd: path.join(ROOT, 'framework/core'),
    });
  }

  const cpp = materialFiles.filter((file) => CPP.test(file));
  if (cpp.length) {
    const formatter = sourceClangFormatCommand([
      '-style=file',
      '--dry-run',
      '-Werror',
      ...cpp,
    ]);
    plan.push({
      label: 'changed C/C++ format',
      ...formatter,
    });
  }
  return plan;
}

const SOURCE_ACCEPTANCE_RUNTIME_ENV = [
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'COREPACK_HOME',
  'COREPACK_ENABLE_DOWNLOAD_PROMPT',
  'PNPM_HOME',
  'npm_config_cache',
  'NPM_CONFIG_CACHE',
  'UV_CACHE_DIR',
  'RUFF_CACHE_DIR',
  'MYPY_CACHE_DIR',
  'SHIFU_CACHE_RECEIPT',
  'KUNGFU_SOURCE_ACCEPTANCE_RUNTIME_ROOT',
];

export function sourceAcceptanceChildEnv(sourceEnv, stepEnv = {}) {
  const childEnv = { ...sourceEnv, ...stepEnv };
  for (const key of SOURCE_ACCEPTANCE_RUNTIME_ENV) {
    if (sourceEnv[key] !== undefined) childEnv[key] = sourceEnv[key];
  }
  return childEnv;
}

/**
 * @param {Command} step
 * @param {NodeJS.ProcessEnv} sourceEnv
 * @param {typeof spawnSync} spawn
 */
export function runSourceAcceptanceStep(
  step,
  sourceEnv = process.env,
  spawn = spawnSync,
) {
  console.log(`\n[source-acceptance] ${step.label}`);
  console.log(`[source-acceptance] $ ${step.command} ${step.args.join(' ')}`);
  const result = spawn(step.command, step.args, {
    cwd: step.cwd || ROOT,
    env: sourceAcceptanceChildEnv(sourceEnv, step.env),
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${step.label} failed: ${result.error?.message || result.status}; owner=${SOURCE_ACCEPTANCE_RUNTIME_OWNER}; recovery=${SOURCE_ACCEPTANCE_RECOVERY}`,
    );
  }
  if (process.env.KUNGFU_READONLY_NESTED_SOURCE_ACCEPTANCE === '1') {
    const homeEntries = fs.readdirSync(process.env.HOME || '');
    if (homeEntries.length) {
      throw new Error(
        `${step.label} wrote into HOME: ${homeEntries.join(', ')}`,
      );
    }
  }
}

function main() {
  const before = sourceCheckoutSnapshot(ROOT);
  const runtime = prepareSourceAcceptanceRuntime(ROOT);
  console.log(
    `[source-acceptance] trackedTreeRoot=${before.trackedTreeRoot} untrackedInventoryRoot=${before.untrackedInventoryRoot}`,
  );
  let failure;
  try {
    const files = sourceChangedFiles();
    console.log(`[source-acceptance] changed files: ${files.length}`);
    if (process.env.KUNGFU_READONLY_NESTED_SOURCE_ACCEPTANCE !== '1') {
      assertYijinjingWriterInterface();
      console.log('[source-acceptance] yijinjing writer interface passed');
    }
    const devChannels = checkDevChannelAuthority();
    console.log(
      `\n[source-acceptance] dev channel authority\n${JSON.stringify(devChannels, null, 2)}`,
    );
    if (devChannels.verdict !== 'pass')
      throw new Error('dev channel authority failed');
    if (process.env.KUNGFU_READONLY_NESTED_SOURCE_ACCEPTANCE === '1') {
      console.warn(
        '[source-acceptance] cold read-only lane: the installed TypeScript dependency graph is absent; normal source acceptance and CI enforce tooling type checks.',
      );
    }
    const deletedFiles = files.filter(
      (file) => !fs.existsSync(path.join(ROOT, file)),
    );
    for (const step of sourceAcceptancePlan(
      files,
      sourceMergeBase().sha,
      deletedFiles,
    ))
      runSourceAcceptanceStep(step, runtime.env);
  } catch (error) {
    failure = error;
  } finally {
    try {
      const after = sourceCheckoutSnapshot(ROOT);
      assertSourceCheckoutUnchanged(before, after);
      console.log(
        `[source-acceptance] zero-write trackedTreeRoot=${after.trackedTreeRoot} untrackedInventoryRoot=${after.untrackedInventoryRoot}`,
      );
    } finally {
      runtime.cleanup();
    }
  }
  if (failure) throw failure;
  console.log('\n[source-acceptance] build-free source gate passed');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(
      `[source-acceptance] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
