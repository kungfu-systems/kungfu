#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { fileRoot, loadJson, repositoryRoot } from './lib/sdk-generator.mjs';

const ROOT = repositoryRoot(import.meta.url);
const ENVELOPE_SCHEMA_PATH =
  'framework/registry/schema/registry-envelope-v1.schema.json';
export const ENVELOPE_PATHS = [
  'framework/registry/contract.registry-envelope.json',
  'framework/registry/invariant.registry-envelope.json',
];
export const CONTRACT_ENVELOPE_PATH = ENVELOPE_PATHS[0];

function decodePointerToken(token) {
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

export function atPointer(value, pointer) {
  if (pointer === '') return value;
  if (!pointer.startsWith('/'))
    throw new Error(`invalid JSON pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split('/')
    .map(decodePointerToken)
    .reduce((current, token) => current?.[token], value);
}

function safePath(relative) {
  return (
    typeof relative === 'string' &&
    relative.length > 0 &&
    !path.isAbsolute(relative) &&
    !relative.split('/').includes('..')
  );
}

function formatAjvErrors(errors) {
  return (errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
}

export function validateEntryUniqueness(entries, uniqueFields) {
  const errors = [];
  for (const field of uniqueFields) {
    const seen = new Set();
    for (const entry of entries) {
      const value = entry?.[field];
      if (typeof value !== 'string' || value.length === 0) {
        errors.push(`entry is missing non-empty identity field ${field}`);
        continue;
      }
      if (seen.has(value)) errors.push(`duplicate ${field}: ${value}`);
      seen.add(value);
    }
  }
  return errors;
}

export function validateRegistryEnvelope(envelope, root = ROOT) {
  const errors = [];
  const envelopeSchema = loadJson(root, ENVELOPE_SCHEMA_PATH);
  const validateEnvelope = new Ajv2020({
    allErrors: true,
    strict: true,
  }).compile(envelopeSchema);
  if (!validateEnvelope(envelope))
    errors.push(`envelope schema: ${formatAjvErrors(validateEnvelope.errors)}`);
  if (errors.length > 0) return errors;

  const { registry } = envelope;
  for (const relative of [registry.source, registry.schemaPath]) {
    if (!safePath(relative)) {
      errors.push(`unsafe registry path: ${String(relative)}`);
      continue;
    }
    if (!fs.existsSync(path.join(root, relative)))
      errors.push(`missing registry path: ${relative}`);
  }
  if (errors.length > 0) return errors;

  const actualSchemaRoot = fileRoot(root, registry.schemaPath);
  if (actualSchemaRoot !== registry.schemaRoot)
    errors.push(
      `schema root drift for ${registry.schemaPath}; expected ${registry.schemaRoot}, got ${actualSchemaRoot}`,
    );

  const registrySchema = loadJson(root, registry.schemaPath);
  const registryValue = loadJson(root, registry.source);
  const validateRegistry = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
  }).compile(registrySchema);
  if (!validateRegistry(registryValue))
    errors.push(`registry schema: ${formatAjvErrors(validateRegistry.errors)}`);
  const entries = atPointer(registryValue, registry.entriesPointer);
  if (!Array.isArray(entries))
    errors.push(
      `registry entries pointer does not resolve to an array: ${registry.entriesPointer}`,
    );
  else errors.push(...validateEntryUniqueness(entries, registry.uniqueFields));

  const projectionIds = new Set();
  for (const projection of envelope.projections) {
    if (projectionIds.has(projection.id))
      errors.push(`duplicate projection id: ${projection.id}`);
    projectionIds.add(projection.id);
    for (const relative of [projection.source, projection.artifact]) {
      if (!safePath(relative)) {
        errors.push(`unsafe projection path: ${String(relative)}`);
        continue;
      }
      if (!fs.existsSync(path.join(root, relative)))
        errors.push(`missing projection path: ${relative}`);
    }
    if (
      !fs.existsSync(path.join(root, projection.source)) ||
      !fs.existsSync(path.join(root, projection.artifact))
    )
      continue;
    const sourceRoot = fileRoot(root, projection.source);
    const artifactRoot = fileRoot(root, projection.artifact);
    if (sourceRoot !== projection.root)
      errors.push(
        `source root drift for ${projection.source}; expected ${projection.root}, got ${sourceRoot}`,
      );
    if (artifactRoot !== projection.root)
      errors.push(
        `artifact drift for ${projection.artifact}; expected ${projection.root}, got ${artifactRoot}`,
      );
  }
  return errors;
}

export function writeRegistryEnvelope(
  relative,
  { root = ROOT, projectionIds = null } = {},
) {
  const envelope = loadJson(root, relative);
  const selected = projectionIds === null ? null : new Set(projectionIds);
  if (selected !== null) {
    const available = new Set(
      envelope.projections.map((projection) => projection.id),
    );
    for (const id of selected) {
      if (!available.has(id))
        throw new Error(`unknown projection id for ${envelope.id}: ${id}`);
    }
  } else {
    envelope.registry.schemaRoot = fileRoot(root, envelope.registry.schemaPath);
  }
  for (const projection of envelope.projections) {
    if (selected !== null && !selected.has(projection.id)) continue;
    const source = path.join(root, projection.source);
    const artifact = path.join(root, projection.artifact);
    if (!fs.existsSync(source))
      throw new Error(`missing projection source: ${projection.source}`);
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.copyFileSync(source, artifact);
    projection.root = fileRoot(root, projection.source);
  }
  fs.writeFileSync(
    path.join(root, relative),
    `${JSON.stringify(envelope, null, 2)}\n`,
  );
  const errors = validateRegistryEnvelope(envelope, root);
  if (errors.length > 0)
    throw new Error(`${envelope.id}: ${errors.join('\n')}`);
  return envelope;
}

function main() {
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check');
  if (write === check)
    throw new Error('choose exactly one of --write or --check');
  for (const relative of ENVELOPE_PATHS) {
    const envelope = write
      ? writeRegistryEnvelope(relative)
      : loadJson(ROOT, relative);
    const errors = validateRegistryEnvelope(envelope);
    if (errors.length > 0)
      throw new Error(`${envelope.id}: ${errors.join('\n')}`);
    console.log(
      `[registry-envelope] ${write ? 'wrote' : 'verified'} ${envelope.id}`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
