#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// ADR-0057 executable boundary: canonical runtime code uses live/reactor/peer/
// coordinator. Historic wire-v1 spelling is confined to explicit adapters.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOTS = [
  'framework/core/src/libkungfu',
  'framework/core/src/bindings',
  'framework/core/src/python/kungfu',
  'framework/core/stubs',
  'framework/core/lib',
  'framework/api/src',
  'framework/gui/src',
  'framework/tui/src',
  'extensions',
];
const FORBIDDEN_PATHS = [
  'framework/core/src/libkungfu/include/kungfu/runtime/practice',
  'framework/core/src/libkungfu/src/runtime/practice',
  'framework/core/src/python/kungfu/runtime/practice',
  'framework/core/src/python/kungfu/master_service.py',
  'framework/core/src/python/kungfu/cli/commands/master.py',
  'docs/master-service.md',
];
const RETIRED_TEXT = [
  /runtime::practice/,
  /kungfu\/runtime\/practice/,
  /kungfu\.runtime\.practice/,
  /\b(?:hero|apprentice)\b/i,
  /\bmaster_service\b/,
  /\byjj\.master\b/,
  /\bclass\s+master\b/i,
  /\bmasterPid\b/,
  /kf-master-status/,
  /\[['"]master['"],\s*['"](?:status|ensure|start|stop|restart|run|supervise)/,
];
const COMPATIBILITY_FILES = new Set([
  'framework/core/src/libkungfu/include/kungfu/runtime/live/identity.h',
  'framework/core/src/python/kungfu/runtime_service.py',
]);

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
  if (fs.existsSync(path.join(ROOT, relative))) {
    errors.push(`retired path exists: ${relative}`);
  }
}

for (const sourceRoot of SOURCE_ROOTS) {
  for (const file of walk(path.join(ROOT, sourceRoot))) {
    if (!/\.(?:h|hpp|cpp|cc|cxx|py|pyi|js|mjs|ts|tsx)$/.test(file)) continue;
    const relative = path.relative(ROOT, file);
    if (COMPATIBILITY_FILES.has(relative)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of RETIRED_TEXT) {
      if (pattern.test(text)) errors.push(`${relative} contains ${pattern}`);
    }
  }
}

const identity = fs.readFileSync(
  path.join(
    ROOT,
    'framework/core/src/libkungfu/include/kungfu/runtime/live/identity.h',
  ),
  'utf8',
);
const legacyWireValues = identity.match(/= "master";/g) || [];
if (legacyWireValues.length !== 2) {
  errors.push(
    'identity.h must contain exactly the two documented coordinator wire-v1 values',
  );
}

const runtimeService = fs.readFileSync(
  path.join(ROOT, 'framework/core/src/python/kungfu/runtime_service.py'),
  'utf8',
);
for (const required of [
  'LEGACY_SCHEMA_ROUTES',
  'COORDINATOR_WIRE_NAMESPACE',
  'legacy_state_dir',
  'route.pop("masterPid", None)',
]) {
  if (!runtimeService.includes(required)) {
    errors.push(`runtime_service.py lost compatibility adapter ${required}`);
  }
}
if (/\byjj\.master\b|\bclass\s+Master\b/.test(runtimeService)) {
  errors.push('runtime_service.py exposes a retired source-level runtime type');
}

if (errors.length) {
  console.error('[live-runtime-terminology] ADR-0057 boundary violations:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(
  '[live-runtime-terminology] live/reactor/peer/coordinator vocabulary clean; wire-v1 adapter isolated',
);
