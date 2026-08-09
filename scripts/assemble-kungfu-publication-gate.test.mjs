// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';
import { createKungfuPublicationGateAggregate } from './assemble-kungfu-publication-gate.mjs';

const SOURCE_SHA = '1'.repeat(40);
const PLATFORMS = ['linux-x64', 'linux-arm64', 'macos-arm64', 'windows-x64'];

function fixture() {
  const registry = {
    project: { id: 'kungfu' },
    gates: [],
    profiles: [],
  };
  const gateReceipt = {
    status: 'pass',
    ok: true,
    qualifying: true,
    results: [
      {
        gateId: 'release.artifact-admission',
        policyMode: 'required',
        status: 'pass',
        attempted: true,
        definitionDigest: `sha256:${'2'.repeat(64)}`,
        actionId: `sha256:${'3'.repeat(64)}`,
        reason: null,
      },
    ],
  };
  const manifestSet = {
    artifacts: PLATFORMS.map((platformId, index) => ({
      platformId,
      manifestDigest: String(index + 1).repeat(64),
      contentDigest: String(index + 2).repeat(64),
      productPayloadDigest: String(index + 3).repeat(64),
    })),
  };
  return { registry, gateReceipt, manifestSet };
}

test('publication Gate aggregate binds the exact four-platform artifact set', () => {
  const value = fixture();
  const aggregate = createKungfuPublicationGateAggregate({
    sourceSha: SOURCE_SHA,
    ...value,
    publicationAuthorityDigest: () => '4'.repeat(64),
    sha256Json: () => '5'.repeat(64),
  });
  assert.equal(aggregate.contract, 'buildchain.shifu-gate-aggregate/v1');
  assert.equal(aggregate.profile, 'release-promotion');
  assert.equal(aggregate.sourceSha, SOURCE_SHA);
  assert.deepEqual(
    aggregate.receipts.map((receipt) => receipt.platformId),
    PLATFORMS,
  );
  assert.equal(aggregate.gates[0].gateId, 'release.artifact-admission');
  assert.equal(aggregate.digest, `sha256:${'5'.repeat(64)}`);
});

test('publication Gate aggregate rejects an incomplete platform set', () => {
  const value = fixture();
  value.manifestSet.artifacts.pop();
  assert.throws(
    () =>
      createKungfuPublicationGateAggregate({
        sourceSha: SOURCE_SHA,
        ...value,
        publicationAuthorityDigest: () => '4'.repeat(64),
        sha256Json: () => '5'.repeat(64),
      }),
    /artifact manifest set must contain exactly/,
  );
});

test('publication Gate aggregate rejects a non-qualifying controller receipt', () => {
  const value = fixture();
  value.gateReceipt.qualifying = false;
  assert.throws(
    () =>
      createKungfuPublicationGateAggregate({
        sourceSha: SOURCE_SHA,
        ...value,
        publicationAuthorityDigest: () => '4'.repeat(64),
        sha256Json: () => '5'.repeat(64),
      }),
    /Gate receipt is not qualifying/,
  );
});
