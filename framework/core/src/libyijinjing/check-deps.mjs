// SPDX-License-Identifier: Apache-2.0
//
// Dependency-direction guard for the yijinjing static core.
//
// The core may see only: the C++ standard library, header-only formatting/json
// (fmt, spdlog, nlohmann, boost::hana via kungfu/common.h) and the longfist
// schema leaf (kungfu/longfist/core.h). It may define storage semantic
// contracts under kungfu/yijinjing/storage, but it must never include runtime,
// transport or storage-engine headers, the full type registry, or any trading
// type.
//
// Include lines are matched instead of bare words so that comments explaining
// a seam (e.g. "mirrors NNG_FLAG_NONBLOCK") do not trip the guard; trading
// types and the registry are matched as symbols since no comment should need
// them either.
//
// Pure Node (no grep/bash), so the guard runs on every platform.
//
// Usage: node src/libyijinjing/check-deps.mjs   (from anywhere)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const forbiddenIncludes =
  /^\s*#\s*include\s*[<"](nng\/|rxcpp\/|sqlite|rocksdb\/|kungfu\/longfist\/longfist\.h|kungfu\/longfist\/types\.h|kungfu\/longfist\/enums\.h|kungfu\/longfist\/sqlite|kungfu\/yijinjing\/practice\/|kungfu\/yijinjing\/cache\/|kungfu\/yijinjing\/index\/|kungfu\/yijinjing\/nanomsg\/|kungfu\/yijinjing\/socket\/|kungfu\/yijinjing\/io\.h|kungfu\/yijinjing\/rx\.h|kungfu\/yijinjing\/util\/rocks\.h|kungfu\/wingchun\/)/;

const forbiddenSymbols =
  /longfist::types::(Order|Trade|Position)|types::(Order|Trade|Position)[A-Za-z]*\b|LegacyCompiledTypes\b|LegacyCompiledDataTypes\b|LegacyCompiledTypeTags\b|wingchun/;

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile()) yield p;
  }
}

function scan(re) {
  const hits = [];
  for (const dir of [path.join(here, 'include'), path.join(here, 'src')]) {
    for (const file of walk(dir)) {
      let lines;
      try {
        lines = fs.readFileSync(file, 'utf8').split('\n');
      } catch {
        continue; // skip unreadable/binary
      }
      lines.forEach((line, i) => {
        if (re.test(line)) hits.push(`${file}:${i + 1}:${line}`);
      });
    }
  }
  return hits;
}

console.log(`yijinjing core dependency guard: ${here}`);

let failed = false;

const includeHits = scan(forbiddenIncludes);
if (includeHits.length) {
  console.log(includeHits.join('\n'));
  console.error(
    'FAIL: forbidden include found (runtime/transport/storage-engine/full registry)',
  );
  failed = true;
}

const symbolHits = scan(forbiddenSymbols);
if (symbolHits.length) {
  console.log(symbolHits.join('\n'));
  console.error(
    'FAIL: forbidden symbol found (trading types / full type registry)',
  );
  failed = true;
}

if (failed) process.exit(1);
console.log('OK: core includes only the schema leaf and base utilities.');
