#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// KF-ADR-019f86da-4f90-71eb-b4c0-376ca7bc7ad3 executable boundary: one structured-fact owner, JSON only at named
// edges, and SQLite projection selected by that owner.
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MANIFEST = 'framework/core/schema-authority.json';
const CONTRACT_REGISTRY =
  'framework/spec/contract/kungfu-contracts.registry.json';

const EXPECTED_ROUTE = {
  hana: 'hana-sqlite-orm',
  flatbuffers: 'flatbuffers-bfbs',
};

function filesBelow(root, accept) {
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const value = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...filesBelow(value, accept));
    else if (accept(value)) found.push(value);
  }
  return found;
}

function relative(value) {
  return path.relative(ROOT, value).split(path.sep).join('/');
}

function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

export function validateManifest(manifest) {
  const errors = [];
  if (manifest?.schema_version !== 1) errors.push('schema_version must be 1');
  const authorities = Array.isArray(manifest?.authorities)
    ? manifest.authorities
    : [];
  const identities = new Map();
  for (const authority of authorities) {
    const identity = String(authority?.identity || '');
    const owner = String(authority?.owner || '');
    if (!identity) errors.push('authority identity is required');
    if (!(owner in EXPECTED_ROUTE))
      errors.push(
        `${identity || '<unknown>'}: owner must be hana or flatbuffers`,
      );
    if (identities.has(identity))
      errors.push(
        `${identity}: multiple schema owners (${identities.get(identity)} and ${owner})`,
      );
    identities.set(identity, owner);
    if (authority?.projection_route !== EXPECTED_ROUTE[owner])
      errors.push(
        `${identity}: ${owner} must use ${EXPECTED_ROUTE[owner]}, not ${authority?.projection_route || '<missing>'}`,
      );
    if (!authority?.declaration)
      errors.push(`${identity}: declaration is required`);
    if (owner === 'hana' && !authority?.symbol)
      errors.push(`${identity}: Hana registry symbol is required`);
    if (owner === 'flatbuffers' && !authority?.derived_schema)
      errors.push(`${identity}: FlatBuffers .bfbs derivative is required`);
  }

  for (const view of manifest?.non_authorities || []) {
    if (!['typed-view', 'opaque-body'].includes(view?.kind))
      errors.push(
        `${view?.identity || '<unknown>'}: invalid non-authority kind`,
      );
    if (view?.owner)
      errors.push(`${view.identity}: non-authority cannot declare owner`);
    if (view?.kind === 'typed-view' && !identities.has(view?.derives_from))
      errors.push(
        `${view.identity}: typed view must derive from a declared authority`,
      );
    if (!view?.reason)
      errors.push(`${view?.identity || '<unknown>'}: reason is required`);
  }

  for (const edge of manifest?.json_edges || []) {
    if (!['public-edge', 'implementation-edge'].includes(edge?.surface))
      errors.push(
        `${edge?.path || '<unknown>'}: JSON is not allowed in ${edge?.surface || '<missing>'}`,
      );
    for (const field of ['path', 'direction', 'reason', 'remove_when']) {
      if (!edge?.[field])
        errors.push(
          `JSON edge ${edge?.path || '<unknown>'}: ${field} is required`,
        );
    }
  }
  return errors;
}

export function validateContractSchemaArtifactBindings(
  registry,
  contractsBySource,
) {
  const errors = [];
  for (const entry of registry?.contracts || []) {
    const contract = contractsBySource[entry.source];
    if (!contract || !contract.schemaFiles) continue;
    const registered = new Set(
      (entry.extraArtifacts || []).map(
        (artifact) => `${artifact.source}\0${artifact.artifact}`,
      ),
    );
    for (const [name, schemaFile] of Object.entries(contract.schemaFiles)) {
      if (!schemaFile?.source || !schemaFile?.artifact) {
        errors.push(
          `${entry.surface} contract schemaFiles.${name} must declare source and artifact`,
        );
        continue;
      }
      const source = path.posix.join(
        path.posix.dirname(entry.source),
        schemaFile.source,
      );
      const artifact = path.posix.join(
        path.posix.dirname(entry.artifact),
        schemaFile.artifact,
      );
      if (!registered.has(`${source}\0${artifact}`)) {
        errors.push(
          `${entry.surface} contract schemaFiles.${name} is not frozen by registry extraArtifacts: ${source} -> ${artifact}`,
        );
      }
    }
  }
  return errors;
}

function validateContractSchemaArtifacts(root) {
  const registry = JSON.parse(
    fs.readFileSync(path.join(root, CONTRACT_REGISTRY), 'utf8'),
  );
  const contractsBySource = Object.fromEntries(
    (registry.contracts || []).map((entry) => [
      entry.source,
      JSON.parse(fs.readFileSync(path.join(root, entry.source), 'utf8')),
    ]),
  );
  return validateContractSchemaArtifactBindings(registry, contractsBySource);
}

export function validateRepository(root = ROOT) {
  const errors = [];
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, MANIFEST), 'utf8'),
  );
  errors.push(...validateManifest(manifest));
  errors.push(...validateContractSchemaArtifacts(root));

  const authorities = manifest.authorities || [];
  const declaredFbs = new Set();
  const declaredHana = new Set();
  for (const authority of authorities) {
    const declaration = path.join(root, authority.declaration || '');
    if (!fs.existsSync(declaration)) {
      errors.push(
        `${authority.identity}: declaration does not exist: ${authority.declaration}`,
      );
      continue;
    }
    if (authority.owner === 'hana') {
      declaredHana.add(authority.symbol);
      if (!fs.readFileSync(declaration, 'utf8').includes(authority.symbol))
        errors.push(
          `${authority.identity}: declaration does not contain ${authority.symbol}`,
        );
    } else if (authority.owner === 'flatbuffers') {
      declaredFbs.add(authority.declaration);
      if (!fs.existsSync(path.join(root, authority.derived_schema || '')))
        errors.push(
          `${authority.identity}: missing derived .bfbs ${authority.derived_schema}`,
        );
    }
  }

  const productionFbs = filesBelow(
    path.join(root, 'framework/core/src'),
    (file) => file.endsWith('.fbs'),
  ).map(relative);
  for (const file of productionFbs) {
    if (!declaredFbs.has(file))
      errors.push(`${file}: production .fbs has no authority entry`);
  }
  for (const file of declaredFbs) {
    if (!productionFbs.includes(file))
      errors.push(`${file}: authority entry is not a production .fbs`);
  }

  const sourceFiles = filesBelow(
    path.join(root, 'framework/core/src'),
    (file) => /\.(?:h|hpp|cpp|cc|cxx)$/.test(file),
  );
  const projectedHana = new Set();
  const storageCall =
    /make_storage_ptr\([^;\n]*?(?:yijinjing::)?([A-Za-z][A-Za-z0-9]*DataTypes)\b/g;
  for (const file of sourceFiles) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(storageCall)) projectedHana.add(match[1]);
  }
  for (const symbol of projectedHana) {
    if (!declaredHana.has(symbol))
      errors.push(
        `${symbol}: make_storage_ptr registry has no Hana authority entry`,
      );
  }
  for (const symbol of declaredHana) {
    if (!projectedHana.has(symbol))
      errors.push(
        `${symbol}: declared Hana projection never reaches make_storage_ptr`,
      );
  }

  const boundaryPath = path.join(
    root,
    manifest.flatbuffers_projection_boundary || '',
  );
  if (!fs.existsSync(boundaryPath)) {
    errors.push('flatbuffers_projection_boundary does not exist');
  } else {
    const boundary = withoutComments(fs.readFileSync(boundaryPath, 'utf8'));
    if (!boundary.includes('schema_handle'))
      errors.push('FlatBuffers projection boundary must own a schema_handle');
    if (/make_storage_ptr|sqlite_orm/.test(boundary))
      errors.push(
        'FlatBuffers projection boundary must not use Hana/sqlite_orm',
      );
  }

  const publicJsonEdges = new Set(
    (manifest.json_edges || [])
      .filter((edge) => edge.surface === 'public-edge')
      .map((edge) => edge.path),
  );
  const storageHeaders = filesBelow(
    path.join(
      root,
      'framework/core/src/libkungfu/include/kungfu/runtime/storage',
    ),
    (file) => file.endsWith('.h'),
  );
  for (const file of storageHeaders) {
    const rel = relative(file);
    const text = fs.readFileSync(file, 'utf8');
    if (/nlohmann::json|nlohmann\/json/.test(text) && !publicJsonEdges.has(rel))
      errors.push(
        `${rel}: public storage JSON requires an exact json_edges entry`,
      );
  }
  for (const edge of manifest.json_edges || []) {
    if (!fs.existsSync(path.join(root, edge.path)))
      errors.push(`${edge.path}: JSON edge path does not exist`);
  }
  return errors;
}

const invoked = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invoked) {
  const errors = validateRepository();
  if (errors.length) {
    console.error(
      '[schema-authority] KF-ADR-019f86da-4f90-71eb-b4c0-376ca7bc7ad3 boundary violations:',
    );
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(
    '[schema-authority] single-owner, JSON-edge, and projection-route gates passed',
  );
}
