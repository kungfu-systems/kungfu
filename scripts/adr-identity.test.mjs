// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyAdrIdentity,
  createUuidV7,
  identityFromAdrPath,
  inspectAdrRecordPath,
} from './adr-identity.mjs';

test('creates canonical UUIDv7 identities without shared sequence state', () => {
  const timestamp = Date.UTC(2026, 6, 22, 1, 2, 3, 4);
  const first = createUuidV7({
    timestamp,
    random: Buffer.from('00112233445566778899', 'hex'),
  });
  const second = createUuidV7({
    timestamp,
    random: Buffer.from('01112233445566778899', 'hex'),
  });

  assert.equal(first, '019f8758-0efc-7011-a233-445566778899');
  assert.notEqual(first, second);
  assert.equal(first[14], '7');
  assert.match(first[19], /[89ab]/);
});

test('creates 100 unique identities at one fixed timestamp', () => {
  const timestamp = Date.UTC(2026, 6, 22, 1, 2, 3, 4);
  const ids = new Set();
  for (let index = 0; index < 100; index += 1) {
    const random = Buffer.alloc(10);
    random.writeUInt16BE(index, 8);
    ids.add(createUuidV7({ timestamp, random }));
  }
  assert.equal(ids.size, 100);
});

test('classifies only canonical new and grandfatherable legacy identities', () => {
  assert.deepEqual(
    classifyAdrIdentity('KF-ADR-019832fd-9efc-7011-a233-445566778899'),
    { kind: 'uuidv7', owner: 'kungfu' },
  );
  assert.deepEqual(
    classifyAdrIdentity('SHIFU-ADR-019832fd-9efc-7011-a233-445566778899'),
    { kind: 'uuidv7', owner: 'shifu' },
  );
  assert.deepEqual(classifyAdrIdentity('ADR-0133'), {
    kind: 'legacy',
    owner: 'kungfu',
  });
  assert.deepEqual(classifyAdrIdentity('SHIFU-ADR-0008'), {
    kind: 'legacy',
    owner: 'shifu',
  });
  assert.equal(
    classifyAdrIdentity('KF-ADR-019832fd-9efc-4011-a233-445566778899'),
    null,
  );
  assert.equal(classifyAdrIdentity('ADR-133'), null);
});

test('extracts the complete identity from UUIDv7 filenames', () => {
  assert.equal(
    identityFromAdrPath(
      'docs/adr/KF-ADR-019832fd-9efc-7011-a233-445566778899-concurrent-cut.md',
    ),
    'KF-ADR-019832fd-9efc-7011-a233-445566778899',
  );
  assert.equal(
    identityFromAdrPath(
      'docs/adr/KF-ADR-019832fd-9efc-7011-a233-445566778899-directory/readme.md',
    ),
    null,
  );
});

test('classifies only direct lowercase Markdown ADR record paths as canonical', () => {
  assert.deepEqual(
    inspectAdrRecordPath('docs/adr/ADR-0001-example.md', 'docs/adr'),
    { kind: 'record', identity: 'ADR-0001' },
  );
  for (const rel of [
    'docs/adr/ADR-0001-bypass.markdown',
    'docs/adr/ADR-0001-bypass.txt',
    'docs/adr/ADR-0001-bypass.MD',
    'docs/adr/nested/ADR-0001-bypass.md',
  ]) {
    assert.equal(inspectAdrRecordPath(rel, 'docs/adr').kind, 'invalid');
  }
});
