// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function repositoryRoot(importMetaUrl) {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), '..');
}

export function canonicalJson(value) {
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function contentRoot(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function valueRoot(value) {
  return contentRoot(canonicalJson(value));
}

export function fileRoot(root, relative) {
  return contentRoot(fs.readFileSync(path.join(root, relative)));
}

export function loadJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

export function outputRootRecords(outputs) {
  return Object.fromEntries(
    [...outputs].map(([relative, content]) => [
      relative,
      { path: relative, root: contentRoot(content) },
    ]),
  );
}

export function verifyRootRecords(records, root) {
  const errors = [];
  for (const [id, record] of Object.entries(records)) {
    const target = path.join(root, record.path);
    if (!fs.existsSync(target)) {
      errors.push(`${id}: missing ${record.path}`);
      continue;
    }
    const actual = fileRoot(root, record.path);
    if (actual !== record.root)
      errors.push(
        `${id}: root drift for ${record.path}; expected ${record.root}, got ${actual}`,
      );
  }
  return errors;
}

export function generatorClosure(root, generatorPath, dependencies = []) {
  return {
    path: generatorPath,
    root: fileRoot(root, generatorPath),
    dependencies: dependencies.map((dependency) => ({
      path: dependency,
      root: fileRoot(root, dependency),
    })),
  };
}

export function verifyGeneratorClosure(closure, root) {
  if (
    !closure ||
    typeof closure.path !== 'string' ||
    typeof closure.root !== 'string' ||
    !Array.isArray(closure.dependencies)
  )
    return ['missing generator path/root/dependencies closure'];
  return verifyRootRecords(
    Object.fromEntries([
      ['generator', { path: closure.path, root: closure.root }],
      ...closure.dependencies.map((dependency) => [
        `generator dependency ${dependency.path}`,
        dependency,
      ]),
    ]),
    root,
  );
}

export function writeOrCheckOutputs({ root, outputs, check, label }) {
  let stale = false;
  for (const [relative, expected] of outputs) {
    const target = path.join(root, relative);
    const current = fs.existsSync(target)
      ? fs.readFileSync(target, 'utf8')
      : null;
    if (current === expected) continue;
    if (check) {
      console.error(`[${label}] stale generated file: ${relative}`);
      stale = true;
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, expected);
    console.log(`[${label}] wrote ${relative}`);
  }
  if (stale) process.exitCode = 1;
  else if (check) console.log(`[${label}] generated projections are current`);
  return !stale;
}
