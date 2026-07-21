import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GIT_EPISODE_PROVIDER,
  fsckGitEpisode,
} from '../../episode-provider/src/git-workspace-episode-provider.mjs';
import {
  buildProjectCut,
  buildSourceProjection,
  canonicalJson,
  createProjectCutReceipt,
  parseRootJson,
  semanticRoot,
  sha256Bytes,
  verifyProjectCut,
  verifyProjectCutReceipt,
} from './project-cut.mjs';

export const SETTLEMENT_REQUEST_SCHEMA = 'project.cut.settlement-request/v1';
export const SETTLEMENT_PLAN_SCHEMA = 'project.cut.settlement-plan/v1';
export const SETTLEMENT_STATE_SCHEMA = 'project.cut.settlement-state/v1';
export const SETTLEMENT_RECEIPT_SCHEMA =
  'project.cut.settlement-action-receipt/v1';
export const ATLAS_PROMOTION_SCHEMA = 'project.cut.atlas-promotion/v1';

const ROOT = /^sha256:[0-9a-f]{64}$/u;
const OID = /^[0-9a-f]{40,64}$/u;
const PROJECT_ID = /^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/u;
const SETTLEMENT_OUTPUT = '.kungfu/project-cuts';
const SETTLEMENT_RUNTIME = '.kungfu/runtime/project-cut/settlements';
const ATLAS_PROMOTIONS = '.xinfa/manifests/project-cuts';
const ATLAS_BASELINES = '.xinfa/baselines/sha256';
const SUPPORTED_VISIBILITIES = new Set(['public', 'internal', 'restricted']);
const GIT_BLOB_BATCH_TARGET_BYTES = 8 * 1024 * 1024;
const CONTRACT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUPPORTED_STATES = new Set([
  'prepared',
  'verified',
  'sealed-unpublished',
  'published',
  'reconciled',
  'abandoned',
]);

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function git(root, args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: options.encoding ?? 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = Buffer.isBuffer(error.stderr)
      ? error.stderr.toString('utf8')
      : String(error.stderr ?? '');
    throw failure(
      options.code ?? 'git-command-failed',
      stderr.trim() || `git ${args[0]} failed`,
      { args },
    );
  }
}

function repositoryRoot(root) {
  return git(root, ['rev-parse', '--show-toplevel']).trim();
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = `${canonicalJson(value)}\n`;
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, bytes, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function writeImmutableJson(path, value) {
  const bytes = `${canonicalJson(value)}\n`;
  if (existsSync(path)) {
    const current = readFileSync(path, 'utf8');
    if (current !== bytes)
      throw failure('immutable-collision', 'content-addressed output differs', {
        path,
      });
    return 'reused';
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { encoding: 'utf8', mode: 0o644 });
  return 'created';
}

const BASELINE_WITNESS_BASENAMES = new Set(['manifest.json', 'receipt.json']);

// Witness files are the small verifiable pointers of a baseline layer: the
// manifest enumerating every material file with its content root, and the
// receipt sealing the verdict. Everything else (atlas.json, views, packs) is
// local immutable material that stays out of Git per ADR-0097 §7.
function isBaselineWitnessFile(relativePath) {
  return BASELINE_WITNESS_BASENAMES.has(posix.basename(relativePath));
}

function relativeFiles(root, prefix = '') {
  return readdirSync(resolve(root, prefix))
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    )
    .flatMap((name) => {
      const relative = prefix ? `${prefix}/${name}` : name;
      return statSync(resolve(root, relative)).isDirectory()
        ? relativeFiles(root, relative)
        : [relative];
    });
}

function writeImmutableDirectory(source, destination) {
  const expected = relativeFiles(source);
  if (!existsSync(destination)) {
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
    return 'created';
  }
  const current = relativeFiles(destination);
  const expectedSet = new Set(expected);
  for (const relative of current) {
    if (!expectedSet.has(relative))
      throw failure(
        'immutable-collision',
        'content-addressed directory differs',
        {
          destination,
          path: relative,
        },
      );
    if (
      !readFileSync(resolve(source, relative)).equals(
        readFileSync(resolve(destination, relative)),
      )
    )
      throw failure('immutable-collision', 'content-addressed file differs', {
        path: resolve(destination, relative),
      });
  }
  if (current.length === expected.length) return 'reused';
  // A partially materialized baseline (for example a fresh clone that only
  // tracks the witness manifest and receipt) is completed in place from the
  // freshly produced immutable material.
  const currentSet = new Set(current);
  for (const relative of expected) {
    if (currentSet.has(relative)) continue;
    const target = resolve(destination, relative);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(resolve(source, relative), target);
  }
  return 'completed';
}

function readRootJson(path) {
  try {
    return parseRootJson(readFileSync(path, 'utf8'));
  } catch (error) {
    throw failure(error.code ?? 'invalid-json', `cannot read ${path}`, {
      cause: String(error.message),
    });
  }
}

function requireRoot(value, label) {
  if (!ROOT.test(String(value)))
    throw failure('missing-root', `${label} must be a lowercase sha256 root`);
  return value;
}

function requireRelativePath(value, label) {
  const text = String(value ?? '');
  if (
    !text ||
    text.startsWith('/') ||
    text.endsWith('/') ||
    text.includes('\\') ||
    text.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    throw failure(
      'invalid-path',
      `${label} must be a safe repository-relative path`,
    );
  return text;
}

function requireFields(value, allowed, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw failure('invalid-type', `${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw failure('unknown-field', `${label}.${key} is not admitted`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key))
      throw failure('missing-field', `${label}.${key} is required`);
  }
}

function sortedUnique(values, key = (value) => value) {
  const sorted = [...values].sort((left, right) =>
    Buffer.compare(
      Buffer.from(key(left), 'utf8'),
      Buffer.from(key(right), 'utf8'),
    ),
  );
  for (let index = 1; index < sorted.length; index += 1) {
    if (key(sorted[index - 1]) === key(sorted[index]))
      throw failure(
        'duplicate-entry',
        `duplicate settlement value: ${key(sorted[index])}`,
      );
  }
  return sorted;
}

function requestDefaults(request) {
  requireFields(
    request,
    [
      'schema',
      'project',
      'parentCutRoots',
      'visibility',
      'authorityMode',
      'source',
      'atlas',
      'episodes',
      'omissions',
      'conflicts',
      'unknowns',
    ],
    ['schema', 'project', 'parentCutRoots', 'visibility', 'atlas', 'episodes'],
    'request',
  );
  if (request?.schema !== SETTLEMENT_REQUEST_SCHEMA)
    throw failure('unknown-version', `expected ${SETTLEMENT_REQUEST_SCHEMA}`);
  requireFields(
    request.project,
    ['id', 'identityRoot'],
    ['id', 'identityRoot'],
    'project',
  );
  if (!PROJECT_ID.test(request.project.id))
    throw failure('invalid-value', 'project.id is invalid');
  requireRoot(request.project.identityRoot, 'project.identityRoot');
  if (!SUPPORTED_VISIBILITIES.has(request.visibility))
    throw failure('invalid-value', 'unsupported settlement visibility');
  if (!request.atlas || typeof request.atlas.mode !== 'string')
    throw failure('missing-field', 'request.atlas is required');
  const allowedAtlasModes = new Set(['existing', 'episode-successor']);
  if (!allowedAtlasModes.has(request.atlas.mode))
    throw failure('invalid-value', 'unsupported Atlas settlement mode');
  if (request.atlas.mode === 'existing') {
    requireFields(request.atlas, ['mode', 'path'], ['mode', 'path'], 'atlas');
    requireRelativePath(request.atlas.path, 'atlas.path');
  } else {
    requireFields(
      request.atlas,
      ['mode', 'before', 'project', 'submission', 'root'],
      ['mode', 'before', 'project', 'submission', 'root'],
      'atlas',
    );
    requireRelativePath(request.atlas.before, 'atlas.before');
    requireRelativePath(request.atlas.project, 'atlas.project');
    requireRelativePath(request.atlas.submission, 'atlas.submission');
    if (request.atlas.root !== '.')
      requireRelativePath(request.atlas.root, 'atlas.root');
  }
  if (
    !Array.isArray(request.parentCutRoots) ||
    !Array.isArray(request.episodes)
  )
    throw failure('invalid-type', 'parentCutRoots and episodes must be arrays');
  const parentCutRoots = sortedUnique(request.parentCutRoots);
  for (const root of parentCutRoots) requireRoot(root, 'parentCutRoots[]');
  const episodes = sortedUnique(
    request.episodes ?? [],
    (entry) => entry.semanticRoot,
  );
  for (const entry of episodes) {
    requireFields(entry, ['semanticRoot'], ['semanticRoot'], 'episodes[]');
    requireRoot(entry.semanticRoot, 'episodes[].semanticRoot');
  }
  const issue = (items = []) => {
    if (!Array.isArray(items))
      throw failure('invalid-type', 'settlement issues must be arrays');
    for (const entry of items) {
      requireFields(
        entry,
        ['code', 'path', 'root', 'detail'],
        ['code', 'path', 'root', 'detail'],
        'issue',
      );
      if (
        !PROJECT_ID.test(entry.code) ||
        typeof entry.path !== 'string' ||
        !entry.path ||
        typeof entry.detail !== 'string' ||
        !entry.detail
      )
        throw failure('invalid-value', 'settlement issue is invalid');
      if (entry.root !== null) requireRoot(entry.root, 'issue.root');
    }
    return sortedUnique(
      items,
      (entry) => `${entry.path}\0${entry.code}\0${entry.root ?? ''}`,
    );
  };
  let source = request.source;
  if (source) {
    requireFields(source, ['visibility'], [], 'source');
    if (source.visibility !== undefined && !Array.isArray(source.visibility))
      throw failure('invalid-type', 'source.visibility must be an array');
    const visibility = sortedUnique(
      source.visibility ?? [],
      (entry) => entry.prefix,
    );
    for (const entry of visibility) {
      requireFields(
        entry,
        ['prefix', 'visibility'],
        ['prefix', 'visibility'],
        'source.visibility[]',
      );
      requireRelativePath(entry.prefix, 'source.visibility[].prefix');
      if (!SUPPORTED_VISIBILITIES.has(entry.visibility))
        throw failure('invalid-value', 'source visibility is invalid');
    }
    source = { visibility };
  }
  return {
    ...structuredClone(request),
    source,
    parentCutRoots,
    episodes,
    omissions: issue(request.omissions),
    conflicts: issue(request.conflicts),
    unknowns: issue(request.unknowns),
  };
}

function policyFor(request) {
  if (request.source?.policyPath)
    throw failure(
      'unsupported-policy',
      'settlement v1 uses the bundled default source policy',
    );
  return readRootJson(
    resolve(CONTRACT_ROOT, 'default-source-projection-policy.json'),
  );
}

function visibilityFor(path, request) {
  const matches = (request.source?.visibility ?? [])
    .filter(
      (entry) => path === entry.prefix || path.startsWith(`${entry.prefix}/`),
    )
    .sort((left, right) => right.prefix.length - left.prefix.length);
  return matches[0]?.visibility ?? request.visibility;
}

function projectionIncludesBytes(policy, path) {
  const metadataOnlyPrefixes = [
    ...policy.privacyDenyPrefixes,
    ...policy.excludePrefixes,
    ...policy.protocolOutputPrefixes,
  ];
  return !metadataOnlyPrefixes.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

export function reconcileIncludesBytes(policy, path) {
  return (
    projectionIncludesBytes(policy, path) ||
    path === SETTLEMENT_OUTPUT ||
    path.startsWith(`${SETTLEMENT_OUTPUT}/`)
  );
}

function indexEntries(root, includeBytes = () => true) {
  const output = git(root, ['ls-files', '-s', '-z'], {
    encoding: 'buffer',
    code: 'index-unavailable',
  });
  const entries = output
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/u.exec(record);
      if (!match)
        throw failure('invalid-index-entry', 'cannot parse Git index');
      if (match[3] !== '0')
        throw failure(
          'unmerged-index',
          'settlement refuses unmerged index entries',
          {
            path: match[4],
          },
        );
      if (!['100644', '100755'].includes(match[1]))
        throw failure(
          'unsupported-index-mode',
          'settlement admits regular files only',
          {
            path: match[4],
            mode: match[1],
          },
        );
      return {
        path: match[4],
        objectId: match[2],
      };
    });
  const blobs = commitBlobs(
    root,
    entries
      .filter((entry) => includeBytes(entry.path))
      .map((entry) => entry.objectId),
  );
  return entries.map((entry) => ({
    path: entry.path,
    bytes: blobs.get(entry.objectId) ?? Buffer.alloc(0),
  }));
}

function commitBlobs(root, objectIds) {
  const uniqueIds = [...new Set(objectIds)];
  if (uniqueIds.length === 0) return new Map();
  const sizeOutput = execFileSync(
    'git',
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    {
      cwd: root,
      input: Buffer.from(`${uniqueIds.join('\n')}\n`, 'utf8'),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const sizeLines = sizeOutput.trimEnd().split('\n');
  if (sizeLines.length !== uniqueIds.length)
    throw failure('invalid-batch-output', 'Git blob size batch is incomplete');
  const descriptors = uniqueIds.map((objectId, index) => {
    const match = /^([0-9a-f]+) blob ([0-9]+)$/u.exec(sizeLines[index]);
    const size = Number(match?.[2]);
    if (
      !match ||
      match[1] !== objectId ||
      !Number.isSafeInteger(size) ||
      size < 0
    )
      throw failure('invalid-batch-output', 'Git blob size is invalid', {
        expected: objectId,
        header: sizeLines[index],
      });
    return { objectId, size };
  });
  const batches = [];
  let batch = [];
  let batchBytes = 0;
  for (const descriptor of descriptors) {
    if (
      batch.length > 0 &&
      batchBytes + descriptor.size > GIT_BLOB_BATCH_TARGET_BYTES
    ) {
      batches.push({ descriptors: batch, bytes: batchBytes });
      batch = [];
      batchBytes = 0;
    }
    batch.push(descriptor);
    batchBytes += descriptor.size;
  }
  if (batch.length > 0) batches.push({ descriptors: batch, bytes: batchBytes });

  const blobs = new Map();
  for (const current of batches) {
    const ids = current.descriptors.map(({ objectId }) => objectId);
    const output = execFileSync('git', ['cat-file', '--batch'], {
      cwd: root,
      input: Buffer.from(`${ids.join('\n')}\n`, 'utf8'),
      encoding: 'buffer',
      maxBuffer: Math.max(
        GIT_BLOB_BATCH_TARGET_BYTES + 1024,
        current.bytes + ids.length * 128 + 1024,
      ),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let offset = 0;
    for (const {
      objectId: expected,
      size: expectedSize,
    } of current.descriptors) {
      const headerEnd = output.indexOf(0x0a, offset);
      if (headerEnd === -1)
        throw failure('invalid-batch-output', 'Git blob header is incomplete');
      const header = output.subarray(offset, headerEnd).toString('utf8');
      const match = /^([0-9a-f]+) blob ([0-9]+)$/u.exec(header);
      if (!match || match[1] !== expected || Number(match[2]) !== expectedSize)
        throw failure('invalid-batch-output', 'Git blob header is invalid', {
          expected,
          header,
        });
      const start = headerEnd + 1;
      const end = start + expectedSize;
      if (output[end] !== 0x0a)
        throw failure(
          'invalid-batch-output',
          'Git blob payload is incomplete',
          {
            objectId: expected,
          },
        );
      blobs.set(expected, output.subarray(start, end));
      offset = end + 1;
    }
    if (offset !== output.length)
      throw failure(
        'invalid-batch-output',
        'Git blob batch has trailing bytes',
      );
  }
  return blobs;
}

function commitEntries(
  root,
  commit,
  pathspec = null,
  includeBytes = () => true,
) {
  const args = ['ls-tree', '-r', '-z', commit];
  if (pathspec) args.push('--', pathspec);
  const output = git(root, args, {
    encoding: 'buffer',
    code: 'commit-unavailable',
  });
  const entries = output
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d{6}) blob ([0-9a-f]+)\t([\s\S]+)$/u.exec(record);
      if (!match) return null;
      if (!['100644', '100755'].includes(match[1])) return null;
      return {
        path: match[3],
        objectId: match[2],
      };
    })
    .filter(Boolean);
  const blobs = commitBlobs(
    root,
    entries
      .filter((entry) => includeBytes(entry.path))
      .map((entry) => entry.objectId),
  );
  return entries.map((entry) => ({
    path: entry.path,
    bytes: blobs.get(entry.objectId) ?? Buffer.alloc(0),
  }));
}

function sourceInput(root, request, policy, entries, additions = []) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry.bytes]));
  for (const entry of additions) byPath.set(entry.path, entry.bytes);
  const sourceEntries = [];
  const omissions = [];
  const matchesPrefix = (path, prefix) =>
    path === prefix || path.startsWith(`${prefix}/`);
  for (const [path, bytes] of byPath) {
    if (
      policy.privacyDenyPrefixes.some((prefix) => matchesPrefix(path, prefix))
    )
      throw failure('privacy-denied', 'private path cannot enter settlement', {
        path,
      });
    const excluded = [
      ...policy.excludePrefixes.map((prefix) => [prefix, 'excluded-by-policy']),
      ...policy.protocolOutputPrefixes.map((prefix) => [
        prefix,
        'protocol-output',
      ]),
    ].find(([prefix]) => matchesPrefix(path, prefix));
    if (excluded) {
      // Protocol outputs are self-referential settlement material. They are
      // excluded silently so verifying a staged or committed cut projects the
      // same source candidate that produced it.
      if (excluded[1] !== 'protocol-output')
        omissions.push({
          path,
          reason: excluded[1],
          visibility: visibilityFor(path, request),
        });
      continue;
    }
    sourceEntries.push({
      path,
      kind:
        path === '.xinfa' ||
        path.startsWith('.xinfa/') ||
        path === '.kungfu' ||
        path.startsWith('.kungfu/')
          ? 'authority'
          : 'source',
      visibility: visibilityFor(path, request),
      digest: sha256Bytes(bytes),
      size: bytes.length,
    });
  }
  return {
    projectId: request.project.id,
    entries: sortedUnique(sourceEntries, (entry) => entry.path),
    omissions: sortedUnique(omissions, (entry) => entry.path),
  };
}

export function sourceProjectionAtCommit(rootInput, commitInput, cut) {
  const root = repositoryRoot(rootInput);
  const commit = git(root, ['rev-parse', `${commitInput}^{commit}`]).trim();
  return sourceProjectionAtTree(root, commit, cut);
}

export function sourceProjectionAtTree(rootInput, treeInput, cut) {
  const root = repositoryRoot(rootInput);
  const tree = git(root, ['rev-parse', `${treeInput}^{tree}`]).trim();
  const policy = readRootJson(
    resolve(CONTRACT_ROOT, 'default-source-projection-policy.json'),
  );
  const request = {
    project: cut.project,
    visibility: cut.visibility,
    source: {},
  };
  const includeBytes = (path) => projectionIncludesBytes(policy, path);
  return buildSourceProjection(
    sourceInput(
      root,
      request,
      policy,
      commitEntries(root, tree, null, includeBytes),
    ),
    policy,
  ).projection;
}

function runXinfa(root, binary, args) {
  const result = spawnSync(resolve(root, binary), args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw failure(
      'xinfa-command-failed',
      result.stderr.trim() || result.stdout.trim(),
      {
        status: result.status,
      },
    );
  try {
    return parseRootJson(result.stdout);
  } catch (error) {
    throw failure(
      'xinfa-receipt-invalid',
      'Xinfa did not return canonical JSON',
      {
        cause: String(error.message),
      },
    );
  }
}

function materializeIndex(root, output) {
  mkdirSync(output, { recursive: true });
  git(root, ['checkout-index', '--all', `--prefix=${output}/`]);
}

function xinfaRoot(value) {
  return sha256Bytes(Buffer.from(`${canonicalJson(value)}\n`, 'utf8'));
}

function atlasMaterial(root, stagedRoot, request, options, output) {
  const atlas = request.atlas;
  const xinfaBinary = options.xinfaBin ? resolve(root, options.xinfaBin) : null;
  if (atlas.mode === 'episode-successor') {
    if (!existsSync(join(output, 'atlas.json'))) {
      if (!xinfaBinary)
        throw failure(
          'xinfa-binary-required',
          '--xinfa-bin is required for successor compile',
        );
      const before = resolve(stagedRoot, atlas.before);
      if (!existsSync(before)) {
        mkdirSync(dirname(before), { recursive: true });
        cpSync(resolve(root, atlas.before), before, { recursive: true });
      }
      runXinfa(stagedRoot, xinfaBinary, [
        'episode',
        'compile',
        '--before',
        atlas.before,
        '--project',
        atlas.project,
        '--submission',
        atlas.submission,
        '--output',
        output,
        '--root',
        atlas.root ?? '.',
        '--json',
      ]);
    }
  } else if (!existsSync(join(output, 'atlas.json'))) {
    cpSync(resolve(root, atlas.path), output, { recursive: true });
  }
  if (xinfaBinary) {
    const verification = runXinfa(stagedRoot, xinfaBinary, [
      'atlas',
      'verify',
      '--atlas',
      output,
      '--json',
    ]);
    if (verification.valid !== true)
      throw failure('atlas-verification-failed', 'Xinfa rejected the Atlas', {
        diagnostics: verification.diagnostics ?? [],
      });
  }
  const atlasValue = readRootJson(join(output, 'atlas.json'));
  const manifest = readRootJson(join(output, 'manifest.json'));
  const receipt = readRootJson(join(output, 'receipt.json'));
  requireRoot(atlasValue.atlas_root, 'atlas.atlas_root');
  const { atlas_root: _atlasRoot, ...atlasPreimage } = atlasValue;
  if (xinfaRoot(atlasPreimage) !== atlasValue.atlas_root)
    throw failure('atlas-root-mismatch', 'Atlas semantic root differs');
  const { manifest_root: _manifestRoot, ...manifestPreimage } = manifest;
  requireRoot(manifest.manifest_root, 'manifest.manifest_root');
  if (xinfaRoot(manifestPreimage) !== manifest.manifest_root)
    throw failure(
      'atlas-manifest-root-mismatch',
      'Atlas manifest root differs',
    );
  const { receipt_root: _receiptRoot, ...receiptPreimage } = receipt;
  requireRoot(receipt.receipt_root, 'receipt.receipt_root');
  if (xinfaRoot(receiptPreimage) !== receipt.receipt_root)
    throw failure('atlas-receipt-root-mismatch', 'Atlas receipt root differs');
  if (
    receipt.verdict !== 'pass' ||
    manifest.atlas_root !== atlasValue.atlas_root ||
    receipt.atlas_root !== atlasValue.atlas_root ||
    receipt.manifest_root !== manifest.manifest_root
  )
    throw failure(
      'atlas-root-mismatch',
      'Atlas artifact, manifest, and receipt disagree',
    );
  const compilerRoot = semanticRoot({
    schema: 'xinfa.compiler-ref/v1',
    product: atlasValue.compiler?.product,
    version: atlasValue.compiler?.version,
    schemaRoot: atlasValue.roots?.schema,
  });
  return { atlasValue, manifest, receipt, compilerRoot };
}

function atlasPromotion(material) {
  const preimage = {
    schema: ATLAS_PROMOTION_SCHEMA,
    atlasRoot: material.atlasValue.atlas_root,
    compilerRoot: material.compilerRoot,
    manifestRoot: material.manifest.manifest_root,
    receiptRoot: material.receipt.receipt_root,
  };
  return { ...preimage, promotionRoot: semanticRoot(preimage) };
}

function episodeMaterial(root, request) {
  return request.episodes.map(({ semanticRoot: rootValue }) => {
    const result = fsckGitEpisode(root, rootValue);
    if (!result.ok)
      throw failure(
        'episode-fsck-failed',
        'qualified Episode provider fsck failed',
        {
          semanticRoot: rootValue,
          result,
        },
      );
    const manifest = result.manifest;
    if (manifest.semanticRoot !== rootValue)
      throw failure('episode-root-mismatch', 'Episode semantic root differs');
    return {
      semanticRoot: rootValue,
      providerRoot: manifest.providerRoot,
      qualificationRoot: manifest.qualificationRoot,
    };
  });
}

function interpretation(policy, episodes) {
  const contract = readRootJson(
    resolve(CONTRACT_ROOT, 'project-cut.contract.json'),
  );
  return {
    schemaRoot: requireRoot(contract.schemaBundle.schemaRoot, 'schemaRoot'),
    protocolRoot: requireRoot(contract.protocolRoot, 'protocolRoot'),
    policyRoots: sortedUnique([policy.policyRoot]),
    providerRoots: sortedUnique(
      episodes.map((episode) => episode.providerRoot),
    ),
  };
}

function normalizeDiagnostics(items) {
  return items
    .map((entry) => ({
      code: entry.code ?? 'settlement-failed',
      path: entry.path ?? '$',
      detail: entry.detail ?? entry.message ?? String(entry),
    }))
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(`${left.path}\0${left.code}\0${left.detail}`, 'utf8'),
        Buffer.from(`${right.path}\0${right.code}\0${right.detail}`, 'utf8'),
      ),
    );
}

function actionReceipt(input) {
  const preimage = { schema: SETTLEMENT_RECEIPT_SCHEMA, ...input };
  return { ...preimage, receiptRoot: semanticRoot(preimage) };
}

function stateValue(input) {
  const preimage = { schema: SETTLEMENT_STATE_SCHEMA, ...input };
  if (!SUPPORTED_STATES.has(input.status))
    throw failure(
      'invalid-state',
      `unsupported settlement state ${input.status}`,
    );
  return { ...preimage, stateRoot: semanticRoot(preimage) };
}

function stagedPaths(root) {
  return new Set(
    git(root, ['diff', '--cached', '--name-only', '-z'])
      .split('\0')
      .filter(Boolean),
  );
}

function unstagedPaths(root) {
  return sortedUnique(
    git(root, ['diff', '--name-only', '-z']).split('\0').filter(Boolean),
  );
}

function buildPlan(input) {
  const preimage = { schema: SETTLEMENT_PLAN_SCHEMA, ...input };
  return { ...preimage, planRoot: semanticRoot(preimage) };
}

export function prepareSettlement(rootInput, requestInput, options = {}) {
  const root = repositoryRoot(rootInput);
  const request = requestDefaults(requestInput);
  const policy = policyFor(request);
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'project-cut-settlement-'));
  const atlasOutput = join(temporaryRoot, 'atlas');
  const stagedRoot = join(temporaryRoot, 'index');
  try {
    const entries = indexEntries(root, (path) =>
      projectionIncludesBytes(policy, path),
    );
    sourceInput(root, request, policy, entries);
    const indexTreeOid = git(root, ['write-tree']).trim();
    materializeIndex(root, stagedRoot);
    const atlas = atlasMaterial(
      root,
      stagedRoot,
      request,
      options,
      atlasOutput,
    );
    const promotion = atlasPromotion(atlas);
    const promotionPath = `${ATLAS_PROMOTIONS}/${promotion.atlasRoot.slice(7)}.json`;
    const promotionBytes = Buffer.from(`${canonicalJson(promotion)}\n`, 'utf8');
    const atlasBaselineDirectory = `${ATLAS_BASELINES}/${promotion.atlasRoot.slice(7)}`;
    const atlasBaselineFiles = relativeFiles(atlasOutput);
    // Only witness files (manifest and receipt at every baseline layer) are
    // published through Git. Baseline material (atlas.json, views, packs) is
    // retained on disk as an ignored immutable store per ADR-0097 §7.
    const atlasBaselineWitnessPaths = atlasBaselineFiles
      .filter(isBaselineWitnessFile)
      .map((path) => `${atlasBaselineDirectory}/${path}`);
    const atlasBaselinePaths = atlasBaselineFiles.map(
      (path) => `${atlasBaselineDirectory}/${path}`,
    );
    const episodes = episodeMaterial(stagedRoot, request);
    const indexBefore = stagedPaths(root);
    const trackedBefore = new Set(entries.map((entry) => entry.path));
    const source = buildSourceProjection(
      sourceInput(root, request, policy, entries, [
        { path: promotionPath, bytes: promotionBytes },
        ...atlasBaselineWitnessPaths.map((path) => ({
          path,
          bytes: readFileSync(
            resolve(atlasOutput, path.slice(atlasBaselineDirectory.length + 1)),
          ),
        })),
      ]),
      policy,
    );
    const cut = buildProjectCut(
      {
        project: request.project,
        parentCutRoots: request.parentCutRoots,
        sourceProjection: {
          schema: 'project.source-projection-ref/v1',
          root: source.projection.root,
          policyRoot: source.policy.policyRoot,
        },
        atlas: {
          schema: 'xinfa.atlas-ref/v1',
          root: atlas.atlasValue.atlas_root,
          compilerRoot: atlas.compilerRoot,
        },
        episodeDelta: {
          schema: 'kungfu.episode-delta-ref/v1',
          empty: episodes.length === 0,
          nativeRoots: sortedUnique(
            episodes.map((episode) => ({
              provider: GIT_EPISODE_PROVIDER,
              root: episode.providerRoot,
            })),
            (entry) => `${entry.provider}\0${entry.root}`,
          ),
          semanticRoot: null,
          equivalenceProfileRoot: null,
        },
        interpretation: interpretation(source.policy, episodes),
        visibility: request.visibility,
        omissions: request.omissions,
        conflicts: request.conflicts,
        unknowns: request.unknowns,
        compatibility: {
          existingRootsPreserved: true,
          authorityMode: request.authorityMode ?? 'bridge',
          relations: [],
        },
      },
      { availableParentRoots: request.parentCutRoots },
    );
    const cutBytes = Buffer.from(`${canonicalJson(cut)}\n`, 'utf8');
    const cutReceipt = createProjectCutReceipt(cut, cutBytes, {
      availableParentRoots: request.parentCutRoots,
    });
    const cutDirectory = `${SETTLEMENT_OUTPUT}/sha256/${cut.cutRoot.slice(7, 9)}/${cut.cutRoot.slice(7)}`;
    const cutPath = `${cutDirectory}/manifest.json`;
    const receiptPath = `${cutDirectory}/receipt.json`;
    if (git(root, ['write-tree']).trim() !== indexTreeOid)
      throw failure(
        'index-changed',
        'Git index changed during settlement prepare',
      );
    const plan = buildPlan({
      action: 'prepare',
      cutRoot: cut.cutRoot,
      sourceProjectionRoot: source.projection.root,
      atlasRoot: atlas.atlasValue.atlas_root,
      episodeProviderRoots: sortedUnique(
        episodes.map((entry) => entry.providerRoot),
      ),
      indexTreeOid,
      unstagedPaths: unstagedPaths(root),
      outputs: [
        promotionPath,
        ...atlasBaselineWitnessPaths,
        cutPath,
        receiptPath,
      ],
      effects: [
        { kind: 'write', path: promotionPath },
        ...atlasBaselinePaths.map((path) => ({ kind: 'write', path })),
        { kind: 'write', path: cutPath },
        { kind: 'write', path: receiptPath },
        ...(options.stage
          ? [
              { kind: 'git-add-explicit', path: promotionPath },
              ...atlasBaselineWitnessPaths.map((path) => ({
                kind: 'git-add-explicit',
                path,
              })),
              { kind: 'git-add-explicit', path: cutPath },
              { kind: 'git-add-explicit', path: receiptPath },
            ]
          : []),
      ],
    });
    const settlementId = cut.cutRoot.slice(7);
    const statePath = `${SETTLEMENT_RUNTIME}/${settlementId}/state.json`;
    let state = null;
    if (options.execute) {
      writeImmutableJson(resolve(root, promotionPath), promotion);
      writeImmutableDirectory(
        atlasOutput,
        resolve(root, atlasBaselineDirectory),
      );
      writeImmutableJson(resolve(root, cutPath), cut);
      writeImmutableJson(resolve(root, receiptPath), cutReceipt);
      if (options.stage)
        git(root, [
          'add',
          '--',
          promotionPath,
          ...atlasBaselineWitnessPaths,
          cutPath,
          receiptPath,
        ]);
      const indexAfter = stagedPaths(root);
      const added = sortedUnique(
        [...indexAfter].filter((path) => !indexBefore.has(path)),
      );
      const expectedAdded = options.stage
        ? sortedUnique(
            [
              promotionPath,
              ...atlasBaselineWitnessPaths,
              cutPath,
              receiptPath,
            ].filter(
              (path) => !indexBefore.has(path) && !trackedBefore.has(path),
            ),
          )
        : [];
      if (canonicalJson(added) !== canonicalJson(expectedAdded))
        throw failure(
          'staging-expanded',
          'settlement changed unexpected index paths',
          {
            added,
            expectedAdded,
          },
        );
      const stateDirectory = resolve(root, dirname(statePath));
      mkdirSync(stateDirectory, { recursive: true });
      const retained = join(stateDirectory, 'atlas');
      if (!existsSync(retained))
        cpSync(atlasOutput, retained, { recursive: true });
      state = stateValue({
        settlementId,
        status: 'prepared',
        planRoot: plan.planRoot,
        cutRoot: cut.cutRoot,
        sourceProjectionRoot: source.projection.root,
        atlasRoot: atlas.atlasValue.atlas_root,
        episodeProviderRoots: plan.episodeProviderRoots,
        preparedIndexTreeOid: options.stage
          ? git(root, ['write-tree']).trim()
          : indexTreeOid,
        outputs: plan.outputs,
        observedCommitOid: null,
        diagnostics: [],
      });
      writeJsonAtomic(resolve(root, statePath), state);
    }
    const receipt = actionReceipt({
      action: 'prepare',
      outcome: options.execute ? 'applied' : 'planned',
      planRoot: plan.planRoot,
      cutRoot: cut.cutRoot,
      sourceProjectionRoot: source.projection.root,
      atlasRoot: atlas.atlasValue.atlas_root,
      indexTreeOid,
      observedCommitOid: null,
      effects: plan.effects,
      diagnostics: [],
    });
    return {
      ok: true,
      action: 'prepare',
      dryRun: !options.execute,
      plan,
      receipt,
      statePath: options.execute ? statePath : null,
      state,
      sourceProjection: source.projection,
      cut,
      cutReceipt,
      promotion,
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function stateFrom(root, statePath) {
  const state = readRootJson(resolve(root, statePath));
  if (state.schema !== SETTLEMENT_STATE_SCHEMA)
    throw failure('unknown-version', `expected ${SETTLEMENT_STATE_SCHEMA}`);
  const { stateRoot, ...preimage } = state;
  if (semanticRoot(preimage) !== stateRoot)
    throw failure('state-root-mismatch', 'settlement state root differs');
  return state;
}

function cutFromState(root, state) {
  const path = state.outputs.find(
    (entry) =>
      entry.startsWith(`${SETTLEMENT_OUTPUT}/sha256/`) &&
      entry.endsWith('/manifest.json'),
  );
  if (!path) throw failure('missing-cut', 'settlement state has no cut path');
  return { path, cut: readRootJson(resolve(root, path)) };
}

function promotionFromState(root, state) {
  const path = state.outputs.find((entry) =>
    entry.startsWith(`${ATLAS_PROMOTIONS}/`),
  );
  if (!path)
    throw failure('missing-atlas', 'settlement state has no Atlas promotion');
  return { path, promotion: readRootJson(resolve(root, path)) };
}

function baselineManifestPathFromState(state) {
  return (
    state.outputs.find((entry) => {
      if (!entry.startsWith(`${ATLAS_BASELINES}/`)) return false;
      const rest = entry.slice(ATLAS_BASELINES.length + 1);
      return /^[0-9a-f]{64}\/manifest\.json$/u.test(rest);
    }) ?? null
  );
}

// Baseline material (atlas.json, views, packs) lives outside Git as an
// ignored immutable store. The tracked baseline manifest enumerates every
// material file with its content root, so missing or drifted material is
// diagnosed against that witness instead of the Git index (ADR-0097 §7).
function verifyBaselineMaterial(root, state) {
  const manifestPath = baselineManifestPathFromState(state);
  if (!manifestPath) return [];
  let manifest;
  try {
    manifest = readRootJson(resolve(root, manifestPath));
  } catch (error) {
    return [
      {
        code: 'atlas-material-missing',
        path: manifestPath,
        detail: `baseline manifest is unreadable: ${String(error.message)}`,
      },
    ];
  }
  const diagnostics = [];
  if (manifest.atlas_root !== state.atlasRoot)
    diagnostics.push({
      code: 'atlas-root-mismatch',
      path: manifestPath,
      detail: 'baseline manifest names another Atlas',
    });
  const baselineDirectory = posix.dirname(manifestPath);
  for (const artifact of manifest.artifacts ?? []) {
    const path = `${baselineDirectory}/${artifact.path}`;
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) {
      diagnostics.push({
        code: 'atlas-material-missing',
        path,
        detail:
          'retained Atlas baseline material is absent from the working tree; restore it from a machine that retains this baseline or recompile the Atlas from its source cut',
      });
      continue;
    }
    if (sha256Bytes(readFileSync(absolute)) !== artifact.content_root)
      diagnostics.push({
        code: 'atlas-material-drift',
        path,
        detail:
          'retained Atlas baseline material differs from the tracked baseline manifest',
      });
  }
  return diagnostics;
}

function verifyAgainstEntries(root, state, entries, mode) {
  const { cut } = cutFromState(root, state);
  const promotion = promotionFromState(root, state);
  const policy = readRootJson(
    resolve(CONTRACT_ROOT, 'default-source-projection-policy.json'),
  );
  const request = {
    project: cut.project,
    visibility: cut.visibility,
    source: {},
  };
  const source = buildSourceProjection(
    sourceInput(root, request, policy, entries),
    policy,
  );
  const diagnostics = [];
  if (source.projection.root !== cut.sourceProjection.root)
    diagnostics.push({
      code: 'source-drift',
      path: '$.sourceProjection.root',
      detail: `${mode} source projection differs`,
    });
  const cutResult = verifyProjectCut(cut, {
    availableParentRoots: cut.parentCutRoots,
  });
  diagnostics.push(...cutResult.diagnostics);
  const receiptPath = state.outputs.find(
    (entry) =>
      entry.startsWith(`${SETTLEMENT_OUTPUT}/sha256/`) &&
      entry.endsWith('/receipt.json'),
  );
  const cutBytes = readFileSync(resolve(root, cutFromState(root, state).path));
  const receipt = readRootJson(resolve(root, receiptPath));
  diagnostics.push(
    ...verifyProjectCutReceipt(receipt, cut, cutBytes, {
      availableParentRoots: cut.parentCutRoots,
    }).diagnostics,
  );
  if (promotion.promotion.atlasRoot !== cut.atlas.root)
    diagnostics.push({
      code: 'atlas-root-mismatch',
      path: '$.atlas.root',
      detail: 'Atlas promotion differs',
    });
  return {
    cut,
    source: source.projection,
    diagnostics: normalizeDiagnostics(diagnostics),
  };
}

export function verifySettlement(rootInput, statePath, options = {}) {
  const root = repositoryRoot(rootInput);
  const state = stateFrom(root, statePath);
  const policy = readRootJson(
    resolve(CONTRACT_ROOT, 'default-source-projection-policy.json'),
  );
  const entries = indexEntries(root, (path) =>
    projectionIncludesBytes(policy, path),
  );
  const indexed = new Set(entries.map((entry) => entry.path));
  const result = verifyAgainstEntries(root, state, entries, 'staged');
  for (const path of state.outputs) {
    if (!indexed.has(path))
      result.diagnostics.push({
        code: 'candidate-not-staged',
        path,
        detail: 'prepared output is not staged',
      });
  }
  result.diagnostics.push(...verifyBaselineMaterial(root, state));
  const valid = result.diagnostics.length === 0;
  let nextState = state;
  if (options.execute) {
    const { stateRoot: _stateRoot, ...core } = state;
    nextState = stateValue({
      ...core,
      status: valid ? 'verified' : 'prepared',
      diagnostics: result.diagnostics,
    });
    writeJsonAtomic(resolve(root, statePath), nextState);
  }
  return {
    ok: valid,
    action: 'verify',
    state: nextState,
    sourceProjection: result.source,
    cut: result.cut,
    receipt: actionReceipt({
      action: 'verify',
      outcome: valid ? 'verified' : 'rejected',
      planRoot: state.planRoot,
      cutRoot: state.cutRoot,
      sourceProjectionRoot: result.source.root,
      atlasRoot: state.atlasRoot,
      indexTreeOid: git(root, ['write-tree']).trim(),
      observedCommitOid: null,
      effects: [],
      diagnostics: result.diagnostics,
    }),
  };
}

function commitHasPath(root, commit, path) {
  try {
    git(root, ['cat-file', '-e', `${commit}:${path}`]);
    return true;
  } catch {
    return false;
  }
}

export function observeSettlementCommit(
  rootInput,
  statePath,
  commitInput,
  options = {},
) {
  const root = repositoryRoot(rootInput);
  const state = stateFrom(root, statePath);
  const commit = git(root, ['rev-parse', `${commitInput}^{commit}`]).trim();
  if (!OID.test(commit))
    throw failure('invalid-commit', 'Git commit OID is invalid');
  const missing = state.outputs.filter(
    (path) => !commitHasPath(root, commit, path),
  );
  let diagnostics = missing.map((path) => ({
    code: 'sealed-unpublished',
    path,
    detail: 'prepared output is absent from observed commit',
  }));
  if (missing.length === 0) {
    const policy = readRootJson(
      resolve(CONTRACT_ROOT, 'default-source-projection-policy.json'),
    );
    diagnostics = [
      ...verifyAgainstEntries(
        root,
        state,
        commitEntries(root, commit, null, (path) =>
          projectionIncludesBytes(policy, path),
        ),
        'committed',
      ).diagnostics,
      ...verifyBaselineMaterial(root, state),
    ];
  }
  const published = missing.length === 0 && diagnostics.length === 0;
  const status = published ? 'published' : 'sealed-unpublished';
  let nextState = state;
  if (options.execute) {
    const { stateRoot: _stateRoot, ...core } = state;
    nextState = stateValue({
      ...core,
      status,
      observedCommitOid: commit,
      diagnostics,
    });
    writeJsonAtomic(resolve(root, statePath), nextState);
  }
  return {
    ok: published,
    action: 'commit-observe',
    state: nextState,
    receipt: actionReceipt({
      action: 'commit-observe',
      outcome: published ? 'published' : 'incomplete',
      planRoot: state.planRoot,
      cutRoot: state.cutRoot,
      sourceProjectionRoot: state.sourceProjectionRoot,
      atlasRoot: state.atlasRoot,
      indexTreeOid: state.preparedIndexTreeOid,
      observedCommitOid: commit,
      effects: [],
      diagnostics,
    }),
  };
}

export function inspectSettlement(rootInput, statePath) {
  const root = repositoryRoot(rootInput);
  const state = stateFrom(root, statePath);
  return {
    ok: true,
    action: 'inspect',
    state,
    cut: cutFromState(root, state).cut,
    promotion: promotionFromState(root, state).promotion,
  };
}

function projectCutPaths(entries) {
  return entries
    .map((entry) => entry.path)
    .filter(
      (path) =>
        path.startsWith(`${SETTLEMENT_OUTPUT}/sha256/`) &&
        path.endsWith('/manifest.json'),
    )
    .sort();
}

function verifyPromotionBytes(bytes, expectedAtlasRoot) {
  const diagnostics = [];
  let promotion;
  try {
    promotion = parseRootJson(bytes.toString('utf8'));
  } catch (error) {
    return [
      { code: 'invalid-atlas', path: '$', detail: String(error.message) },
    ];
  }
  const { promotionRoot, ...preimage } = promotion;
  if (
    promotion.schema !== ATLAS_PROMOTION_SCHEMA ||
    semanticRoot(preimage) !== promotionRoot
  )
    diagnostics.push({
      code: 'atlas-root-mismatch',
      path: '$.promotionRoot',
      detail: 'Atlas promotion root differs',
    });
  if (promotion.atlasRoot !== expectedAtlasRoot)
    diagnostics.push({
      code: 'atlas-root-mismatch',
      path: '$.atlasRoot',
      detail: 'Atlas promotion names another Atlas',
    });
  for (const field of [
    'atlasRoot',
    'compilerRoot',
    'manifestRoot',
    'receiptRoot',
  ]) {
    if (!ROOT.test(String(promotion[field] ?? '')))
      diagnostics.push({
        code: 'missing-root',
        path: `$.${field}`,
        detail: 'Atlas promotion root is missing',
      });
  }
  return diagnostics;
}

function verifyEpisodeProviderEntries(entries, providerRoot) {
  const manifests = entries.filter(
    (entry) =>
      entry.path.endsWith('/manifest.json') &&
      entry.path.includes('/episodes/sealed/'),
  );
  for (const entry of manifests) {
    let manifest;
    try {
      manifest = parseRootJson(entry.bytes.toString('utf8'));
    } catch {
      continue;
    }
    if (manifest.providerRoot !== providerRoot) continue;
    const { providerRoot: _providerRoot, ...preimage } = manifest;
    const diagnostics = [];
    if (semanticRoot(preimage) !== providerRoot)
      diagnostics.push({
        code: 'episode-provider-root-mismatch',
        path: entry.path,
        detail: 'Episode provider root differs',
      });
    const claimsPath = posix.join(
      posix.dirname(entry.path),
      manifest.claims?.path ?? '',
    );
    const claims = entries.find(
      (candidate) => candidate.path === claimsPath,
    )?.bytes;
    if (!claims) {
      diagnostics.push({
        code: 'missing-episode',
        path: claimsPath,
        detail: 'Episode claims are absent',
      });
      return diagnostics;
    }
    const rows = claims.toString('utf8').split('\n').filter(Boolean);
    if (
      claims.at(-1) !== 0x0a ||
      sha256Bytes(claims) !== manifest.claims.digest ||
      rows.length !== manifest.claims.count
    )
      diagnostics.push({
        code: 'episode-claims-mismatch',
        path: claimsPath,
        detail: 'Episode claims framing, digest, or count differs',
      });
    for (const [index, text] of rows.entries()) {
      try {
        const row = JSON.parse(text);
        if (row.index !== index || `${canonicalJson(row)}\n` !== `${text}\n`)
          diagnostics.push({
            code: 'episode-claims-mismatch',
            path: `${claimsPath}:${index}`,
            detail: 'Episode claim is non-canonical or out of order',
          });
      } catch {
        diagnostics.push({
          code: 'episode-claims-mismatch',
          path: `${claimsPath}:${index}`,
          detail: 'Episode claim is malformed',
        });
      }
    }
    return diagnostics;
  }
  return [
    {
      code: 'missing-episode',
      path: '$',
      detail: `provider root ${providerRoot} is absent`,
    },
  ];
}

function episodeProviderRef(entries, providerRoot) {
  for (const entry of entries) {
    if (
      !entry.path.endsWith('/manifest.json') ||
      !entry.path.includes('/episodes/sealed/')
    )
      continue;
    try {
      const manifest = parseRootJson(entry.bytes.toString('utf8'));
      if (manifest.providerRoot === providerRoot)
        return {
          providerRoot,
          semanticRoot: manifest.semanticRoot,
          qualificationRoot: manifest.qualificationRoot,
        };
    } catch {
      // Reconcile diagnostics already retain malformed provider manifests.
    }
  }
  return { providerRoot, semanticRoot: null, qualificationRoot: null };
}

export function reconcileCommit(rootInput, commitInput) {
  const root = repositoryRoot(rootInput);
  const commit = git(root, ['rev-parse', `${commitInput}^{commit}`]).trim();
  const cutEntries = commitEntries(root, commit, SETTLEMENT_OUTPUT);
  const candidatePaths = projectCutPaths(cutEntries);
  const policy = readRootJson(
    resolve(CONTRACT_ROOT, 'default-source-projection-policy.json'),
  );
  const entries =
    candidatePaths.length === 0
      ? cutEntries
      : commitEntries(root, commit, null, (path) =>
          reconcileIncludesBytes(policy, path),
        );
  const byPath = new Map(entries.map((entry) => [entry.path, entry.bytes]));
  const paths =
    candidatePaths.length === 0 ? candidatePaths : projectCutPaths(entries);
  const diagnostics = [];
  if (paths.length === 0)
    diagnostics.push({
      code: 'missing-cut',
      path: '$',
      detail: 'commit contains no Project Cut',
    });
  const parsedCutValues = paths.flatMap((path) => {
    try {
      return [parseRootJson(byPath.get(path).toString('utf8'))];
    } catch {
      return [];
    }
  });
  const availableCutRoots = sortedUnique(
    parsedCutValues.map((cut) => cut.cutRoot),
  );
  const referencedParentRoots = new Set(
    parsedCutValues.flatMap((cut) => cut.parentCutRoots),
  );
  const cuts = paths
    .map((path) => {
      let cut;
      let receiptRoot = null;
      try {
        cut = parseRootJson(byPath.get(path).toString('utf8'));
      } catch (error) {
        diagnostics.push({
          code: 'invalid-cut',
          path,
          detail: String(error.message),
        });
        return null;
      }
      const result = verifyProjectCut(cut, {
        availableParentRoots: availableCutRoots,
      });
      diagnostics.push(
        ...result.diagnostics.map((entry) => ({
          ...entry,
          path: `${path}:${entry.path}`,
        })),
      );
      const receiptPath = posix.join(posix.dirname(path), 'receipt.json');
      if (!byPath.has(receiptPath)) {
        diagnostics.push({
          code: 'missing-cut-receipt',
          path: receiptPath,
          detail: 'Project Cut receipt is absent',
        });
      } else {
        try {
          const receipt = parseRootJson(
            byPath.get(receiptPath).toString('utf8'),
          );
          receiptRoot = receipt.receiptRoot ?? null;
          diagnostics.push(
            ...verifyProjectCutReceipt(receipt, cut, byPath.get(path), {
              availableParentRoots: availableCutRoots,
            }).diagnostics.map((entry) => ({
              ...entry,
              path: `${receiptPath}:${entry.path}`,
            })),
          );
        } catch (error) {
          diagnostics.push({
            code: 'invalid-cut-receipt',
            path: receiptPath,
            detail: String(error.message),
          });
        }
      }
      const promotionPath = `${ATLAS_PROMOTIONS}/${cut.atlas.root.slice(7)}.json`;
      if (!byPath.has(promotionPath))
        diagnostics.push({
          code: 'missing-atlas',
          path: promotionPath,
          detail: 'Atlas promotion is absent',
        });
      else
        diagnostics.push(
          ...verifyPromotionBytes(byPath.get(promotionPath), cut.atlas.root),
        );
      for (const native of cut.episodeDelta.nativeRoots) {
        diagnostics.push(...verifyEpisodeProviderEntries(entries, native.root));
      }
      const request = {
        project: cut.project,
        visibility: cut.visibility,
        source: {},
      };
      const projection = buildSourceProjection(
        sourceInput(root, request, policy, entries),
        policy,
      ).projection;
      const isLeaf = !referencedParentRoots.has(cut.cutRoot);
      if (isLeaf && projection.root !== cut.sourceProjection.root)
        diagnostics.push({
          code: 'source-drift',
          path,
          detail: 'committed source projection differs',
        });
      return {
        path,
        cutRoot: cut.cutRoot,
        sourceProjectionRoot: isLeaf
          ? projection.root
          : cut.sourceProjection.root,
        atlasRoot: cut.atlas.root,
        parentCutRoots: cut.parentCutRoots,
        receiptRoot,
        episodes: cut.episodeDelta.nativeRoots.map((entry) =>
          episodeProviderRef(entries, entry.root),
        ),
      };
    })
    .filter(Boolean);
  const normalizedDiagnostics = normalizeDiagnostics(diagnostics);
  return {
    ok: normalizedDiagnostics.length === 0,
    action: 'reconcile',
    commit,
    cuts,
    diagnostics: normalizedDiagnostics,
    ...(paths.length === 0
      ? {
          recovery: {
            action: 'prepare-project-cut',
            command:
              './shifu project-cut prepare --request settlement-request.json --json',
            detail:
              'Create settlement-request.json if absent, inspect the dry-run, rerun with --execute --stage, commit the outputs, then reconcile the new commit.',
          },
        }
      : {}),
    receipt: actionReceipt({
      action: 'reconcile',
      outcome: normalizedDiagnostics.length === 0 ? 'reconciled' : 'incomplete',
      planRoot: null,
      cutRoot: cuts.length === 1 ? cuts[0].cutRoot : null,
      sourceProjectionRoot:
        cuts.length === 1 ? cuts[0].sourceProjectionRoot : null,
      atlasRoot: null,
      indexTreeOid: null,
      observedCommitOid: commit,
      effects: [],
      diagnostics: normalizedDiagnostics,
    }),
  };
}

export function abandonSettlement(rootInput, statePath, options = {}) {
  const root = repositoryRoot(rootInput);
  const state = stateFrom(root, statePath);
  if (!options.execute)
    return { ok: true, action: 'abandon', dryRun: true, state };
  const { stateRoot: _stateRoot, ...core } = state;
  const nextState = stateValue({
    ...core,
    status: 'abandoned',
    diagnostics: [
      {
        code: 'abandoned',
        path: '$',
        detail: 'candidate explicitly abandoned',
      },
    ],
  });
  writeJsonAtomic(resolve(root, statePath), nextState);
  return { ok: true, action: 'abandon', dryRun: false, state: nextState };
}
