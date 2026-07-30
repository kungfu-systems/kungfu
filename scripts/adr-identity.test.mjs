// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyAdrIdentity,
  createUuidV7,
  identityFromAdrPath,
  inspectAdrRecordPath,
  resolveAdrIdentityPrefix,
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

test('resolves unique human prefixes without creating a second identity', () => {
  const identities = [
    'KF-ADR-019832fd-9efc-7011-a233-445566778899',
    'KF-ADR-019832fd-a111-7222-b333-445566778899',
    'SHIFU-ADR-019832fd-9efc-7011-a233-445566778899',
  ];
  assert.equal(
    resolveAdrIdentityPrefix(identities, 'KF-ADR-019832fd-9'),
    identities[0],
  );
  assert.throws(
    () => resolveAdrIdentityPrefix(identities, 'KF-ADR-019832fd'),
    /ambiguous/,
  );
  assert.throws(
    () => resolveAdrIdentityPrefix(identities, '019832fd-9efc'),
    /owner-prefixed/,
  );
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

test('classifies only canonical UUIDv7 identities', () => {
  assert.deepEqual(
    classifyAdrIdentity('KF-ADR-019832fd-9efc-7011-a233-445566778899'),
    { kind: 'uuidv7', owner: 'kungfu' },
  );
  assert.deepEqual(
    classifyAdrIdentity('SHIFU-ADR-019832fd-9efc-7011-a233-445566778899'),
    { kind: 'uuidv7', owner: 'shifu' },
  );
  assert.equal(classifyAdrIdentity(['ADR', '0133'].join('-')), null);
  assert.equal(classifyAdrIdentity(['SHIFU', 'ADR', '0008'].join('-')), null);
  assert.equal(
    classifyAdrIdentity('KF-ADR-019832fd-9efc-4011-a233-445566778899'),
    null,
  );
  assert.equal(classifyAdrIdentity('ADR-133'), null);
});

test('extracts the complete identity from UUIDv7 filenames', () => {
  assert.equal(
    identityFromAdrPath(
      'docs/adr/KF-ADR-019832fd-9efc-7011-a233-445566778899.md',
    ),
    'KF-ADR-019832fd-9efc-7011-a233-445566778899',
  );
  assert.equal(
    identityFromAdrPath(
      'docs/adr/KF-ADR-019832fd-9efc-7011-a233-445566778899-concurrent-cut.md',
    ),
    null,
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
    inspectAdrRecordPath(
      'docs/adr/KF-ADR-019f86da-4f90-7179-a900-c40bdb498910.md',
      'docs/adr',
    ),
    {
      kind: 'record',
      identity: 'KF-ADR-019f86da-4f90-7179-a900-c40bdb498910',
    },
  );
  for (const rel of [
    'docs/adr/KF-ADR-019f86da-4f90-7179-a900-c40bdb498910-bypass.markdown',
    'docs/adr/KF-ADR-019f86da-4f90-7179-a900-c40bdb498910-bypass.txt',
    'docs/adr/KF-ADR-019f86da-4f90-7179-a900-c40bdb498910-bypass.MD',
    'docs/adr/nested/KF-ADR-019f86da-4f90-7179-a900-c40bdb498910-bypass.md',
    'docs/adr/KF-ADR-019832fd-9efc-7011-a233-445566778899-slug.md',
    'docs/adr/KF-ADR-019832fd-9efc-7011-a233-445566778899.MD',
    'docs/adr/nested/KF-ADR-019832fd-9efc-7011-a233-445566778899.md',
  ]) {
    assert.equal(inspectAdrRecordPath(rel, 'docs/adr').kind, 'invalid');
  }
});
