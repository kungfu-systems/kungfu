#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const XINFA_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const MANIFEST_NAME = 'schema-set-manifest-v1.json';
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/;

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort(compareUtf8);
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function schemaFiles(root) {
  return fs
    .readdirSync(path.join(root, 'schema'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.schema.json'))
    .map((entry) => `schema/${entry.name}`)
    .sort(compareUtf8);
}

function readSchema(root, relative) {
  const bytes = fs.readFileSync(path.join(root, relative));
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}

export function refreshSchemaSet(root, manifest) {
  const schemas = new Map(
    schemaFiles(root).map((relative) => [relative, readSchema(root, relative)]),
  );
  const members = [...schemas].map(([relative, schema]) => ({
    path: relative,
    uri: schema.value.$id,
    sha256: sha256(schema.bytes),
  }));
  const fullSet = Object.fromEntries(
    [...schemas].map(([relative, schema]) => [relative, schema.value]),
  );
  const rootSets = manifest.rootSets.map((rootSet) => {
    const preimage = {};
    for (const entry of rootSet.entries) {
      const schema = schemas.get(entry.path);
      if (!schema) throw new Error(`${rootSet.id}: missing ${entry.path}`);
      if (Object.hasOwn(preimage, entry.key)) {
        throw new Error(`${rootSet.id}: duplicate key ${entry.key}`);
      }
      preimage[entry.key] = schema.value;
    }
    return {
      ...rootSet,
      root: sha256(`${canonicalJson(preimage)}\n`),
    };
  });
  return {
    ...manifest,
    schemaSetRoot: sha256(`${canonicalJson(fullSet)}\n`),
    members,
    rootSets,
  };
}

export function validateSchemaSet(
  root = XINFA_ROOT,
  manifestValue = undefined,
) {
  const manifest =
    manifestValue ??
    JSON.parse(fs.readFileSync(path.join(root, MANIFEST_NAME), 'utf8'));
  const findings = [];
  if (manifest.schema !== 'xinfa.schema-set-manifest/v1') {
    findings.push('manifest schema must be xinfa.schema-set-manifest/v1');
  }
  if (manifest.product !== 'xinfa') findings.push('product must be xinfa');
  if (manifest.hashAlgorithm !== 'sha256') {
    findings.push('hashAlgorithm must be sha256');
  }
  if (manifest.memberDigestAlgorithm !== 'sha256-file-bytes/v1') {
    findings.push('memberDigestAlgorithm must bind exact file bytes');
  }
  if (
    manifest.canonicalization !==
    'utf8-json-object-keys-byte-sorted-no-insignificant-whitespace-lf/v1'
  ) {
    findings.push('canonicalization contract is unsupported');
  }
  if (!ROOT_PATTERN.test(manifest.schemaSetRoot || '')) {
    findings.push('schemaSetRoot must be a SHA-256 root');
  }
  if (!Array.isArray(manifest.members) || manifest.members.length === 0) {
    findings.push('members must be a non-empty array');
  }
  if (!Array.isArray(manifest.rootSets) || manifest.rootSets.length === 0) {
    findings.push('rootSets must be a non-empty array');
  }
  if (findings.length) return findings;

  const expectedPaths = schemaFiles(root);
  const declaredPaths = manifest.members.map((member) => member.path);
  if (JSON.stringify(declaredPaths) !== JSON.stringify(expectedPaths)) {
    findings.push('members must list every schema path in UTF-8 byte order');
  }
  const members = new Map();
  for (const member of manifest.members) {
    if (members.has(member.path)) {
      findings.push(`duplicate member path: ${member.path}`);
      continue;
    }
    const absolute = path.join(root, member.path);
    if (!fs.existsSync(absolute)) {
      findings.push(`missing schema: ${member.path}`);
      continue;
    }
    const schema = readSchema(root, member.path);
    members.set(member.path, schema.value);
    if (schema.value.$id !== member.uri) {
      findings.push(`${member.path}: URI differs from the schema $id`);
    }
    const observed = sha256(schema.bytes);
    if (member.sha256 !== observed) {
      findings.push(`${member.path}: byte digest drifted`);
    }
  }

  let refreshed;
  try {
    refreshed = refreshSchemaSet(root, manifest);
  } catch (error) {
    findings.push(error instanceof Error ? error.message : String(error));
    return findings;
  }
  if (manifest.schemaSetRoot !== refreshed.schemaSetRoot) {
    findings.push('complete schema-set root drifted');
  }
  const seenSetIds = new Set();
  for (let index = 0; index < manifest.rootSets.length; index += 1) {
    const rootSet = manifest.rootSets[index];
    if (seenSetIds.has(rootSet.id))
      findings.push(`duplicate root set: ${rootSet.id}`);
    seenSetIds.add(rootSet.id);
    if (rootSet.rootAlgorithm !== 'sha256-canonical-json-object-v1') {
      findings.push(`${rootSet.id}: unsupported root algorithm`);
    }
    if (rootSet.root !== refreshed.rootSets[index]?.root) {
      findings.push(`${rootSet.id}: root drifted`);
    }
    const keys = rootSet.entries.map((entry) => entry.key);
    if (new Set(keys).size !== keys.length) {
      findings.push(`${rootSet.id}: entry keys must be unique`);
    }
    for (const entry of rootSet.entries) {
      if (!members.has(entry.path)) {
        findings.push(`${rootSet.id}: undeclared schema member ${entry.path}`);
      }
    }
  }

  const atlasSet = manifest.rootSets.find(
    (rootSet) => rootSet.id === 'xinfa.atlas-schema-set/v1',
  );
  const golden = JSON.parse(
    fs.readFileSync(
      path.join(root, 'fixtures', 'golden', 'repository-small-atlas-v1.json'),
      'utf8',
    ),
  );
  if (!atlasSet) findings.push('xinfa.atlas-schema-set/v1 is required');
  else if (atlasSet.root !== golden.schema_root) {
    findings.push('Atlas schema-set root differs from the retained golden');
  }
  return findings;
}

function main() {
  const manifestPath = path.join(XINFA_ROOT, MANIFEST_NAME);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (process.argv.includes('--write')) {
    const refreshed = refreshSchemaSet(XINFA_ROOT, manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(refreshed, null, 2)}\n`);
  }
  const findings = validateSchemaSet();
  if (findings.length) {
    throw new Error(`Xinfa schema-set violations:\n${findings.join('\n')}`);
  }
  const current = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const atlas = current.rootSets.find(
    (rootSet) => rootSet.id === 'xinfa.atlas-schema-set/v1',
  );
  console.log(
    `[xinfa-schema-set] members=${current.members.length} root=${current.schemaSetRoot} atlas=${atlas.root}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(
      `[xinfa-schema-set] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
