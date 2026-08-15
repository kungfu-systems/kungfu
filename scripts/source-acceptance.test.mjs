// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveGitBoundKfdEvidenceSourceSha } from '../framework/release/buildchain-kfd-runtime.mjs';
import { scanTree } from './no-bash-guard.mjs';
import {
  SOURCE_ACCEPTANCE_RUNTIME_OWNER,
  assertExternalSourceAcceptanceTarget,
  prepareSourceAcceptanceRuntime,
} from './readonly-source-toolchain.mjs';
import {
  assertKfdEvidenceSourceBinding,
  findGitTreeEquivalentAncestor,
  githubMergeGroupCoordinates,
  isLocalQualificationRuntime,
  resolveKfdProductGateCheckedAt,
  runSourceAcceptanceStep,
  selectKfdEvidenceSourceSha,
  sourceAcceptanceChildEnv,
  sourceAcceptancePlan,
  sourceClangFormatCommand,
  sourceMypyCommand,
  sourcePythonCommand,
} from './source-acceptance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('source acceptance owns one external runtime for every writable tool surface', (t) => {
  const runtime = prepareSourceAcceptanceRuntime(ROOT);
  t.after(runtime.cleanup);
  assert.equal(runtime.owner, SOURCE_ACCEPTANCE_RUNTIME_OWNER);
  if (process.platform !== 'win32') {
    assert.equal(
      runtime.runtimeRoot.startsWith('/private/tmp/kf-sa-') ||
        runtime.runtimeRoot.startsWith('/tmp/kf-sa-'),
      true,
    );
    assert.equal(runtime.env.TMPDIR.length < 80, true);
  }
  for (const key of [
    'TMPDIR',
    'XDG_CACHE_HOME',
    'XDG_STATE_HOME',
    'COREPACK_HOME',
    'PNPM_HOME',
    'npm_config_cache',
    'UV_CACHE_DIR',
    'RUFF_CACHE_DIR',
    'MYPY_CACHE_DIR',
    'SHIFU_CACHE_RECEIPT',
  ]) {
    assert.doesNotThrow(() =>
      assertExternalSourceAcceptanceTarget(ROOT, runtime.env[key], key),
    );
  }
});

test('step overrides cannot escape the source-acceptance runtime', (t) => {
  const runtime = prepareSourceAcceptanceRuntime(ROOT);
  t.after(runtime.cleanup);
  const checkoutCache = path.join(ROOT, '_tmp_hostile_child_cache');
  const child = sourceAcceptanceChildEnv(runtime.env, {
    ...process.env,
    TMPDIR: checkoutCache,
    XDG_CACHE_HOME: checkoutCache,
    UV_CACHE_DIR: checkoutCache,
    RUFF_CACHE_DIR: checkoutCache,
    MYPY_CACHE_DIR: checkoutCache,
    SHIFU_CACHE_RECEIPT: path.join(checkoutCache, 'receipt.json'),
    KUNGFU_ADR_EVIDENCE_BASE_SHA: 'a'.repeat(40),
  });
  for (const key of [
    'TMPDIR',
    'XDG_CACHE_HOME',
    'UV_CACHE_DIR',
    'RUFF_CACHE_DIR',
    'MYPY_CACHE_DIR',
    'SHIFU_CACHE_RECEIPT',
  ]) {
    assert.equal(child[key].startsWith(runtime.runtimeRoot), true, key);
  }
  assert.equal(child.KUNGFU_ADR_EVIDENCE_BASE_SHA, 'a'.repeat(40));
  assert.equal(fs.existsSync(checkoutCache), false);
});

test('the executed child receives the protected runtime plus narrow overrides', (t) => {
  const runtime = prepareSourceAcceptanceRuntime(ROOT);
  t.after(runtime.cleanup);
  let captured;
  runSourceAcceptanceStep(
    {
      label: 'hostile child env fixture',
      command: 'fixture',
      args: [],
      env: {
        ...process.env,
        TMPDIR: path.join(ROOT, '_tmp_hostile_spawn'),
        UV_CACHE_DIR: path.join(ROOT, '.uv-cache'),
        KUNGFU_ADR_EVIDENCE_BASE_SHA: 'b'.repeat(40),
      },
    },
    runtime.env,
    (_command, _args, options) => {
      captured = options.env;
      return { status: 0 };
    },
  );
  assert.equal(captured.TMPDIR, runtime.env.TMPDIR);
  assert.equal(captured.UV_CACHE_DIR, runtime.env.UV_CACHE_DIR);
  assert.equal(captured.KUNGFU_ADR_EVIDENCE_BASE_SHA, 'b'.repeat(40));
  assert.equal(fs.existsSync(path.join(ROOT, '_tmp_hostile_spawn')), false);
  assert.equal(fs.existsSync(path.join(ROOT, '.uv-cache')), false);
});

test('repo-local temporary, cache, fixture, and nested task writers fail before mutation', (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-source-writer-denial-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const checkout = path.join(temporary, 'checkout');
  fs.mkdirSync(checkout);
  const sentinel = path.join(checkout, 'sentinel');
  fs.writeFileSync(sentinel, 'unchanged\n');
  for (const relative of [
    '_tmp_guard',
    '.buildchain/diagnostics/shifu-cache-resolution.json.tmp-1',
    '.pnpm-store/state.json',
    'generated-fixtures/result.json',
    'nested-task-output/receipt.json',
  ]) {
    assert.throws(
      () =>
        assertExternalSourceAcceptanceTarget(
          checkout,
          path.join(checkout, relative),
          relative,
        ),
      /owner=source-acceptance-runtime; recovery=/u,
    );
    assert.equal(fs.existsSync(path.join(checkout, relative)), false);
  }
  const checkoutAlias = path.join(temporary, 'checkout-alias');
  fs.symlinkSync(
    checkout,
    checkoutAlias,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(
    () =>
      assertExternalSourceAcceptanceTarget(
        checkout,
        path.join(checkoutAlias, 'aliased-output'),
        'aliased-output',
      ),
    /owner=source-acceptance-runtime; recovery=/u,
  );
  assert.equal(fs.existsSync(path.join(checkout, 'aliased-output')), false);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged\n');
});

test('no-bash guard ignores local Kungfu qualification runtimes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-no-bash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.kungfu/qualification/runtime'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, '.kungfu/qualification/runtime/vendor.sh'),
    '#!/bin/sh\n',
  );
  fs.writeFileSync(path.join(root, 'tracked.sh'), '#!/bin/sh\n');

  assert.deepEqual(scanTree(root), ['tracked.sh']);
});

test('source acceptance excludes only the local qualification runtime tree', () => {
  assert.equal(isLocalQualificationRuntime('.kungfu/qualification'), true);
  assert.equal(
    isLocalQualificationRuntime('.kungfu/qualification/runtime/vendor.cc'),
    true,
  );
  assert.equal(isLocalQualificationRuntime('.kungfu/episodes/a.json'), false);
  assert.equal(isLocalQualificationRuntime('docs/qualification/a.md'), false);
});

test('KFD evidence rejects a source SHA whose ancestry was removed by rebase', () => {
  assert.throws(
    () =>
      assertKfdEvidenceSourceBinding({
        sourceSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        isAncestor: () => false,
      }),
    /not an ancestor of checked head.*regenerate the evidence after rebasing/u,
  );
});

test('KFD evidence accepts an exact tree-equivalent ancestor after queue rebase', () => {
  const sourceSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const replayedSha = 'c'.repeat(40);
  assert.equal(
    assertKfdEvidenceSourceBinding({
      sourceSha,
      headSha,
      isAncestor: () => false,
      findTreeEquivalentAncestor: (source, head) => {
        assert.equal(source, sourceSha);
        assert.equal(head, headSha);
        return replayedSha;
      },
    }),
    sourceSha,
  );
});

test('KFD evidence runtime adapts the repository-bound Git reader for queue replay', () => {
  const sourceSha = 'a'.repeat(40);
  const resolved = resolveGitBoundKfdEvidenceSourceSha({
    root: ROOT,
    write: false,
    committed: sourceSha,
    configured: sourceSha,
    prepareHistory: () => {},
    selectSourceSha: () => sourceSha,
    assertBinding: ({
      sourceSha: selectedSourceSha,
      headSha,
      findTreeEquivalentAncestor,
    }) => {
      assert.equal(selectedSourceSha, sourceSha);
      assert.equal(
        findTreeEquivalentAncestor(selectedSourceSha, headSha),
        'c'.repeat(40),
      );
      return selectedSourceSha;
    },
    findTreeEquivalentAncestor: (selectedSourceSha, headSha, gitRead) => {
      assert.equal(selectedSourceSha, sourceSha);
      assert.match(headSha, /^[0-9a-f]{40}$/u);
      assert.equal(typeof gitRead, 'function');
      assert.equal(gitRead(['rev-parse', 'HEAD']), headSha);
      return 'c'.repeat(40);
    },
  });
  assert.equal(resolved, sourceSha);
});

test('KFD evidence checks the committed witness binding under an exact CI source', () => {
  const committed = 'a'.repeat(40);
  const configured = 'b'.repeat(40);
  assert.equal(
    selectKfdEvidenceSourceSha({
      write: false,
      configured,
      committed,
      headSha: configured,
    }),
    committed,
  );
  assert.equal(
    selectKfdEvidenceSourceSha({
      write: true,
      configured,
      committed,
      headSha: 'c'.repeat(40),
    }),
    configured,
  );
});

test('KFD tree-equivalence lookup stays first-parent and bounded', () => {
  const sourceSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const replayedSha = 'c'.repeat(40);
  const treeSha = 'd'.repeat(40);
  const calls = [];
  assert.equal(
    findGitTreeEquivalentAncestor(sourceSha, headSha, (args) => {
      calls.push(args);
      if (args[0] === 'cat-file') return 'commit';
      if (args[0] === 'rev-parse') return treeSha;
      return `${headSha} ${'e'.repeat(40)}\n${replayedSha} ${treeSha}`;
    }),
    replayedSha,
  );
  assert.deepEqual(calls, [
    ['cat-file', '-t', sourceSha],
    ['rev-parse', `${sourceSha}^{tree}`],
    ['log', '--first-parent', '--max-count=4096', '--format=%H %T', headSha],
  ]);
});

test('KFD tree-equivalence admits an unchanged GitHub PR merge candidate parent', () => {
  const sourceSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const baseParent = 'c'.repeat(40);
  const candidateParent = 'd'.repeat(40);
  const replayedSha = 'e'.repeat(40);
  const sourceTree = '1'.repeat(40);
  const checkedTree = '2'.repeat(40);
  const calls = [];
  assert.equal(
    findGitTreeEquivalentAncestor(sourceSha, headSha, (args) => {
      calls.push(args);
      if (args[0] === 'cat-file') return 'commit';
      if (args[0] === 'rev-list')
        return `${headSha} ${baseParent} ${candidateParent}`;
      if (args[0] === 'rev-parse') {
        if (args[1] === `${sourceSha}^{tree}`) return sourceTree;
        return checkedTree;
      }
      if (args.at(-1) === candidateParent)
        return `${candidateParent} ${checkedTree}\n${replayedSha} ${sourceTree}`;
      return `${headSha} ${checkedTree}\n${baseParent} ${'3'.repeat(40)}`;
    }),
    replayedSha,
  );
  assert.deepEqual(calls.slice(-2), [
    ['rev-parse', `${candidateParent}^{tree}`],
    [
      'log',
      '--first-parent',
      '--max-count=4096',
      '--format=%H %T',
      candidateParent,
    ],
  ]);
});

test('KFD equivalence admits an exact cumulative Project Cut replay on an advanced base', () => {
  const sourceSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const baseParent = 'c'.repeat(40);
  const candidateParent = 'd'.repeat(40);
  const replayedSha = 'e'.repeat(40);
  const sourceBase = 'f'.repeat(40);
  const sourceTree = '1'.repeat(40);
  const checkedTree = '2'.repeat(40);
  const exactPatch = 'diff --git a/runtime.cc b/runtime.cc\n+runtime client';
  assert.equal(
    findGitTreeEquivalentAncestor(sourceSha, headSha, (args) => {
      if (args[0] === 'cat-file') return 'commit';
      if (args[0] === 'rev-list')
        return `${headSha} ${baseParent} ${candidateParent}`;
      if (args[0] === 'rev-parse') {
        if (args[1] === `${sourceSha}^{tree}`) return sourceTree;
        return checkedTree;
      }
      if (args[0] === 'merge-base') return sourceBase;
      if (args[0] === 'diff') {
        if (args[5] === sourceSha || args[5] === replayedSha) return exactPatch;
        return 'different patch';
      }
      if (args.at(-1) === candidateParent && args.includes('--format=%H %T')) {
        return `${candidateParent} ${checkedTree}\n${replayedSha} ${'3'.repeat(40)}\n${baseParent} ${'4'.repeat(40)}`;
      }
      if (args.at(-1) === candidateParent && args.includes('--format=%H')) {
        return `${candidateParent}\n${replayedSha}\n${baseParent}`;
      }
      return `${headSha} ${checkedTree}\n${baseParent} ${'4'.repeat(40)}`;
    }),
    replayedSha,
  );
});

test('KFD equivalence rejects a changed cumulative Project Cut replay', () => {
  const sourceSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const baseParent = 'c'.repeat(40);
  const candidateParent = 'd'.repeat(40);
  const sourceBase = 'f'.repeat(40);
  const checkedTree = '2'.repeat(40);
  assert.equal(
    findGitTreeEquivalentAncestor(sourceSha, headSha, (args) => {
      if (args[0] === 'cat-file') return 'commit';
      if (args[0] === 'rev-list')
        return `${headSha} ${baseParent} ${candidateParent}`;
      if (args[0] === 'rev-parse') {
        if (args[1] === `${sourceSha}^{tree}`) return '1'.repeat(40);
        return checkedTree;
      }
      if (args[0] === 'merge-base') return sourceBase;
      if (args[0] === 'diff') {
        return args[5] === sourceSha ? 'original patch' : 'changed patch';
      }
      if (args.at(-1) === candidateParent && args.includes('--format=%H %T')) {
        return `${candidateParent} ${checkedTree}\n${baseParent} ${'3'.repeat(40)}`;
      }
      if (args.at(-1) === candidateParent && args.includes('--format=%H')) {
        return `${candidateParent}\n${baseParent}`;
      }
      return `${headSha} ${checkedTree}\n${baseParent} ${'3'.repeat(40)}`;
    }),
    '',
  );
});

test('KFD equivalence recognizes an exact replay in a real synthetic merge graph', (t) => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-kfd-protected-replay-'),
  );
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const gitRead = (args) => {
    const result = spawnSync('git', args, {
      cwd: repository,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  gitRead(['init', '--quiet']);
  gitRead(['config', 'user.name', 'KFD Fixture']);
  gitRead(['config', 'user.email', 'kfd-fixture@kungfu.invalid']);
  fs.writeFileSync(path.join(repository, 'base.txt'), 'base\n');
  gitRead(['add', 'base.txt']);
  gitRead(['commit', '--quiet', '-m', 'base']);
  const sourceBase = gitRead(['rev-parse', 'HEAD']);

  gitRead(['switch', '--quiet', '-c', 'original']);
  fs.writeFileSync(path.join(repository, 'runtime.txt'), 'runtime client\n');
  gitRead(['add', 'runtime.txt']);
  gitRead(['commit', '--quiet', '-m', 'runtime']);
  const sourceSha = gitRead(['rev-parse', 'HEAD']);

  gitRead(['switch', '--quiet', '-c', 'protected', sourceBase]);
  fs.writeFileSync(path.join(repository, 'unrelated.txt'), 'advanced base\n');
  gitRead(['add', 'unrelated.txt']);
  gitRead(['commit', '--quiet', '-m', 'unrelated']);
  const baseParent = gitRead(['rev-parse', 'HEAD']);
  gitRead(['switch', '--quiet', '-c', 'candidate']);
  gitRead(['cherry-pick', '--quiet', sourceSha]);
  const candidateParent = gitRead(['rev-parse', 'HEAD']);
  const headSha = gitRead([
    'commit-tree',
    `${candidateParent}^{tree}`,
    '-p',
    baseParent,
    '-p',
    candidateParent,
    '-m',
    'synthetic protected merge',
  ]);

  assert.equal(
    findGitTreeEquivalentAncestor(sourceSha, headSha, gitRead),
    candidateParent,
  );
});

test('KFD equivalence recognizes an exact GitHub linear merge-group replay', (t) => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-kfd-linear-protected-replay-'),
  );
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const gitRead = (args) => {
    const result = spawnSync('git', args, {
      cwd: repository,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  gitRead(['init', '--quiet']);
  gitRead(['config', 'user.name', 'KFD Fixture']);
  gitRead(['config', 'user.email', 'kfd-fixture@kungfu.invalid']);
  fs.writeFileSync(path.join(repository, 'base.txt'), 'base\n');
  gitRead(['add', 'base.txt']);
  gitRead(['commit', '--quiet', '-m', 'base']);
  const sourceBase = gitRead(['rev-parse', 'HEAD']);

  gitRead(['switch', '--quiet', '-c', 'original']);
  fs.writeFileSync(path.join(repository, 'runtime.txt'), 'runtime client\n');
  gitRead(['add', 'runtime.txt']);
  gitRead(['commit', '--quiet', '-m', 'runtime']);
  const sourceSha = gitRead(['rev-parse', 'HEAD']);

  gitRead(['switch', '--quiet', '-c', 'protected', sourceBase]);
  fs.writeFileSync(path.join(repository, 'unrelated.txt'), 'advanced base\n');
  gitRead(['add', 'unrelated.txt']);
  gitRead(['commit', '--quiet', '-m', 'unrelated']);
  const baseSha = gitRead(['rev-parse', 'HEAD']);
  gitRead(['cherry-pick', '--quiet', sourceSha]);
  const replayedSha = gitRead(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repository, 'docs.txt'), 'later replay commit\n');
  gitRead(['add', 'docs.txt']);
  gitRead(['commit', '--quiet', '-m', 'later replay commit']);
  const headSha = gitRead(['rev-parse', 'HEAD']);

  assert.equal(
    findGitTreeEquivalentAncestor(sourceSha, headSha, gitRead, {
      baseSha,
      headSha,
    }),
    replayedSha,
  );
  assert.equal(
    findGitTreeEquivalentAncestor(sourceSha, headSha, gitRead, {
      baseSha,
      headSha: 'f'.repeat(40),
    }),
    '',
  );
});

test('GitHub merge-group coordinates fail closed outside an exact event payload', () => {
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  assert.deepEqual(
    githubMergeGroupCoordinates(
      {
        GITHUB_EVENT_NAME: 'merge_group',
        GITHUB_EVENT_PATH: '/event.json',
      },
      () =>
        JSON.stringify({
          merge_group: { base_sha: baseSha, head_sha: headSha },
        }),
    ),
    { baseSha, headSha },
  );
  assert.equal(
    githubMergeGroupCoordinates(
      { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: '/event.json' },
      () =>
        JSON.stringify({
          merge_group: { base_sha: baseSha, head_sha: headSha },
        }),
    ),
    null,
  );
  assert.equal(
    githubMergeGroupCoordinates(
      {
        GITHUB_EVENT_NAME: 'merge_group',
        GITHUB_EVENT_PATH: '/event.json',
      },
      () => '{invalid',
    ),
    null,
  );
});

test('KFD tree-equivalence rejects a PR merge whose tree differs from its candidate parent', () => {
  const sourceSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const baseParent = 'c'.repeat(40);
  const candidateParent = 'd'.repeat(40);
  const sourceTree = '1'.repeat(40);
  assert.equal(
    findGitTreeEquivalentAncestor(sourceSha, headSha, (args) => {
      if (args[0] === 'cat-file') return 'commit';
      if (args[0] === 'rev-list')
        return `${headSha} ${baseParent} ${candidateParent}`;
      if (args[0] === 'rev-parse') {
        if (args[1] === `${sourceSha}^{tree}`) return sourceTree;
        if (args[1] === `${headSha}^{tree}`) return '2'.repeat(40);
        return '3'.repeat(40);
      }
      return `${headSha} ${'2'.repeat(40)}`;
    }),
    '',
  );
});

test('KFD tree-equivalence rejects non-commit Git objects', () => {
  const sourceSha = 'a'.repeat(40);
  const calls = [];
  assert.equal(
    findGitTreeEquivalentAncestor(sourceSha, 'b'.repeat(40), (args) => {
      calls.push(args);
      return 'tree';
    }),
    '',
  );
  assert.deepEqual(calls, [['cat-file', '-t', sourceSha]]);
});

test('KFD product gates remain checkable without ignored runtime outputs', () => {
  const sourceSha = 'a'.repeat(40);
  const commitCheckedAt = '2026-07-31T02:20:37+00:00';
  assert.equal(
    resolveKfdProductGateCheckedAt({
      write: false,
      now: () => {
        throw new Error('check mode must not use the wall clock');
      },
      retainedGateResults: [null, null, null],
      sourceSha,
      commitTimestamp: (commit) => {
        assert.equal(commit, sourceSha);
        return commitCheckedAt;
      },
    }),
    commitCheckedAt,
  );
  assert.equal(
    resolveKfdProductGateCheckedAt({
      write: false,
      now: () => '',
      retainedGateResults: [null, { checkedAt: '2026-07-30T00:00:00Z' }],
      sourceSha,
      commitTimestamp: () => {
        throw new Error('retained evidence must preserve its timestamp');
      },
    }),
    '2026-07-30T00:00:00Z',
  );
});

test('type baseline covers every Python surface declared by [tool.mypy]', () => {
  // The three siblings of the core package are small but load-bearing
  // (public SDK, capability guest harness, extension domain logic). Changing
  // one must trigger the type baseline, and pyproject must actually check it —
  // otherwise the scope silently narrows back to the core package.
  const pyproject = fs.readFileSync(
    path.join(ROOT, 'framework/core/pyproject.toml'),
    'utf8',
  );
  const checked = [
    [
      'framework/storage/python/kungfu_sdk/native.py',
      '"../storage/python/kungfu_sdk"',
    ],
    [
      'framework/api/src/capability/guest-harness/facet.py',
      '"../api/src/capability/guest-harness"',
    ],
    [
      'extensions/work-control/work-control-actions/adapter.py',
      '"../../extensions/work-control/work-control-actions"',
    ],
  ];
  for (const [changedFile, mypyEntry] of checked) {
    const labels = sourceAcceptancePlan([changedFile]).map((s) => s.label);
    assert.ok(
      labels.includes('Python type baseline'),
      `${changedFile} must trigger the type baseline`,
    );
    assert.ok(
      pyproject.includes(mypyEntry),
      `[tool.mypy] files must list ${mypyEntry}`,
    );
  }
});

test('release verification reuses the exact mypy tool lane without project sync', () => {
  const verify = fs.readFileSync(path.join(ROOT, 'scripts/verify.mjs'), 'utf8');
  assert.match(verify, /sourceMypyCommand\(\[\]\)/);
  assert.doesNotMatch(verify, /uv['"], \['run', '--frozen', 'mypy'/);
});

test('cross-platform full verification keeps Python resolution frozen and allows the bounded Episode workload', () => {
  const verify = fs.readFileSync(path.join(ROOT, 'scripts/verify.mjs'), 'utf8');
  const sdk = fs.readFileSync(
    path.join(ROOT, 'developer/sdk/src/sdk-contract.js'),
    'utf8',
  );
  assert.match(verify, /timeout: 30 \* 60 \* 1000/);
  assert.match(
    sdk,
    /'run',\s*'--frozen',\s*'--project',\s*coreDir,\s*'python'/,
  );
});

test('dev patrol normalizes MSVC diagnostics for bounded Gate output', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/dev-verify-patrol.yml'),
    'utf8',
  );
  assert.match(workflow, /"VSLANG":"1033"/);
  assert.doesNotMatch(workflow, /BUILDCHAIN_CARGO_REGISTRY_INDEX/u);
  assert.doesNotMatch(workflow, /SHIFU_CACHE_PROFILE_(?:REF|DIGEST)/u);
  assert.doesNotMatch(workflow, /cargo-registry-index:/u);
  assert.doesNotMatch(workflow, /shifu-cache-profile-(?:ref|digest):/u);
});

test('Python source checks use uvx when a bare ruff is unavailable', () => {
  const command = sourcePythonCommand(
    ['format', '--check'],
    (candidate) => candidate === 'uvx',
  );
  assert.deepEqual(command, {
    command: 'uvx',
    args: ['ruff', 'format', '--check'],
  });
});

test('Python source checks use uv tool run when the uvx shim is absent', () => {
  const command = sourcePythonCommand(
    ['format', '--check'],
    (candidate) => candidate === 'uv',
  );
  assert.deepEqual(command, {
    command: 'uv',
    args: ['tool', 'run', 'ruff', 'format', '--check'],
  });
});

test('C++ source checks use the exact ambient formatter when it matches the repository pin', () => {
  const command = sourceClangFormatCommand(
    ['--dry-run', 'example.cpp'],
    (candidate) => candidate === 'clang-format',
    () => ({ status: 0, stdout: 'clang-format version 20.1.8\n' }),
  );
  assert.deepEqual(command, {
    command: 'clang-format',
    args: ['--dry-run', 'example.cpp'],
  });
});

test('C++ source checks isolate an incompatible ambient formatter behind pinned uvx', () => {
  const command = sourceClangFormatCommand(
    ['--dry-run', 'example.cpp'],
    (candidate) => candidate === 'clang-format' || candidate === 'uvx',
    () => ({ status: 0, stdout: 'clang-format version 13.0.0\n' }),
  );
  assert.deepEqual(command, {
    command: 'uvx',
    args: ['clang-format@20.1.8', '--dry-run', 'example.cpp'],
  });
});

test('Python type checks use the pinned CI mypy when it is healthy', () => {
  const command = sourceMypyCommand(
    ['--config-file', 'pyproject.toml'],
    (candidate) => candidate === 'mypy',
    () => ({ status: 0, stdout: 'mypy 1.20.2 (compiled: yes)\n' }),
  );
  assert.deepEqual(command, {
    command: 'mypy',
    args: ['--config-file', 'pyproject.toml'],
  });
});

test('Python type checks isolate a broken ambient mypy behind pinned uvx', () => {
  const command = sourceMypyCommand(
    ['--config-file', 'pyproject.toml'],
    (candidate) => candidate === 'mypy' || candidate === 'uvx',
    () => ({ status: 1, stderr: 'broken ambient mypy' }),
  );
  assert.deepEqual(command, {
    command: 'uvx',
    args: ['--from', 'mypy==1.20.2', 'mypy', '--config-file', 'pyproject.toml'],
  });
});

test('Python type checks use pinned uv tool run without a uvx shim', () => {
  const command = sourceMypyCommand(
    ['--config-file', 'pyproject.toml'],
    (candidate) => candidate === 'uv',
  );
  assert.deepEqual(command, {
    command: 'uv',
    args: [
      'tool',
      'run',
      '--from',
      'mypy==1.20.2',
      'mypy',
      '--config-file',
      'pyproject.toml',
    ],
  });
});

test('source plan covers representative source-only checks', () => {
  const plan = sourceAcceptancePlan([
    'scripts/example.mjs',
    'framework/core/src/python/example.py',
    'framework/core/src/example.cpp',
  ]);
  const labels = plan.map((step) => step.label);
  assert.ok(labels.includes('changed web source format and lint'));
  assert.ok(labels.includes('changed deprecation surface enrollment'));
  assert.ok(labels.includes('changed Python format'));
  assert.ok(labels.includes('Python type baseline'));
  assert.ok(labels.includes('changed C/C++ format'));
  assert.ok(labels.includes('documentation contracts'));
  assert.ok(labels.includes('core architecture contract'));
  assert.ok(labels.includes('core architecture negative fixtures'));
  assert.ok(labels.includes('core affected-native negative fixtures'));
  assert.ok(labels.includes('runtime activation contract'));
  assert.ok(labels.includes('runtime upgrade contract'));
  assert.ok(labels.includes('product upgrade qualification'));
  assert.ok(labels.includes('agent session contract'));
  assert.ok(labels.includes('Project Cut contract'));
  assert.ok(labels.includes('Project Cut settlement contract'));
  assert.ok(labels.includes('Project Cut composition contract'));
  assert.ok(labels.includes('Project Cut scoped composition admission'));
  assert.ok(labels.includes('durability production-candidate admission'));
  assert.ok(labels.includes('Buildchain KFD release evidence'));
  assert.ok(labels.includes('agent-first canonical policy'));
  assert.ok(labels.includes('agent-first contract audit'));
  const kfdEvidence = plan.find(
    (step) => step.label === 'Buildchain KFD release evidence',
  );
  assert.deepEqual(kfdEvidence.args, [
    'scripts/buildchain-kfd-evidence.mjs',
    '--check',
  ]);
  const canonicalPolicy = plan.find(
    (step) => step.label === 'agent-first canonical policy',
  );
  assert.deepEqual(canonicalPolicy.args, [
    'developer/sdk/src/sdk.js',
    'contract',
    'policy',
    '--check',
    '--json',
  ]);
  const contractAudit = plan.find(
    (step) => step.label === 'agent-first contract audit',
  );
  assert.deepEqual(contractAudit.args, [
    'developer/sdk/src/sdk.js',
    'contract',
    'audit',
    '--json',
  ]);
  const typeBaseline = plan.find(
    (step) => step.label === 'Python type baseline',
  );
  assert.ok(['mypy', 'uvx', 'uv'].includes(typeBaseline.command));
  // No path argument: the checked surface comes from `files` under [tool.mypy]
  // in framework/core/pyproject.toml, so verify and source-acceptance cannot
  // disagree about what is type-checked.
  assert.deepEqual(typeBaseline.args.slice(-2), [
    '--config-file',
    'pyproject.toml',
  ]);
  if (typeBaseline.command === 'uvx') {
    assert.deepEqual(typeBaseline.args.slice(0, 3), [
      '--from',
      'mypy==1.20.2',
      'mypy',
    ]);
  }
  assert.equal(typeBaseline.cwd, path.join(ROOT, 'framework/core'));
  const contractTests = plan.find(
    (step) => step.label === 'source-acceptance contract tests',
  );
  const lifecycleMatrix = plan.find(
    (step) => step.label === 'Work lifecycle matrix materialization',
  );
  assert.deepEqual(lifecycleMatrix.args, [
    'scripts/materialize-work-lifecycle-operation-matrix.mjs',
    '--check',
  ]);
  const agentWorkState = plan.find(
    (step) => step.label === 'agent work state contract and CLI parity',
  );
  assert.deepEqual(agentWorkState.args, [
    'scripts/run-agent-work-state-tests.mjs',
  ]);
  assert.ok(
    contractTests.args.includes('scripts/check-upgrade-contract.test.mjs'),
  );
  assert.ok(
    contractTests.args.includes(
      'scripts/affected-native-delivery-attempt.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes('scripts/affected-native-proof.test.mjs'),
  );
  assert.ok(
    contractTests.args.includes('scripts/probe-cpp-cmake-contract.test.mjs'),
  );
  assert.ok(
    contractTests.args.includes('scripts/check-upgrade-qualification.test.mjs'),
  );
  assert.ok(
    contractTests.args.includes(
      'scripts/upgrade-publication-admission.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes('scripts/check-typescript-files.test.mjs'),
  );
  assert.ok(
    contractTests.args.includes('scripts/check-project-cut-contract.test.mjs'),
  );
  assert.ok(
    contractTests.args.includes('scripts/check-evidence-envelope.test.mjs'),
  );
  assert.ok(
    contractTests.args.includes(
      'scripts/check-work-lifecycle-operation-matrix.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'scripts/check-fact-cut-kernel-contract.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes('scripts/check-exit-bundle-contract.test.mjs'),
  );
  assert.ok(
    contractTests.args.includes(
      'scripts/check-data-protection-contract.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'scripts/check-durable-history-qualification.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'scripts/check-work-agent-history-continuity.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'scripts/check-project-cut-dogfood-history.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes('scripts/check-git-episode-provider.test.mjs'),
  );
  assert.ok(
    contractTests.args.includes(
      'scripts/check-project-cut-settlement.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'scripts/check-project-cut-composition.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'scripts/check-workspace-continuation.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'scripts/check-episode-admission-contract.test.mjs',
    ),
  );
  const phaseBPackageTests = plan.find(
    (step) => step.label === 'Phase B package identity contract tests',
  );
  assert.deepEqual(phaseBPackageTests.args, [
    '-B',
    '-m',
    'unittest',
    'scripts.test_prepare_kungfu_phase_b_package',
  ]);
  const upgradeTests = plan.find(
    (step) => step.label === 'runtime upgrade control-plane tests',
  );
  assert.deepEqual(upgradeTests.args, [
    'scripts/run-runtime-upgrade-tests.mjs',
  ]);
  const desktopUpdateTests = plan.find(
    (step) => step.label === 'desktop update adapter tests',
  );
  assert.deepEqual(desktopUpdateTests.args, [
    'scripts/run-desktop-update-tests.mjs',
  ]);
  assert.ok(
    contractTests.args.includes(
      'framework/agent-session/tests/capsule-host.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'framework/agent-session/tests/peer-transport.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'framework/agent-session/tests/runtime-port.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'framework/agent-session/tests/provider-adapters.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'framework/agent-session/tests/interaction-port.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'framework/agent-session/tests/codex-app-server-contract.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'framework/agent-session/tests/codex-app-server-interaction.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'framework/agent-session/tests/codex-app-server-recovery.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'framework/agent-session/tests/codex-app-server-runtime.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'framework/agent-session/tests/codex-app-server-product.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'framework/agent-session/tests/product-surface.test.mjs',
    ),
  );
  assert.ok(
    !contractTests.args.includes(
      'framework/agent-session/tests/capsule-worker.test.mjs',
    ),
  );
});

test('clang-format falls back to pinned uv tool run without a uvx shim', () => {
  const command = sourceClangFormatCommand(
    ['--dry-run', 'example.cpp'],
    (candidate) => candidate === 'uv',
  );
  assert.deepEqual(command, {
    command: 'uv',
    args: [
      'tool',
      'run',
      '--from',
      'clang-format==20.1.8',
      'clang-format',
      '--dry-run',
      'example.cpp',
    ],
  });
});

test('generated Xinfa and Project Cut evidence is not treated as web source', () => {
  const plan = sourceAcceptancePlan([
    '.xinfa/baselines/sha256/example/atlas.json',
    '.kungfu/project-cuts/sha256/example/receipt.json',
    'scripts/example.mjs',
  ]);
  const web = plan.find(
    (step) => step.label === 'changed web source format and lint',
  );
  assert.ok(web);
  assert.ok(web.args.includes('scripts/example.mjs'));
  assert.ok(!web.args.some((arg) => arg.startsWith('.xinfa/')));
  assert.ok(!web.args.some((arg) => arg.startsWith('.kungfu/')));
});

test('Conan recipe Python is linted without widening into the product type baseline', () => {
  const plan = sourceAcceptancePlan([
    'framework/core/.conan/recipes/rocksdb/conanfile.py',
  ]);
  const labels = plan.map((step) => step.label);
  assert.ok(labels.includes('changed Python format'));
  assert.ok(labels.includes('changed Python lint'));
  assert.ok(!labels.includes('Python type baseline'));
});

test('changed Python format and lint use one explicit repository configuration', () => {
  const plan = sourceAcceptancePlan([
    'tests/fixtures/rewind-demo-langchain/check_capture.py',
  ]);
  for (const label of ['changed Python format', 'changed Python lint']) {
    const step = plan.find((candidate) => candidate.label === label);
    assert.ok(step);
    assert.ok(step.args.includes('--no-cache'));
    assert.deepEqual(
      step.args.slice(
        step.args.indexOf('--config'),
        step.args.indexOf('--config') + 2,
      ),
      ['--config', 'framework/core/pyproject.toml'],
    );
  }
});

test('changed GUI TypeScript receives a file-scoped semantic check', () => {
  const plan = sourceAcceptancePlan([
    'framework/gui/src/renderer/src/runtime.ts',
    'framework/gui/src/renderer/src/app.tsx',
    'framework/gui/src/renderer/src/theme.css',
  ]);
  const typeCheck = plan.find(
    (step) => step.label === 'changed GUI TypeScript check',
  );
  assert.deepEqual(typeCheck?.args, [
    'scripts/check-typescript-files.mjs',
    '--project',
    'framework/gui/tsconfig.json',
    'framework/gui/src/renderer/src/runtime.ts',
    'framework/gui/src/renderer/src/app.tsx',
  ]);
});

test('cold read-only source acceptance skips dependency-backed checks', () => {
  const previous = process.env.KUNGFU_READONLY_NESTED_SOURCE_ACCEPTANCE;
  process.env.KUNGFU_READONLY_NESTED_SOURCE_ACCEPTANCE = '1';
  try {
    const plan = sourceAcceptancePlan([
      'framework/gui/src/renderer/src/runtime.ts',
    ]);
    assert.equal(
      plan.some((step) =>
        /^(changed GUI TypeScript check|agent-first canonical policy|agent-first contract audit|Shifu Production Graph contract|documentation material lane|source-acceptance contract tests|agent work state contract and CLI parity|runtime upgrade control-plane tests|desktop update adapter tests)$/u.test(
          step.label,
        ),
      ),
      false,
    );
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(
        process.env,
        'KUNGFU_READONLY_NESTED_SOURCE_ACCEPTANCE',
      );
    } else {
      process.env.KUNGFU_READONLY_NESTED_SOURCE_ACCEPTANCE = previous;
    }
  }
});

test('Buildchain KFD check reuses the committed source binding without environment hints', () => {
  const env = { ...process.env };
  Reflect.deleteProperty(env, 'BUILDCHAIN_SOURCE_SHA');
  Reflect.deleteProperty(env, 'KUNGFU_KFD_SOURCE_SHA');
  const result = spawnSync(
    process.execPath,
    ['scripts/buildchain-kfd-evidence.mjs', '--check', '--json'],
    { cwd: ROOT, encoding: 'utf8', env },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('RocksDB source archive keeps an explicit tar filename', () => {
  const recipe = fs.readFileSync(
    path.join(ROOT, 'framework/core/.conan/recipes/rocksdb/conanfile.py'),
    'utf8',
  );
  assert.match(recipe, /filename="rocksdb-source\.tar\.gz"/);
});

test('source plan cannot enter build, compiler, artifact, or release lifecycles', () => {
  const plan = sourceAcceptancePlan(['scripts/example.mjs']);
  const commands = plan
    .map((step) => [step.command, ...step.args].join(' '))
    .join('\n');
  assert.doesNotMatch(
    commands,
    /(?:^|\s)(?:cargo|rustc|cc|c\+\+|gcc|g\+\+|clang|cmake|conan|ninja)(?:\s|$)/im,
  );
  assert.doesNotMatch(
    commands,
    /(?:^|[\s:])(?:build|dist|package|freeze|verify|publish|release)(?:\s|$)/im,
  );
});

test('reusable workflow is bound to source mode and the pinned stable runtime', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/source-acceptance.yml'),
    'utf8',
  );
  assert.match(workflow, /mode: source/);
  assert.match(workflow, /check\.yml@9e904de2c85dbea7c799780ee166510b3336d812/);
  assert.match(workflow, /buildchain-ref: v3/);
  assert.doesNotMatch(workflow, /self-hosted/);
});

test('manual package build is welded to the reviewed Phase B consumer', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/build.yml'),
    'utf8',
  );
  assert.match(workflow, /run-kungfu-phase-b:\n\s+description:/);
  assert.match(
    workflow,
    /prepare_kungfu_phase_b_package\.py[\s\S]+--build-images-ref "v1\.2\.4-alpha\.30"[\s\S]+--build-images-sha "3056c23e70b83f5bb63062f04027a93e79039e4b"/,
  );
  assert.match(
    workflow,
    /uses: kungfu-systems\/build-images\/\.github\/workflows\/comparator-kungfu-package-smoke\.yml@3056c23e70b83f5bb63062f04027a93e79039e4b # v1\.2\.4-alpha\.30/,
  );
  assert.match(
    workflow,
    /package_artifact_name: \$\{\{ needs\.phase-b-package\.outputs\.artifact-name \}\}/,
  );
  assert.match(workflow, /retention-days: 30/);
});

test('the native membrane matrix is a promotion gate, not a dev PR gate', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/embedding-membrane-spike.yml'),
    'utf8',
  );
  const branchBlock = workflow.match(/branches:\n((?:\s+- .+\n)+)/)?.[1] || '';
  assert.match(branchBlock, /alpha\/v\*\/v\*/);
  assert.match(branchBlock, /release\/v\*\/v\*/);
  assert.doesNotMatch(branchBlock, /dev\/v\*\/v\*/);
});

test('documentation lint excludes the checked-out Buildchain runtime', async () => {
  const config = await import('../.markdownlint-cli2.mjs');
  assert.ok(config.default.globs.includes('!.buildchain/runtime/**'));
  assert.ok(config.default.globs.includes('!.buildchain/tmp/**'));
});
