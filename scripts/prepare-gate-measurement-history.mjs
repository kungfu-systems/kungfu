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

export function githubRepositoryFetchUrl({ repository, serverUrl } = {}) {
  const normalizedRepository = String(repository || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(normalizedRepository)) {
    return '';
  }
  let normalizedServer;
  try {
    normalizedServer = new URL(String(serverUrl || 'https://github.com'));
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(normalizedServer.protocol)) return '';
  normalizedServer.pathname = normalizedServer.pathname.replace(/\/+$/u, '');
  return `${normalizedServer.toString().replace(/\/+$/u, '')}/${normalizedRepository}.git`;
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

function fetchSources(cwd, sourceRepositoryUrl = '') {
  const sources = [];
  const origin = git(cwd, ['remote', 'get-url', 'origin'], {
    encoding: 'utf8',
  });
  if (origin.status === 0 && origin.stdout.trim()) sources.push('origin');
  const bundle = rewrittenBundleOrigin(cwd);
  if (bundle) sources.push(bundle);
  if (sourceRepositoryUrl) sources.push(sourceRepositoryUrl);
  return [...new Set(sources)];
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

function ensureRemoteBaseRef(cwd, baseRef, sources) {
  if (!baseRef) return;
  const remoteRef = `refs/remotes/origin/${baseRef}`;
  const current = git(cwd, ['rev-parse', '--verify', remoteRef], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (current.status === 0) return;
  for (const source of sources) {
    const fetched = git(
      cwd,
      ['fetch', '--no-tags', source, `+refs/heads/${baseRef}:${remoteRef}`],
      { stdio: 'inherit' },
    );
    if (fetched.status === 0) return;
  }
  throw new Error(`cannot fetch measurement base ref: ${baseRef}`);
}

function ensureCommitObject(cwd, requiredCommit, sources) {
  if (!requiredCommit) return;
  if (!/^[0-9a-f]{40}$/u.test(requiredCommit)) {
    throw new Error(`invalid required measurement commit: ${requiredCommit}`);
  }
  const present = git(cwd, ['cat-file', '-e', `${requiredCommit}^{commit}`], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (present.status === 0) return;
  for (const source of sources) {
    const fetched = git(cwd, ['fetch', '--no-tags', source, requiredCommit], {
      stdio: 'inherit',
    });
    if (fetched.status !== 0) continue;
    const verified = git(
      cwd,
      ['cat-file', '-e', `${requiredCommit}^{commit}`],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    if (verified.status === 0) return;
  }
  throw new Error(
    `cannot fetch required measurement commit: ${requiredCommit}`,
  );
}

export function prepareGateMeasurementHistory(
  cwd = process.cwd(),
  {
    baseRef = '',
    requiredCommit = '',
    sourceRepositoryUrl = githubRepositoryFetchUrl({
      repository:
        process.env.BUILDCHAIN_SOURCE_REPOSITORY ||
        process.env.GITHUB_REPOSITORY,
      serverUrl: process.env.GITHUB_SERVER_URL,
    }),
  } = {},
) {
  const sources = fetchSources(cwd, sourceRepositoryUrl);
  const shallow = git(cwd, ['rev-parse', '--is-shallow-repository'], {
    encoding: 'utf8',
  });
  if (shallow.status !== 0) {
    throw new Error(
      'cannot determine whether the measurement source is shallow',
    );
  }
  if (shallow.stdout.trim() === 'false') {
    ensureRemoteBaseRef(cwd, baseRef, sources);
    ensureCommitObject(cwd, requiredCommit, sources);
    return 'already-complete';
  }

  // Self-hosted Actions checkouts are often marked shallow again even though a
  // previous source-locked run left the complete object graph in the local Git
  // store. Prove connectivity without the shallow boundary before reaching out
  // to GitHub; restore the marker unchanged when that proof fails.
  if (recoverCompleteLocalHistory(cwd)) {
    ensureRemoteBaseRef(cwd, baseRef, sources);
    ensureCommitObject(cwd, requiredCommit, sources);
    return 'recovered-local';
  }

  const head = git(cwd, ['rev-parse', '--verify', 'HEAD'], {
    encoding: 'utf8',
  });
  if (head.status !== 0 || !head.stdout.trim()) {
    throw new Error('cannot resolve measurement source head');
  }
  let fetched = false;
  for (const source of sources) {
    const result = git(
      cwd,
      [
        'fetch',
        '--unshallow',
        '--filter=blob:none',
        '--no-tags',
        source,
        head.stdout.trim(),
      ],
      { stdio: 'inherit' },
    );
    if (result.status === 0) {
      fetched = true;
      break;
    }
  }
  if (!fetched) {
    throw new Error('cannot fetch complete measurement source history');
  }
  ensureRemoteBaseRef(cwd, baseRef, sources);
  ensureCommitObject(cwd, requiredCommit, sources);
  return 'fetched-origin';
}
