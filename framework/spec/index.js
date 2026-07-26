// @kungfu-tech/spec — portable bundle inspection and verification.
// @ts-check

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const pkgRoot = __dirname;
const bundleRoot = path.join(pkgRoot, 'dist');
const manifestSchemaPath = path.join(pkgRoot, 'schema', 'manifest.schema.json');
const manifestPath = path.join(bundleRoot, 'manifest.json');
const conformanceBundlePath = path.join(
  pkgRoot,
  'conformance',
  'unknown-record',
);
function readerProfiles() {
  const generated = JSON.parse(
    fs.readFileSync(path.join(bundleRoot, 'reader-matrix.json'), 'utf8'),
  );
  return generated.profiles;
}

/** @param {string} id */
function readerProfile(id) {
  const profile = readerProfiles().find(
    /** @param {{id: string}} entry */
    (entry) => entry.id === id,
  );
  if (!profile) fail(`required reader profile is missing: ${id}`);
  return profile;
}

/** @param {import('node:crypto').BinaryLike} value */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {unknown} value @returns {any} */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

/** @param {unknown} value */
function rootedJson(value) {
  return `sha256:${sha256(`${JSON.stringify(canonical(value), null, 2)}\n`)}`;
}

/** @param {string} message */
function fail(message) {
  throw new Error(message);
}

function authorityManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

/** @param {string} id */
function authorityArtifact(id) {
  const manifest = authorityManifest();
  const descriptor = manifest.artifacts?.[id];
  if (!descriptor) fail(`unknown authority artifact: ${id}`);
  const absolute = path.resolve(bundleRoot, descriptor.path);
  if (!absolute.startsWith(`${bundleRoot}${path.sep}`))
    fail(`authority artifact escapes the installed bundle: ${id}`);
  const bytes = fs.readFileSync(absolute);
  const actualRoot = `sha256:${sha256(bytes)}`;
  if (actualRoot !== descriptor.artifact_root)
    fail(`authority artifact root mismatch: ${id}`);
  if (bytes.length !== descriptor.byte_length)
    fail(`authority artifact length mismatch: ${id}`);
  return {
    id,
    descriptor,
    value: JSON.parse(bytes.toString('utf8')),
  };
}

function inspectAuthority() {
  const manifest = authorityManifest();
  const resolved = Object.fromEntries(
    Object.keys(manifest.artifacts).map((id) => {
      const artifact = authorityArtifact(id);
      return [id, artifact.value];
    }),
  );
  return {
    status: 'read',
    format_namespace: manifest.format_namespace,
    spec_version: manifest.spec_version,
    normative_status: manifest.normative.status,
    normative_root: manifest.normative.root,
    reproducibility: manifest.normative.reproducibility,
    artifacts: Object.fromEntries(
      Object.entries(manifest.artifacts).map(([id, value]) => [
        id,
        {
          path: value.path,
          root: value.artifact_root,
          schema: value.schema,
          status: value.status,
          source_roots: value.source_roots,
        },
      ]),
    ),
    authority: resolved.authority,
    compatibility: resolved.compatibility,
    migration: resolved.migration,
    vectors: resolved.conformance_vectors,
    non_claims: manifest.normative.non_claims,
  };
}

function verifyAuthorityBundle() {
  const manifest = authorityManifest();
  const failures = [];
  for (const id of Object.keys(manifest.artifacts)) {
    try {
      authorityArtifact(id);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  let vectorCount = 0;
  try {
    const vectors = authorityArtifact('conformance_vectors').value;
    for (const vector of vectors.vectors) {
      vectorCount += 1;
      const absolute = path.resolve(
        bundleRoot,
        'vectors',
        vectors.latest_release,
        vector.path,
      );
      if (!absolute.startsWith(`${bundleRoot}${path.sep}`))
        fail(`retained vector escapes the installed bundle: ${vector.id}`);
      const bytes = fs.readFileSync(absolute);
      if (bytes.length !== vector.byteLength)
        fail(`retained vector length mismatch: ${vector.id}`);
      if (`sha256:${sha256(bytes)}` !== vector.byteRoot)
        fail(`retained vector root mismatch: ${vector.id}`);
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  if (rootedJson(manifest.normative.preimage) !== manifest.normative.root)
    failures.push('normative root mismatch');
  if (failures.length) fail(failures.join('; '));
  return {
    status: 'read',
    normative_root: manifest.normative.root,
    artifact_count: Object.keys(manifest.artifacts).length,
    vector_count: vectorCount,
    source_binding_count: Object.values(manifest.artifacts).reduce(
      (total, artifact) => total + artifact.source_roots.length,
      0,
    ),
  };
}

function conformanceIndex() {
  return authorityArtifact('conformance_vectors').value;
}

/** @param {string} vectorId */
function resolveConformanceVector(vectorId) {
  const vectors = conformanceIndex();
  const descriptor = vectors.vectors.find(
    /** @param {{id:string}} vector */
    (vector) => vector.id === vectorId,
  );
  if (!descriptor) fail(`unknown conformance vector: ${vectorId}`);
  const absolute = path.resolve(
    bundleRoot,
    'vectors',
    vectors.latest_release,
    descriptor.path,
  );
  if (!absolute.startsWith(`${bundleRoot}${path.sep}`))
    fail(`retained vector escapes the installed bundle: ${vectorId}`);
  return { vectors, descriptor, absolute };
}

function inspectConformance() {
  const vectors = conformanceIndex();
  const capabilities = authorityArtifact('capabilities').value;
  return {
    status: vectors.status,
    release: vectors.latest_release,
    release_root: vectors.latest_release_root,
    previous_release_root: vectors.release?.previous_release_root || null,
    append_policy: vectors.append_policy,
    vector_count: vectors.vectors.length,
    axes: [
      ...new Set(vectors.vectors.flatMap((vector) => vector.axes || [])),
    ].sort(),
    outcomes: Object.fromEntries(
      Object.entries(capabilities.outcomes).map(([id, outcome]) => [
        id,
        { meaning: outcome.meaning, terminal: outcome.terminal },
      ]),
    ),
    vectors: vectors.vectors.map((vector) => ({
      id: vector.id,
      axes: vector.axes,
      layer: vector.layer,
      protocol: vector.protocol,
      reader_profile: vector.readerProfile,
      expected: vector.expected,
      oracles: vector.oracles,
      byte_length: vector.byteLength,
      byte_root: vector.byteRoot,
    })),
  };
}

/** @param {string} vectorId */
function conformanceVector(vectorId) {
  const { vectors, descriptor, absolute } = resolveConformanceVector(vectorId);
  const bytes = fs.readFileSync(absolute);
  if (bytes.length !== descriptor.byteLength)
    fail(`retained vector length mismatch: ${vectorId}`);
  if (`sha256:${sha256(bytes)}` !== descriptor.byteRoot)
    fail(`retained vector root mismatch: ${vectorId}`);
  return {
    status: 'read',
    release: vectors.latest_release,
    release_root: vectors.latest_release_root,
    id: descriptor.id,
    package_path: path.relative(bundleRoot, absolute).split(path.sep).join('/'),
    descriptor: structuredClone(descriptor),
  };
}

function verifyConformanceCorpus() {
  const vectors = conformanceIndex();
  for (const vector of vectors.vectors) conformanceVector(vector.id);
  return {
    status: 'read',
    verification_scope: 'retained-byte-roots',
    release: vectors.latest_release,
    release_root: vectors.latest_release_root,
    vector_count: vectors.vectors.length,
  };
}

/** @param {string} input */
function resolveBundle(input) {
  const absolute = path.resolve(input);
  const manifestFile = fs.statSync(absolute).isDirectory()
    ? path.join(absolute, 'manifest.json')
    : absolute;
  const root = path.dirname(manifestFile);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const declared = manifest.event_log?.path;
  if (typeof declared !== 'string' || !declared)
    fail('manifest.event_log.path is required');
  const eventLog = path.isAbsolute(declared)
    ? path.join(root, path.basename(declared))
    : path.resolve(root, declared);
  if (!eventLog.startsWith(`${root}${path.sep}`))
    fail('event log must remain inside the portable bundle');
  return { root, manifestFile, manifest, eventLog };
}

/** @param {string} eventLog */
function readEvents(eventLog) {
  const body = fs.readFileSync(eventLog);
  const text = body.toString('utf8');
  const lines = text.endsWith('\n')
    ? text.slice(0, -1).split('\n')
    : text.split('\n');
  return {
    body,
    events: lines.filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        fail(
          `event ${index} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  };
}

/** @param {string} input */
function verifyBundle(input) {
  const bundle = resolveBundle(input);
  const { body, events } = readEvents(bundle.eventLog);
  const failures = [];
  if (bundle.manifest.hash_algorithm !== 'sha256')
    failures.push('hash_algorithm must be sha256');
  if (sha256(body) !== bundle.manifest.event_log.segment_sha256)
    failures.push('event log segment checksum mismatch');
  if (events.length !== bundle.manifest.event_count)
    failures.push('event_count does not match the event log');
  let previous = '0';
  for (const [index, event] of events.entries()) {
    if (event.seq !== index) failures.push(`event ${index} sequence mismatch`);
    if (String(event.trigger_frame_uid) !== previous)
      failures.push(`event ${index} causal parent mismatch`);
    previous = String(event.frame_uid);
    if (sha256(String(event.payload_raw ?? '')) !== event.payload_sha256)
      failures.push(`event ${index} payload checksum mismatch`);
    const receipt = bundle.manifest.event_checksums?.[index];
    if (
      !receipt ||
      receipt.seq !== event.seq ||
      String(receipt.frame_uid) !== String(event.frame_uid) ||
      receipt.payload_sha256 !== event.payload_sha256
    )
      failures.push(`event ${index} manifest receipt mismatch`);
  }
  if (bundle.manifest.causal_chain_verified !== true)
    failures.push('manifest does not declare a verified causal chain');
  if (failures.length) fail(failures.join('; '));
  const unknownRecords = events.filter(
    (event) => !bundle.manifest.schema_bindings?.[String(event.msg_type)],
  ).length;
  const profile = readerProfile('structural-verification');
  const outcome = unknownRecords > 0 ? profile.unknownOutcome : 'read';
  return {
    status: outcome,
    structural_verification: 'complete',
    semantic_verification: unknownRecords > 0 ? 'incomplete' : 'complete',
    spec_version: bundle.manifest.spec_version,
    format_version: bundle.manifest.format_version,
    event_count: events.length,
    segment_sha256: sha256(body),
    unknown_records: unknownRecords,
  };
}

/** @param {string} input */
function inspectBundle(input) {
  const verified = verifyBundle(input);
  return {
    ...verified,
    status:
      verified.unknown_records > 0
        ? readerProfile('inspection').unknownOutcome
        : 'read',
    capabilities: ['open', 'inspect', 'verify', 'preserve_unknowns'],
  };
}

/**
 * @param {string} input
 * @param {string} output
 */
function preserveBundle(input, output) {
  const source = resolveBundle(input);
  const before = verifyBundle(input);
  const destination = path.resolve(output);
  if (fs.existsSync(destination)) fail(`output already exists: ${destination}`);
  fs.cpSync(source.root, destination, { recursive: true, errorOnExist: true });
  const after = verifyBundle(destination);
  if (before.segment_sha256 !== after.segment_sha256)
    fail('preservation changed the event log');
  return {
    status:
      after.unknown_records > 0
        ? readerProfile('preservation').unknownOutcome
        : 'read',
    segment_sha256: after.segment_sha256,
    unknown_records_preserved: after.unknown_records,
  };
}

module.exports = {
  authorityArtifact,
  authorityManifest,
  bundleRoot,
  conformanceBundlePath,
  conformanceVector,
  inspectAuthority,
  inspectBundle,
  inspectConformance,
  manifestPath,
  manifestSchemaPath,
  preserveBundle,
  verifyAuthorityBundle,
  verifyBundle,
  verifyConformanceCorpus,
};
