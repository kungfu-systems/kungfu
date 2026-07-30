// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  pythonVersion,
  requireAbsent,
  requireAbsentOrExactCrate,
} from './preflight-layer-publication.mjs';

test('normalizes the release SemVer for PyPI lookup', () => {
  assert.equal(pythonVersion('4.0.0-alpha.1'), '4.0.0a1');
  assert.equal(pythonVersion('4.0.0-beta.2'), '4.0.0b2');
  assert.equal(pythonVersion('4.0.0-rc.3'), '4.0.0rc3');
});

test('accepts an existing crate only when its immutable checksum is exact', async () => {
  const digest = 'a'.repeat(64);
  const server = http.createServer((request, response) => {
    if (request.url === '/absent') {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        version: {
          checksum: request.url === '/exact' ? digest : 'b'.repeat(64),
        },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(
      (await requireAbsentOrExactCrate('fixture', `${base}/absent`, digest))
        .status,
      'absent',
    );
    assert.equal(
      (await requireAbsentOrExactCrate('fixture', `${base}/exact`, digest))
        .status,
      'present-exact',
    );
    await assert.rejects(
      requireAbsentOrExactCrate('fixture', `${base}/mismatch`, digest),
      /already exists with digest/,
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('accepts only a registry 404 as proof of absence', async () => {
  const server = http.createServer((request, response) => {
    response.statusCode = request.url === '/absent' ? 404 : 200;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const result = await requireAbsent('fixture', `${base}/absent`);
    assert.equal(result.status, 'absent');
    await assert.rejects(
      requireAbsent('fixture', `${base}/present`),
      /already exists/,
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
