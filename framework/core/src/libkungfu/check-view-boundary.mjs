// SPDX-License-Identifier: Apache-2.0
//
// FlatBuffers view-boundary guard (ADR-0039).
//
// All C++ FlatBuffers / reflection access is encapsulated behind one module —
// kungfu::view (framework/core/src/libkungfu/{include/kungfu/view,src/view}).
// No code outside that module may include a FlatBuffers/reflection header or name
// a `flatbuffers::` / `reflection::` symbol; other modules depend on kungfu::view,
// not on FlatBuffers. This makes the `.bfbs` dangling-view bug structurally
// unrepresentable and keeps FlatBuffers a swappable detail behind one chokepoint.
//
// The guard is a mechanism, not a rule: it fails CI on both include-level leakage
// (transitively pulling in FlatBuffers through a header) and direct symbol use.
// Symbols are matched raw (like the yijinjing check-deps trading-type guard) — no
// comment outside the view module should need to name `flatbuffers::` /
// `reflection::`; reword the seam instead.
//
// ALLOWLIST (slice-staged):
//   - the kungfu::view module itself (the sole FB access point);
//   - runtime/schema/schema_compiler.cpp — the `.fbs` -> `.bfbs` compile path,
//     migrated in a later slice. Remove this entry when it moves behind
//     kungfu::view::compile_schema, flipping the gate fully strict.
//
// Pure Node (no grep/bash), so the guard runs on every platform.
//
// Usage: node src/libkungfu/check-view-boundary.mjs   (from anywhere)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // .../src/libkungfu
const srcRoot = path.join(here, '..'); // .../framework/core/src

// Files/dirs where FlatBuffers is allowed. Paths are matched against the
// forward-slash relative path under src/.
const allowedPrefixes = [
  'libkungfu/include/kungfu/view/',
  'libkungfu/src/view/',
];
const allowedFiles = [
  // Deferred to the next migration slice; see ALLOWLIST note above.
  'libkungfu/src/runtime/schema/schema_compiler.cpp',
];

const cppExt = /\.(h|hh|hpp|hxx|c|cc|cpp|cxx|inl|ipp)$/;

// Include-level: pulling in a FlatBuffers/reflection header.
const forbiddenInclude = /^\s*#\s*include\s*[<"](flatbuffers\/|reflection[./])/;
// Symbol-level: naming a FlatBuffers/reflection symbol.
const forbiddenSymbol = /\b(flatbuffers|reflection)::/;

function relSrc(p) {
  return path.relative(srcRoot, p).split(path.sep).join('/');
}

function isAllowed(rel) {
  return (
    allowedPrefixes.some((pre) => rel.startsWith(pre)) ||
    allowedFiles.includes(rel)
  );
}

function isGenerated(rel) {
  return (
    rel.includes('_generated.') ||
    rel.includes('/build/') ||
    rel.includes('/_deps/') ||
    rel.includes('/.deps/')
  );
}

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'build' ||
        entry.name === '_deps' ||
        entry.name === '.deps'
      )
        continue;
      yield* walk(p);
    } else if (entry.isFile() && cppExt.test(entry.name)) {
      yield p;
    }
  }
}

function scan() {
  const includeHits = [];
  const symbolHits = [];
  for (const file of walk(srcRoot)) {
    const rel = relSrc(file);
    if (isAllowed(rel) || isGenerated(rel)) continue;
    let lines;
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n');
    } catch {
      continue; // skip unreadable/binary
    }
    lines.forEach((line, i) => {
      if (forbiddenInclude.test(line))
        includeHits.push(`${rel}:${i + 1}:${line.trim()}`);
      else if (forbiddenSymbol.test(line))
        symbolHits.push(`${rel}:${i + 1}:${line.trim()}`);
    });
  }
  return { includeHits, symbolHits };
}

console.log(`kungfu::view FlatBuffers boundary guard: ${srcRoot}`);

let failed = false;
const { includeHits, symbolHits } = scan();

if (includeHits.length) {
  console.log(includeHits.join('\n'));
  console.error(
    'FAIL: FlatBuffers/reflection header included outside kungfu::view (ADR-0039)',
  );
  failed = true;
}
if (symbolHits.length) {
  console.log(symbolHits.join('\n'));
  console.error(
    'FAIL: flatbuffers::/reflection:: symbol used outside kungfu::view (ADR-0039)',
  );
  failed = true;
}

if (failed) {
  console.error(
    'Depend on kungfu::view (kungfu/view/schema.h); do not call FlatBuffers directly.',
  );
  process.exit(1);
}
console.log(
  'OK: all FlatBuffers/reflection access is confined to the kungfu::view module.',
);
