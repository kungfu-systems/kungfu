// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONTRACT_PATH,
  validatePortableFormatAuthority,
} from './check-portable-format-authority.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(
  fs.readFileSync(path.join(ROOT, CONTRACT_PATH), 'utf8'),
);
const readSource = (relative) =>
  fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('accepts the repository portable format authority composition', () => {
  assert.deepEqual(
    validatePortableFormatAuthority(contract, { root: ROOT }),
    [],
  );
});

test('fails closed when a referenced authority disappears', () => {
  const changed = structuredClone(contract);
  changed.authorities[0].source = 'framework/core/fact/missing-authority.json';
  assert.ok(
    validatePortableFormatAuthority(changed, { root: ROOT }).some((issue) =>
      issue.includes('source is missing'),
    ),
  );
});

test('fails closed when a referenced protocol identity drifts', () => {
  const target = contract.authorities[2];
  const marker = target.identityMarkers[0];
  const issues = validatePortableFormatAuthority(contract, {
    root: ROOT,
    readSource(relative) {
      const source = readSource(relative);
      return relative === target.source
        ? source.replace(marker, 'drifted-protocol-identity')
        : source;
    },
  });
  assert.ok(issues.some((issue) => issue.includes('identity marker drifted')));
});

test('rejects a collapsed global version axis', () => {
  const changed = structuredClone(contract);
  changed.versionAxes = [
    {
      id: 'one-global-version',
      owner: 'nobody',
      changesWhen: 'anything changes',
    },
  ];
  const issues = validatePortableFormatAuthority(changed, { root: ROOT });
  assert.ok(issues.some((issue) => issue.includes('version axes')));
  assert.ok(issues.some((issue) => issue.includes('missing version axis')));
});
