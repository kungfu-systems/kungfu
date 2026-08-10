// SPDX-License-Identifier: Apache-2.0

import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOCK = '.buildchain/alpha-release-cut-lock.json';
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

function fail(message) {
  throw new Error(`[alpha-release-cut-lock] ${message}`);
}

function requireExactSha(value, label) {
  if (!SHA.test(String(value || ''))) fail(`${label} must be an exact SHA`);
}

function requireDigest(value, label) {
  if (!DIGEST.test(String(value || ''))) fail(`${label} must be a sha256 root`);
}

function git(root, args) {
  const result = childProcess.spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    fail(`git ${args.join(' ')} failed: ${String(result.stderr || '').trim()}`);
  }
  return String(result.stdout || '').trim();
}

export function verifyAlphaReleaseCutLock(options = {}) {
  const root = path.resolve(String(options.root || ROOT));
  const lockPath = path.resolve(root, String(options.lockPath || DEFAULT_LOCK));
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

  if (lock.schema !== 'kungfu.alpha-release-cut-lock/v1') {
    fail('unsupported schema');
  }
  if (lock.release !== 'v4.0.0-alpha.2' || lock.cut !== 'r16') {
    fail('release identity must remain v4.0.0-alpha.2 r16');
  }
  if (lock.state !== 'frozen') fail('release cut must remain frozen');

  for (const [label, value] of [
    ['candidate SHA', lock.candidate?.sha],
    ['candidate tree', lock.candidate?.tree],
    ['dev cut SHA', lock.devCut?.sha],
    ['dev cut tree', lock.devCut?.tree],
    ['Alpha base SHA', lock.alphaBase?.sha],
    ['Alpha base tree', lock.alphaBase?.tree],
  ]) {
    requireExactSha(value, label);
  }
  if (lock.candidate?.ref !== 'refs/heads/fix/alpha2-lineage-repair-r16') {
    fail('candidate ref drifted from the unique r16 Release Cut');
  }
  if (lock.alphaBase?.ref !== 'refs/heads/alpha/v4/v4.0') {
    fail('Alpha base ref drifted');
  }
  if (
    JSON.stringify(lock.lineage?.parentOrder) !==
    JSON.stringify([lock.devCut.sha, lock.alphaBase.sha])
  ) {
    fail('candidate parent order must be dev cut followed by fixed Alpha base');
  }
  if (
    lock.lineage?.candidateTreeEqualsDevCut !== true ||
    lock.candidate.tree !== lock.devCut.tree
  ) {
    fail('candidate tree must equal the frozen dev cut tree');
  }

  if (
    lock.buildchain?.sourcePinPolicy !==
    'floating-contract-with-recorded-resolution'
  ) {
    fail('Buildchain must remain a floating contract with recorded resolution');
  }
  for (const [label, runtime, expectedRef] of [
    ['build runtime', lock.buildchain?.build, 'v3'],
    ['promotion runtime', lock.buildchain?.promotion, 'v3-alpha'],
  ]) {
    if (runtime?.ref !== expectedRef)
      fail(`${label} ref must remain ${expectedRef}`);
    requireExactSha(runtime?.resolvedSha, `${label} resolved SHA`);
    requireDigest(runtime?.contractDigest, `${label} contract digest`);
  }

  const policy = lock.policy || {};
  if (
    policy.devMovementInvalidatesCut !== false ||
    policy.devMirrorIsBuildInput !== false ||
    policy.blockerRepairOrder !==
      'release-cut-first-then-independent-dev-forward-port' ||
    policy.recutRequiresNewDevSemanticsEvidence !== true ||
    policy.tailFailureReusesSealedCandidate !== true
  ) {
    fail('release-blocker stabilization policy drifted');
  }

  if (options.verifyGit !== false) {
    const candidateTree = git(root, [
      'rev-parse',
      `${lock.candidate.sha}^{tree}`,
    ]);
    const devTree = git(root, ['rev-parse', `${lock.devCut.sha}^{tree}`]);
    const alphaTree = git(root, ['rev-parse', `${lock.alphaBase.sha}^{tree}`]);
    const parents = git(root, [
      'show',
      '-s',
      '--format=%P',
      lock.candidate.sha,
    ]);
    if (candidateTree !== lock.candidate.tree)
      fail('candidate tree readback mismatch');
    if (devTree !== lock.devCut.tree) fail('dev cut tree readback mismatch');
    if (alphaTree !== lock.alphaBase.tree)
      fail('Alpha base tree readback mismatch');
    if (parents !== lock.lineage.parentOrder.join(' ')) {
      fail('candidate parent readback mismatch');
    }
  }

  return {
    ok: true,
    release: lock.release,
    cut: lock.cut,
    state: lock.state,
    candidateSha: lock.candidate.sha,
    candidateTree: lock.candidate.tree,
    devCutSha: lock.devCut.sha,
    alphaBaseSha: lock.alphaBase.sha,
    buildchainBuildResolvedSha: lock.buildchain.build.resolvedSha,
    buildchainPromotionResolvedSha: lock.buildchain.promotion.resolvedSha,
    candidateSettlementAuthorized: false,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyAlphaReleaseCutLock();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
