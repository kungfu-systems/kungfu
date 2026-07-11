// SPDX-License-Identifier: Apache-2.0
//
// Dependency-direction guard for the yijinjing static core.
//
// The core may see only: the C++ standard library, header-only formatting/json
// (fmt, spdlog, nlohmann, boost::hana via kungfu/common.h) and the yijinjing schema leaf
// (kungfu/yijinjing/schema/core.h). It may define storage semantic
// contracts under kungfu/yijinjing/storage, but it must never include runtime,
// transport or storage-engine headers, the full runtime registry, or any trading
// type. Per ADR-0040 the kernel owns the content-store contract and must not
// reference a concrete storage engine by include, symbol, or link; engine
// implementations live in the runtime/provider layer and are injected through
// the interface.
//
// Include lines are matched instead of bare words so that comments explaining
// a seam (e.g. "mirrors NNG_FLAG_NONBLOCK") do not trip the guard; trading
// types, the registry and engine APIs are matched as code-level symbols since
// no comment should need those either. CMake link lines are matched with
// comments stripped, so prose about engines stays legal while a real link
// does not.
//
// Pure Node (no grep/bash), so the guard runs on every platform.
//
// Usage: node src/libyijinjing/check-deps.mjs               (guard the real tree)
//        node src/libyijinjing/check-deps.mjs --self-test   (prove the guard
//          itself fails on seeded violations and passes a clean tree)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const forbiddenIncludes =
  /^\s*#\s*include\s*[<"](nng\/|rxcpp\/|sqlite|rocksdb\/|leveldb\/|lmdb|duckdb|kungfu\/runtime\/|kungfu\/longfist\/|kungfu\/yijinjing\/schema\/registry\.h|kungfu\/yijinjing\/live\/|kungfu\/yijinjing\/cache\/|kungfu\/yijinjing\/index\/|kungfu\/yijinjing\/nanomsg\/|kungfu\/yijinjing\/socket\/|kungfu\/yijinjing\/io\.h|kungfu\/yijinjing\/rx\.h|kungfu\/yijinjing\/util\/|kungfu\/wingchun\/)/;

const forbiddenSymbols =
  /yijinjing::types::(Order|Trade|Position)|types::(Order|Trade|Position)[A-Za-z]*\b|LegacyCompiledTypes\b|LegacyCompiledDataTypes\b|LegacyCompiledTypeTags\b|wingchun/;

// ADR-0040 boundary: concrete-engine APIs referenced as code, not as prose --
// a namespace-qualified type or a C API call cannot appear in a legitimate
// kernel comment, while "RocksDB" as a word can.
const forbiddenEngineSymbols =
  /rocksdb::|\bsqlite3_[a-z]|leveldb::|\bmdb_(env|txn|dbi)_|\bduckdb_[a-z]/;

// Engine names on a live CMake line (comments stripped) mean a link/dependency
// declaration; the kernel must not carry one.
const forbiddenLinkTokens = /rocksdb|sqlite|leveldb|lmdb|duckdb/i;

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile()) yield p;
  }
}

function scan(re, dirs) {
  const hits = [];
  for (const dir of dirs) {
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

function scanLinks(root) {
  const hits = [];
  for (const file of walk(root)) {
    const base = path.basename(file);
    if (base !== 'CMakeLists.txt' && !base.endsWith('.cmake')) continue;
    let lines;
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n');
    } catch {
      continue;
    }
    lines.forEach((line, i) => {
      const code = line.replace(/#.*$/, '');
      if (forbiddenLinkTokens.test(code)) hits.push(`${file}:${i + 1}:${line}`);
    });
  }
  return hits;
}

function runChecks(root) {
  const dirs = [path.join(root, 'include'), path.join(root, 'src')];
  return {
    includeHits: scan(forbiddenIncludes, dirs),
    symbolHits: scan(forbiddenSymbols, dirs),
    engineSymbolHits: scan(forbiddenEngineSymbols, dirs),
    linkHits: scanLinks(root),
  };
}

function report(checks) {
  let failed = false;
  const cases = [
    [
      checks.includeHits,
      'FAIL: forbidden include found (runtime/transport/storage-engine/full registry)',
    ],
    [
      checks.symbolHits,
      'FAIL: forbidden symbol found (trading types / full runtime registry)',
    ],
    [
      checks.engineSymbolHits,
      'FAIL: concrete storage-engine symbol found (ADR-0040: engines live in the provider layer)',
    ],
    [
      checks.linkHits,
      'FAIL: concrete storage-engine on a live CMake line (ADR-0040: the kernel links no engine)',
    ],
  ];
  for (const [hits, message] of cases) {
    if (hits.length) {
      console.log(hits.join('\n'));
      console.error(message);
      failed = true;
    }
  }
  return failed;
}

// Prove the guard itself: seed one violation per category into a synthetic
// tree and require the corresponding check to catch it; require a clean tree
// to pass. A guard that cannot fail is not a guarantee.
function selfTest() {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), 'yjj-check-deps-selftest-'),
  );
  const write = (rel, text) => {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  const problems = [];
  const expect = (label, ok) => {
    console.log(`  ${ok ? 'ok' : 'MISS'}: ${label}`);
    if (!ok) problems.push(label);
  };
  try {
    write(
      'include/kungfu/clean.h',
      '#include <string>\n// prose may say rocksdb and sqlite\n',
    );
    write('src/clean.cpp', 'int clean = 0;\n');
    write(
      'CMakeLists.txt',
      'add_library(yijinjing STATIC src/clean.cpp)\n' +
        'target_link_libraries(yijinjing PUBLIC fmt::fmt) # never rocksdb or sqlite\n',
    );
    const clean = runChecks(tmp);
    expect(
      'clean tree passes (prose mentions of engines stay legal)',
      !clean.includeHits.length &&
        !clean.symbolHits.length &&
        !clean.engineSymbolHits.length &&
        !clean.linkHits.length,
    );

    write('include/kungfu/bad_include.h', '#include <rocksdb/db.h>\n');
    write(
      'src/bad_engine.cpp',
      'rocksdb::DB *db = nullptr;\nint rc = sqlite3_open("f", &h);\n',
    );
    write('src/bad_trading.cpp', 'auto order = yijinjing::types::Order{};\n');
    write(
      'CMakeLists.txt',
      'add_library(yijinjing STATIC src/bad_engine.cpp)\n' +
        'target_link_libraries(yijinjing PUBLIC RocksDB::rocksdb)\n',
    );
    const seeded = runChecks(tmp);
    expect('seeded engine include is caught', seeded.includeHits.length > 0);
    expect(
      'seeded engine symbols are caught',
      seeded.engineSymbolHits.length >= 2,
    );
    expect('seeded trading symbol is caught', seeded.symbolHits.length > 0);
    expect('seeded engine link is caught', seeded.linkHits.length > 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (problems.length) {
    console.error(`FAIL: guard self-test missed: ${problems.join('; ')}`);
    process.exit(1);
  }
  console.log(
    'OK: guard self-test -- seeded violations fail, clean tree passes.',
  );
}

if (process.argv.includes('--self-test')) {
  console.log('yijinjing core dependency guard self-test');
  selfTest();
} else {
  console.log(`yijinjing core dependency guard: ${here}`);
  if (report(runChecks(here))) process.exit(1);
  console.log(
    'OK: core includes only the schema leaf, storage contracts, hash, mmap and base utilities.',
  );
}
