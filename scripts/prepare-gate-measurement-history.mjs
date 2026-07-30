// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(cwd, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: options.encoding,
    stdio: options.stdio,
  });
  if (result.error) throw result.error;
  return result;
}

export function bundleFetchUrl(value, platform = process.platform) {
  if (
    platform === 'win32' &&
    /^[A-Za-z]:[\\/]/u.test(value) &&
    value.endsWith('.bundle')
  ) {
    return `file:///${value.replaceAll('\\', '/')}`;
  }
  return value;
}

function rewrittenBundleOrigin(cwd) {
  const remote = git(cwd, ['remote', 'get-url', 'origin'], {
    encoding: 'utf8',
  });
  if (remote.status !== 0) return '';
  const remoteUrl = remote.stdout.trim();
  const mappings = git(
    cwd,
    ['config', '--global', '--get-regexp', '^url\\..*\\.insteadof$'],
    { encoding: 'utf8' },
  );
  if (mappings.status !== 0) return '';
  let match = null;
  for (const line of mappings.stdout.split(/\r?\n/u)) {
    const separator = line.search(/\s/u);
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    const insteadOf = line.slice(separator).trim();
    if (!remoteUrl.startsWith(insteadOf)) continue;
    if (!key.startsWith('url.') || !key.endsWith('.insteadof')) continue;
    const replacement = key.slice('url.'.length, -'.insteadof'.length);
    const rewritten = `${replacement}${remoteUrl.slice(insteadOf.length)}`;
    if (!rewritten.endsWith('.bundle')) continue;
    if (!match || insteadOf.length > match.insteadOf.length) {
      match = { insteadOf, rewritten };
    }
  }
  return match ? bundleFetchUrl(match.rewritten) : '';
}

function recoverCompleteLocalHistory(cwd) {
  const shallowPathResult = git(cwd, ['rev-parse', '--git-path', 'shallow'], {
    encoding: 'utf8',
  });
  if (shallowPathResult.status !== 0) return false;
  const reportedShallowPath = shallowPathResult.stdout.trim();
  if (!reportedShallowPath) return false;
  const shallowPath = path.resolve(cwd, reportedShallowPath);
  if (!fs.existsSync(shallowPath)) return false;

  const backupPath = `${shallowPath}.gate-measurement-${process.pid}`;
  fs.renameSync(shallowPath, backupPath);
  const connectivity = git(
    cwd,
    ['fsck', '--connectivity-only', '--no-dangling'],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  if (connectivity.status === 0) {
    fs.unlinkSync(backupPath);
    return true;
  }
  fs.renameSync(backupPath, shallowPath);
  return false;
}

function ensureRemoteBaseRef(cwd, baseRef) {
  if (!baseRef) return;
  const remoteRef = `refs/remotes/origin/${baseRef}`;
  const current = git(cwd, ['rev-parse', '--verify', remoteRef], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (current.status === 0) return;
  const fetched = git(
    cwd,
    ['fetch', '--no-tags', 'origin', `+refs/heads/${baseRef}:${remoteRef}`],
    { stdio: 'inherit' },
  );
  if (fetched.status === 0) return;
  const bundle = rewrittenBundleOrigin(cwd);
  if (bundle) {
    const recovered = git(
      cwd,
      ['fetch', '--no-tags', bundle, `+refs/heads/${baseRef}:${remoteRef}`],
      { stdio: 'inherit' },
    );
    if (recovered.status === 0) return;
  }
  throw new Error(`cannot fetch measurement base ref: ${baseRef}`);
}

export function prepareGateMeasurementHistory(
  cwd = process.cwd(),
  { baseRef = '' } = {},
) {
  const shallow = git(cwd, ['rev-parse', '--is-shallow-repository'], {
    encoding: 'utf8',
  });
  if (shallow.status !== 0) {
    throw new Error(
      'cannot determine whether the measurement source is shallow',
    );
  }
  if (shallow.stdout.trim() === 'false') {
    ensureRemoteBaseRef(cwd, baseRef);
    return 'already-complete';
  }

  // Self-hosted Actions checkouts are often marked shallow again even though a
  // previous source-locked run left the complete object graph in the local Git
  // store. Prove connectivity without the shallow boundary before reaching out
  // to GitHub; restore the marker unchanged when that proof fails.
  if (recoverCompleteLocalHistory(cwd)) {
    ensureRemoteBaseRef(cwd, baseRef);
    return 'recovered-local';
  }

  const head = git(cwd, ['rev-parse', '--verify', 'HEAD'], {
    encoding: 'utf8',
  });
  if (head.status !== 0 || !head.stdout.trim()) {
    throw new Error('cannot resolve measurement source head');
  }
  const fetched = git(
    cwd,
    [
      'fetch',
      '--unshallow',
      '--filter=blob:none',
      '--no-tags',
      'origin',
      head.stdout.trim(),
    ],
    { stdio: 'inherit' },
  );
  if (fetched.status !== 0) {
    throw new Error('cannot fetch complete measurement source history');
  }
  ensureRemoteBaseRef(cwd, baseRef);
  return 'fetched-origin';
}
