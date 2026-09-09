// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BASELINE_INDEX_PATH,
  checkPortableFormatBaseline,
} from './check-portable-format-baseline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-v4-baseline-'));
  for (const relative of [
    'framework/spec/format/compatibility/v4-alpha',
    'framework/spec/format/kungfu-portable-format-authority.contract.json',
    'framework/spec/format/kungfu-required-reader.contract.json',
    'framework/spec/format/kungfu-format-migration.contract.json',
    'framework/spec/format/conformance/portable-format-vectors/index.json',
  ]) {
    const source = path.join(ROOT, relative);
    const target = path.join(temp, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
  }
  return temp;
}

test('accepts the immutable current v4 alpha baseline', () => {
  const result = checkPortableFormatBaseline();
  assert.equal(result.release, '4.0.0-alpha.5');
  assert.equal(
    result.releaseRoot,
    'sha256:b79b0228bdb566d8f721430c5d81bf897db59f151a690d82f1838e0bdc38ef17',
  );
  assert.equal(result.sources, 4);
});

test('rejects an authority mutation without an explicit successor', () => {
  const temp = fixture();
  try {
    fs.appendFileSync(
      path.join(
        temp,
        'framework/spec/format/kungfu-required-reader.contract.json',
      ),
      ' ',
    );
    assert.throws(
      () => checkPortableFormatBaseline(temp),
      /current authority changed without a successor baseline/u,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('rejects rewriting a released baseline under the same identity', () => {
  const temp = fixture();
  try {
    const index = JSON.parse(
      fs.readFileSync(path.join(temp, BASELINE_INDEX_PATH), 'utf8'),
    );
    const release = path.join(
      temp,
      path.dirname(BASELINE_INDEX_PATH),
      index.releases[0].path,
    );
    const value = JSON.parse(fs.readFileSync(release, 'utf8'));
    value.stability.stableV4Claimed = true;
    fs.writeFileSync(release, `${JSON.stringify(value, null, 2)}\n`);
    assert.throws(
      () => checkPortableFormatBaseline(temp),
      /release root drift/u,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
