// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkPortableFormatVectors,
  classifyRetainedVector,
} from './check-portable-format-vectors.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = 'framework/spec/format/conformance/portable-format-vectors';

test('verifies the complete retained real-byte corpus', () => {
  const result = checkPortableFormatVectors();
  assert.equal(result.vectors, 16);
  assert.equal(result.outcomes, 5);
  assert.equal(result.axes, 8);
});

test('reports the exact vector id when retained bytes drift', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-vectors-'));
  try {
    fs.mkdirSync(path.join(temp, 'framework/spec/format/conformance'), {
      recursive: true,
    });
    fs.cpSync(path.join(ROOT, CORPUS), path.join(temp, CORPUS), {
      recursive: true,
    });
    fs.mkdirSync(path.join(temp, 'framework/spec/format'), { recursive: true });
    fs.copyFileSync(
      path.join(
        ROOT,
        'framework/spec/format/kungfu-format-migration.contract.json',
      ),
      path.join(
        temp,
        'framework/spec/format/kungfu-format-migration.contract.json',
      ),
    );
    const target = path.join(
      temp,
      CORPUS,
      'v1/bytes/journal-v2-future-epoch.bin',
    );
    const bytes = fs.readFileSync(target);
    bytes[12] ^= 0xff;
    fs.writeFileSync(target, bytes);
    assert.throws(
      () => checkPortableFormatVectors(temp),
      /journal-v2-future-epoch: byte root/u,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('independent reader refuses truncation before semantic access', () => {
  const actual = classifyRetainedVector(
    { layer: 'journal-page' },
    Buffer.alloc(23),
  );
  assert.deepEqual(actual, {
    outcome: 'reject',
    classification: 'malformed',
    reason: 'FORMAT_TUPLE_MALFORMED',
    failureCode: 'E_READER_MALFORMED_FRAMING',
    writeOccurred: false,
  });
});
