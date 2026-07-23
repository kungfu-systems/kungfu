// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const source = fs.readFileSync(
  path.join(process.cwd(), 'scripts', 'qualify-embedding-membranes.mjs'),
  'utf8',
);

test('locked Cargo fetch precedes the offline native build', () => {
  const fetch = source.indexOf("'fetch'");
  const build = source.indexOf("'--build'");
  const offline = source.indexOf("CARGO_NET_OFFLINE: 'true'");
  assert.ok(fetch > 0, 'missing explicit Cargo fetch');
  assert.ok(build > fetch, 'native build begins before Cargo fetch');
  assert.ok(offline > build, 'native build is not explicitly offline');
  assert.match(source, /for \(const engine of \['wasmtime', 'wasmer'\]\)/u);
  assert.match(source, /'--locked'/u);
});
