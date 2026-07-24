// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
export const DIST_ROOT = path.join(PACKAGE_ROOT, 'dist', 'site');
export const SOURCE_PATH = path.join(
  PACKAGE_ROOT,
  'src',
  'site-bundle.source.json',
);
export const SCHEMA_PATH = path.join(
  PACKAGE_ROOT,
  'schema',
  'site-bundle.schema.json',
);
export const BUNDLE_PATH = path.join(DIST_ROOT, 'site-bundle.json');
export const AGENT_INDEX_PATH = path.join(DIST_ROOT, 'agent-index.json');
export const ADR_MAP_PATH = path.join(DIST_ROOT, 'adr-map.json');

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

export function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function fileRoot(file) {
  return sha256(fs.readFileSync(file));
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function assertRelativeSourcePath(sourcePath) {
  if (
    !sourcePath ||
    path.isAbsolute(sourcePath) ||
    sourcePath.includes('..') ||
    sourcePath.startsWith('framework/site/')
  ) {
    throw new Error(`invalid or self-authorizing source path: ${sourcePath}`);
  }
  const absolute = path.resolve(REPO_ROOT, sourcePath);
  if (
    !absolute.startsWith(`${REPO_ROOT}${path.sep}`) ||
    !fs.existsSync(absolute)
  ) {
    throw new Error(`declared source is missing: ${sourcePath}`);
  }
  return absolute;
}

export function internalContentRoot(bundle) {
  const { contentRoot: _contentRoot, ...copy } = structuredClone(bundle);
  return sha256(canonicalJson(copy));
}
