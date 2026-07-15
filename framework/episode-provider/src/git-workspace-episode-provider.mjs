// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';

import {
  canonicalJson,
  semanticRoot,
  sha256Bytes,
} from '../../project-cut/src/project-cut.mjs';

export const GIT_EPISODE_SEGMENT_SCHEMA =
  'kungfu.episode.git-workspace-segment/v1';
export const GIT_EPISODE_MANIFEST_SCHEMA =
  'kungfu.episode.git-workspace-manifest/v1';
export const GIT_EPISODE_RECEIPT_SCHEMA =
  'kungfu.episode.git-workspace-receipt/v1';
export const GIT_EPISODE_PROVIDER = 'git-workspace-jsonl/v1';
export const GIT_EPISODE_PROVIDER_ROOT_ALGORITHM =
  'sha256-kungfu-git-episode-canonical-json-v1';
export const EPISODE_BUNDLE_SCHEMA = 'kungfu.storage.episode-bundle/v1';
export const EPISODE_QUALIFICATION_SCHEMA = 'kungfu.episode.qualification/v1';

const ROOT = /^sha256:[0-9a-f]{64}$/u;
const BARE_ROOT = /^[0-9a-f]{64}$/u;
const SEGMENT_FILE = 'claims.jsonl';
const MANIFEST_FILE = 'manifest.json';
const WORKSPACE_IGNORE = 'runtime/\nepisodes/.tmp/\nprivate/\ncache/\n';

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, code, message) {
  if (!isObject(value)) throw failure(code, message);
  return value;
}

function portableRoot(bundle) {
  const manifest = requireObject(
    bundle.manifest,
    'episode-manifest-missing',
    'Episode bundle has no folded manifest',
  );
  if (manifest.closed !== true || manifest.status !== 'ended') {
    throw failure('episode-not-sealed', 'only ended Episodes may be sealed');
  }
  if (
    manifest.content_root_algorithm !== 'sha256' ||
    !BARE_ROOT.test(String(manifest.content_root ?? ''))
  ) {
    throw failure(
      'episode-root-unqualified',
      'bundle has no supported recorded Episode root',
    );
  }
  return `sha256:${manifest.content_root}`;
}

function verifyQualification(bundle, qualification) {
  requireObject(
    qualification,
    'qualification-missing',
    'C++ Episode qualification evidence is required',
  );
  if (qualification.schema !== EPISODE_QUALIFICATION_SCHEMA) {
    throw failure('qualification-schema-unknown', 'unsupported qualification');
  }
  if (
    qualification.policy_source !== 'cpp-typed-fold-fsck' ||
    qualification.lifecycle !== 'ended' ||
    qualification.status !== 'ok' ||
    qualification.episode_id !== bundle.episode_id
  ) {
    throw failure(
      'qualification-not-admissible',
      'qualification does not admit this sealed Episode',
    );
  }
  const exportCapability = qualification.capabilities?.find(
    (entry) => entry?.name === 'export_evidence',
  );
  if (exportCapability?.safe !== true) {
    throw failure(
      'qualification-capability-missing',
      'export_evidence is not qualified',
    );
  }
}

function thinBundle(bundle) {
  const forbidden = ['journals', 'ref_payloads', 'material'];
  for (const field of forbidden) {
    if (Object.hasOwn(bundle, field)) {
      throw failure(
        'private-material-not-admitted',
        `Git Episode segments reject bundle field '${field}'`,
      );
    }
  }
  if (bundle.self_contained === true) {
    throw failure(
      'private-material-not-admitted',
      'self-contained runtime bytes are not Git-tracked material',
    );
  }
}

function recordLines(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw failure('episode-records-missing', 'bundle records are required');
  }
  return records.map((record, index) => ({
    schema: GIT_EPISODE_SEGMENT_SCHEMA,
    index,
    record,
  }));
}

function jsonlBytes(lines) {
  return Buffer.from(
    `${lines.map((line) => canonicalJson(line)).join('\n')}\n`,
  );
}

export function buildGitEpisodeSegment(bundle, qualification) {
  requireObject(bundle, 'episode-bundle-invalid', 'Episode bundle is invalid');
  if (bundle.schema !== EPISODE_BUNDLE_SCHEMA) {
    throw failure(
      'episode-bundle-schema-unknown',
      'unsupported Episode bundle',
    );
  }
  thinBundle(bundle);
  const semanticRootValue = portableRoot(bundle);
  verifyQualification(bundle, qualification);
  const lines = recordLines(bundle.records);
  const claims = jsonlBytes(lines);
  const claimsDigest = sha256Bytes(claims);
  const qualificationRoot = semanticRoot(qualification);
  const manifestPreimage = {
    schema: GIT_EPISODE_MANIFEST_SCHEMA,
    provider: GIT_EPISODE_PROVIDER,
    providerRootAlgorithm: GIT_EPISODE_PROVIDER_ROOT_ALGORITHM,
    authority: 'shadow-of-yijinjing-journal',
    episodeId: bundle.episode_id,
    semanticRoot: semanticRootValue,
    semanticRootContract: 'kungfu.episode-root/v1',
    qualificationRoot,
    claims: {
      path: SEGMENT_FILE,
      digest: claimsDigest,
      count: lines.length,
      framing: 'canonical-json-lines-lf/v1',
    },
    contentRefs: [
      ...new Set(
        (bundle.refs ?? [])
          .map((entry) => entry?.record?.ref_hash ?? entry?.ref_hash)
          .filter((entry) => typeof entry === 'string' && ROOT.test(entry)),
      ),
    ].sort(),
    dependencies: bundle.dependencies ?? [],
  };
  const providerRoot = semanticRoot(manifestPreimage);
  const manifest = { ...manifestPreimage, providerRoot };
  return {
    semanticRoot: semanticRootValue,
    providerRoot,
    manifest,
    claims,
    qualification,
  };
}

function rootParts(root) {
  if (!ROOT.test(root)) throw failure('invalid-root', 'invalid SHA-256 root');
  const hex = root.slice('sha256:'.length);
  return { hex, prefix: hex.slice(0, 2) };
}

export function episodeProviderPaths(workspaceRoot, semanticRootValue) {
  const { hex, prefix } = rootParts(semanticRootValue);
  const control = path.join(workspaceRoot, '.kungfu');
  return {
    trackedRoot: path.join(control, 'episodes'),
    segment: path.join(control, 'episodes', 'sealed', 'sha256', prefix, hex),
    tempRoot: path.join(control, 'episodes', '.tmp'),
    runtimeRoot: path.join(control, 'runtime', 'episode-provider'),
    lease: path.join(
      control,
      'runtime',
      'episode-provider',
      'leases',
      `${hex}.json`,
    ),
  };
}

function syncFile(file) {
  const handle = fs.openSync(file, 'r');
  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  syncFile(directory);
}

function writeExclusive(file, bytes) {
  const handle = fs.openSync(file, 'wx', 0o644);
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function readManifest(segment) {
  return JSON.parse(fs.readFileSync(path.join(segment, MANIFEST_FILE), 'utf8'));
}

function acquireLease(paths, writerId, generation) {
  fs.mkdirSync(path.dirname(paths.lease), { recursive: true });
  try {
    writeExclusive(
      paths.lease,
      Buffer.from(
        `${canonicalJson({
          schema: 'kungfu.episode.git-workspace-lease/v1',
          writerId,
          generation,
        })}\n`,
      ),
    );
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw failure(
        'episode-writer-busy',
        'another writer holds this Episode lease',
      );
    }
    throw error;
  }
}

function ensureWorkspaceIgnore(workspaceRoot) {
  const control = path.join(workspaceRoot, '.kungfu');
  const ignore = path.join(control, '.gitignore');
  fs.mkdirSync(control, { recursive: true });
  try {
    writeExclusive(ignore, Buffer.from(WORKSPACE_IGNORE));
    syncDirectory(control);
    return;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const entries = new Set(
    fs
      .readFileSync(ignore, 'utf8')
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  for (const required of WORKSPACE_IGNORE.trimEnd().split('\n')) {
    if (!entries.has(required)) {
      throw failure(
        'workspace-ignore-incomplete',
        `.kungfu/.gitignore must contain '${required}'`,
      );
    }
  }
}

export function sealGitEpisode(
  workspaceRoot,
  segment,
  { writerId, generation = 1, fault = null } = {},
) {
  if (!/^[A-Za-z0-9._-]+$/u.test(String(writerId ?? '')))
    throw failure('writer-id-invalid', 'writerId must be a safe path token');
  if (!Number.isSafeInteger(generation) || generation < 1)
    throw failure(
      'generation-invalid',
      'generation must be a positive integer',
    );
  ensureWorkspaceIgnore(workspaceRoot);
  const paths = episodeProviderPaths(workspaceRoot, segment.semanticRoot);
  fs.mkdirSync(path.dirname(paths.segment), { recursive: true });
  fs.mkdirSync(paths.tempRoot, { recursive: true });
  acquireLease(paths, writerId, generation);
  let releaseLease = true;
  const temp = path.join(
    paths.tempRoot,
    `${path.basename(paths.segment)}.${generation}.${process.pid}.${writerId}`,
  );
  try {
    if (fs.existsSync(paths.segment)) {
      const existing = readManifest(paths.segment);
      if (existing.providerRoot !== segment.providerRoot) {
        throw failure(
          'episode-provider-root-conflict',
          'semantic root already maps to different provider bytes',
        );
      }
      return receipt(segment, paths.segment, 'already-present');
    }
    fs.mkdirSync(temp, { recursive: false });
    writeExclusive(path.join(temp, SEGMENT_FILE), segment.claims);
    if (fault === 'after-claims') {
      releaseLease = false;
      throw failure('injected-crash', 'fault after claims publication');
    }
    writeExclusive(
      path.join(temp, MANIFEST_FILE),
      Buffer.from(`${canonicalJson(segment.manifest)}\n`),
    );
    syncDirectory(temp);
    if (fault === 'before-rename') {
      releaseLease = false;
      throw failure('injected-crash', 'fault before atomic rename');
    }
    fs.renameSync(temp, paths.segment);
    syncDirectory(path.dirname(paths.segment));
    return receipt(segment, paths.segment, 'sealed');
  } finally {
    if (releaseLease) fs.rmSync(paths.lease, { force: true });
  }
}

function receipt(segment, location, status) {
  const preimage = {
    schema: GIT_EPISODE_RECEIPT_SCHEMA,
    provider: GIT_EPISODE_PROVIDER,
    status,
    semanticRoot: segment.semanticRoot,
    providerRoot: segment.providerRoot,
    location,
  };
  return { ...preimage, receiptRoot: semanticRoot(preimage) };
}

export function fsckGitEpisode(workspaceRoot, semanticRootValue) {
  const paths = episodeProviderPaths(workspaceRoot, semanticRootValue);
  const issues = [];
  let manifest;
  try {
    manifest = readManifest(paths.segment);
  } catch {
    return { ok: false, issues: [{ code: 'episode-segment-missing' }] };
  }
  if (manifest.schema !== GIT_EPISODE_MANIFEST_SCHEMA)
    issues.push({ code: 'unknown-schema' });
  const { providerRoot, ...preimage } = manifest;
  if (semanticRoot(preimage) !== providerRoot)
    issues.push({ code: 'provider-root-mismatch' });
  if (manifest.semanticRoot !== semanticRootValue)
    issues.push({ code: 'semantic-root-mismatch' });
  const claimsPath = path.join(paths.segment, SEGMENT_FILE);
  let raw = Buffer.alloc(0);
  try {
    raw = fs.readFileSync(claimsPath);
  } catch {
    issues.push({ code: 'claims-missing' });
  }
  if (raw.length > 0) {
    if (raw.at(-1) !== 0x0a) issues.push({ code: 'torn-tail' });
    if (sha256Bytes(raw) !== manifest.claims?.digest)
      issues.push({ code: 'claims-hash-mismatch' });
    const seen = new Set();
    const rows = raw.toString('utf8').split('\n').filter(Boolean);
    rows.forEach((text, position) => {
      try {
        const row = JSON.parse(text);
        if (row.schema !== GIT_EPISODE_SEGMENT_SCHEMA)
          issues.push({ code: 'unknown-schema', index: position });
        if (seen.has(row.index))
          issues.push({ code: 'duplicate-record', index: position });
        seen.add(row.index);
        if (row.index !== position)
          issues.push({ code: 'out-of-order', index: position });
        if (`${canonicalJson(row)}\n` !== `${text}\n`)
          issues.push({ code: 'non-canonical-jsonl', index: position });
      } catch {
        issues.push({ code: 'malformed-jsonl', index: position });
      }
    });
    if (rows.length !== manifest.claims?.count)
      issues.push({ code: 'record-count-mismatch' });
  }
  return { ok: issues.length === 0, issues, manifest };
}

export function exportGitEpisode(workspaceRoot, semanticRootValue) {
  const report = fsckGitEpisode(workspaceRoot, semanticRootValue);
  if (!report.ok)
    throw failure('episode-fsck-failed', 'Episode segment failed fsck', {
      issues: report.issues,
    });
  const paths = episodeProviderPaths(workspaceRoot, semanticRootValue);
  return {
    schema: 'kungfu.episode.git-workspace-export/v1',
    semanticRoot: semanticRootValue,
    providerRoot: report.manifest.providerRoot,
    manifest: report.manifest,
    claims: fs.readFileSync(path.join(paths.segment, SEGMENT_FILE)),
  };
}

export function importGitEpisode(workspaceRoot, exported, options = {}) {
  requireObject(
    exported,
    'episode-export-invalid',
    'Git Episode export is invalid',
  );
  if (exported.schema !== 'kungfu.episode.git-workspace-export/v1') {
    throw failure('episode-export-schema-unknown', 'unsupported Git export');
  }
  const manifest = requireObject(
    exported.manifest,
    'episode-manifest-missing',
    'Git export has no manifest',
  );
  const { providerRoot, ...preimage } = manifest;
  if (
    semanticRoot(preimage) !== providerRoot ||
    providerRoot !== exported.providerRoot ||
    manifest.semanticRoot !== exported.semanticRoot
  ) {
    throw failure('episode-export-root-mismatch', 'Git export roots disagree');
  }
  const claims = Buffer.from(exported.claims);
  if (sha256Bytes(claims) !== manifest.claims?.digest) {
    throw failure(
      'episode-export-claims-mismatch',
      'Git export claims drifted',
    );
  }
  return sealGitEpisode(
    workspaceRoot,
    {
      semanticRoot: exported.semanticRoot,
      providerRoot: exported.providerRoot,
      manifest,
      claims,
    },
    options,
  );
}

export function inspectEpisodeProviderTemps(workspaceRoot) {
  const root = path.join(workspaceRoot, '.kungfu', 'episodes', '.tmp');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .sort()
    .map((name) => ({
      code: 'incomplete-seal',
      path: path.join(root, name),
    }));
}

export function recoverGitEpisodeLease(
  workspaceRoot,
  semanticRootValue,
  { expectedWriterId, nextGeneration },
) {
  const paths = episodeProviderPaths(workspaceRoot, semanticRootValue);
  let lease;
  try {
    lease = JSON.parse(fs.readFileSync(paths.lease, 'utf8'));
  } catch {
    return {
      status: 'no-lease',
      incomplete: inspectEpisodeProviderTemps(workspaceRoot),
    };
  }
  if (
    lease.writerId !== expectedWriterId ||
    !Number.isSafeInteger(nextGeneration) ||
    nextGeneration <= lease.generation
  ) {
    throw failure(
      'episode-lease-generation-mismatch',
      'recovery must name the previous writer and advance generation',
    );
  }
  fs.rmSync(paths.lease);
  syncDirectory(path.dirname(paths.lease));
  return {
    status: 'lease-recovered',
    previousGeneration: lease.generation,
    nextGeneration,
    incomplete: inspectEpisodeProviderTemps(workspaceRoot),
  };
}

export const EPISODE_PROVIDER_CAPABILITY_MATRIX = Object.freeze([
  {
    provider: 'yijinjing+content-addressed-file',
    authority: true,
    computesSemanticRoot: true,
    preservesQualifiedSemanticRoot: true,
    gitTracked: false,
  },
  {
    provider: 'yijinjing+rocksdb',
    authority: true,
    computesSemanticRoot: true,
    preservesQualifiedSemanticRoot: true,
    gitTracked: false,
  },
  {
    provider: GIT_EPISODE_PROVIDER,
    authority: false,
    computesSemanticRoot: false,
    preservesQualifiedSemanticRoot: true,
    gitTracked: true,
  },
]);
