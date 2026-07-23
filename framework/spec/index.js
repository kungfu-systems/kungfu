// @kungfu-tech/spec — portable bundle inspection and verification.
// @ts-check

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const pkgRoot = __dirname;
const manifestSchemaPath = path.join(pkgRoot, 'schema', 'manifest.schema.json');
const manifestPath = path.join(pkgRoot, 'dist', 'manifest.json');
const conformanceBundlePath = path.join(
  pkgRoot,
  'conformance',
  'unknown-record',
);

/** @param {import('node:crypto').BinaryLike} value */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {string} message */
function fail(message) {
  throw new Error(message);
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
  return {
    status: 'passing',
    spec_version: bundle.manifest.spec_version,
    format_version: bundle.manifest.format_version,
    event_count: events.length,
    segment_sha256: sha256(body),
    unknown_records: events.filter(
      (event) => !bundle.manifest.schema_bindings?.[String(event.msg_type)],
    ).length,
  };
}

/** @param {string} input */
function inspectBundle(input) {
  const verified = verifyBundle(input);
  return {
    ...verified,
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
    status: 'passing',
    segment_sha256: after.segment_sha256,
    unknown_records_preserved: after.unknown_records,
  };
}

module.exports = {
  conformanceBundlePath,
  inspectBundle,
  manifestPath,
  manifestSchemaPath,
  preserveBundle,
  verifyBundle,
};
