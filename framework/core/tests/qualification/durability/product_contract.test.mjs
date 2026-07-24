// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..', '..', '..');
const authority = fs.readFileSync(
  path.join(root, 'framework/core/src/libkungfu/src/runtime/durability.cpp'),
  'utf8',
);

const evidence = [
  {
    path: 'framework/core/src/libkungfu/tests/durable_ingest_tests.cpp',
    sha256: 'd78200a188fc4e7c228b80c8e8f8b2380ddf47cf2eef72fd142a7ad16793bbb5',
  },
  {
    path: 'framework/core/src/libkungfu/tests/projection_bootstrap_tests.cpp',
    sha256: '0d2480afd1eedb7f8376821ba40f1bd650bbe45ee39d0f192c74f454ab02613c',
  },
  {
    path: 'docs/qualification/evidence/durability/791e09a70/evidence/fault-campaign-v2.json',
    sha256: '0ae769d3befabf3b382f5f116d638d68addafaedb6c263d7171369ff5bda0256',
  },
  {
    path: 'docs/qualification/evidence/durability/070e0804b/agent120-durability-slo-v1.json',
    sha256: 'bd5497228f51eaea6c38e3e82bb07a7bfb549d6969da03b4bfb0d421511a232e',
  },
  {
    path: 'docs/qualification/evidence/durability/987201493/aggregate-report.json',
    sha256: '4034b2653c1acd5f1b1608d7e68c3328f91fa501c04f180252c4f22e232bc574',
  },
  {
    path: 'docs/qualification/evidence/durability/17e807700/aggregate-report.json',
    sha256: '7d377977a3bae516624cd1f9d6656e7f2c54b37eb9cef59b77ee68e979c4acb6',
  },
  {
    path: 'docs/qualification/evidence/durability/production-candidate-v1/admission-report.json',
    sha256: 'c123aa406b9e496bea1610915dd3ddecd8946ae78f04fbddbf90b1d104fb112c',
  },
];

function sha256(pathname) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(pathname))
    .digest('hex');
}

test('product capability authority is bound to retained evidence', () => {
  for (const reference of evidence) {
    assert.equal(sha256(path.join(root, reference.path)), reference.sha256);
    assert.match(authority, new RegExp(reference.path.replaceAll('/', '\\/')));
    assert.match(authority, new RegExp(reference.sha256));
  }
});

test('product capability fails closed outside its named envelope', () => {
  assert.match(authority, /"production-candidate"/);
  assert.match(authority, /"candidate-explicit"/);
  assert.match(authority, /"passed-current-hardware-production-candidate"/);
  assert.match(authority, /"physical power loss"/);
  assert.match(authority, /"same-office-agent120-to-ubuntu222"/);
  assert.match(authority, /"independent backup failure domain"/);
  assert.match(authority, /"production profile eligibility"/);
  assert.match(authority, /"retained-until-production-qualified"/);
});
