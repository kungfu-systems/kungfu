#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// ADR-0054 executable boundary: the retired journal Session model and the
// mixed-responsibility runtime/cache directory must not return.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOTS = [
  'framework/core/src',
  'framework/core/stubs',
  'framework/core/lib',
  'framework/api/src',
];
const FORBIDDEN_PATHS = [
  'framework/core/src/libkungfu/include/kungfu/runtime/cache',
  'framework/core/src/libkungfu/src/runtime/cache',
  'framework/core/src/libkungfu/include/kungfu/runtime/index/session.h',
  'framework/core/src/libkungfu/src/runtime/index/session.cpp',
  'framework/core/src/bindings/node/binding/session_store.h',
  'framework/core/src/bindings/node/binding/session_store.cpp',
  'framework/core/src/python/kungfu/runtime/journal.py',
];
const FORBIDDEN_TEXT = [
  /\bSessionStart\b/,
  /\bSessionEnd\b/,
  /\bResumePolicy\b/,
  /\bSessionStore\b/,
  /\bsession_finder\b/,
  /\bsession_builder\b/,
  /runtime\/index\/session/,
  /runtime\/cache/,
];

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['build', 'dist', 'node_modules', '__pycache__'].includes(entry.name))
      return [];
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

const errors = [];
for (const relative of FORBIDDEN_PATHS) {
  const target = path.join(ROOT, relative);
  if (
    fs.existsSync(target) &&
    (!fs.statSync(target).isDirectory() || walk(target).length > 0)
  )
    errors.push(`retired path exists: ${relative}`);
}
for (const sourceRoot of SOURCE_ROOTS) {
  for (const file of walk(path.join(ROOT, sourceRoot))) {
    if (!/\.(?:h|hpp|cpp|cc|cxx|py|pyi|js|mjs|ts|tsx)$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN_TEXT) {
      if (pattern.test(text)) {
        errors.push(`${path.relative(ROOT, file)} contains ${pattern}`);
      }
    }
  }
}

const yijinjingSchema = fs.readFileSync(
  path.join(
    ROOT,
    'framework/core/src/libyijinjing/include/kungfu/yijinjing/schema/registry.h',
  ),
  'utf8',
);
if (/TYPE_PAIR\(Session\)/.test(yijinjingSchema))
  errors.push('yijinjing registry contains retired Session');

for (const relative of [
  'framework/core/src/libkungfu/include/kungfu/runtime/projection',
  'framework/core/src/libkungfu/src/runtime/projection',
]) {
  for (const file of walk(path.join(ROOT, relative))) {
    const text = fs.readFileSync(file, 'utf8');
    if (/runtime\/state_cache|state_cache::/.test(text))
      errors.push(
        `${path.relative(ROOT, file)} depends on runtime state_cache`,
      );
  }
}

if (errors.length) {
  console.error('[legacy-journal-session] ADR-0054 boundary violations:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(
  '[legacy-journal-session] Session surfaces retired; state/projection boundary clean',
);
