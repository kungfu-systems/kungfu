// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createKungfuPublicationGateAggregate } from './assemble-kungfu-publication-gate.mjs';

const SOURCE_SHA = '1'.repeat(40);
const PLATFORMS = ['linux-x64', 'linux-arm64', 'macos-arm64', 'windows-x64'];
const SCRIPT = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'assemble-kungfu-publication-gate.mjs',
  ),
  'utf8',
);

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
  assert.equal(aggregate.status, 'pass');
  assert.equal(aggregate.ok, true);
  assert.equal(aggregate.qualifying, true);
  assert.deepEqual(
    aggregate.receipts.map((receipt) => receipt.platformId),
    PLATFORMS,
  );
  assert.equal(
    aggregate.receipts.every(
      (receipt) => receipt.status === 'passed' && receipt.qualifying,
    ),
    true,
  );
  assert.equal(aggregate.gates[0].gateId, 'release.artifact-admission');
  assert.equal(aggregate.gates[0].status, 'pass');
  assert.deepEqual(aggregate.omitted, []);
  assert.deepEqual(aggregate.issues, []);
  assert.equal(aggregate.digest, `sha256:${'5'.repeat(64)}`);
});

test('real Buildchain validation starts with empty GitHub command files', () => {
  const output = SCRIPT.indexOf("fs.writeFileSync(output, '');");
  const summary = SCRIPT.indexOf("fs.writeFileSync(summary, '');");
  const validator = SCRIPT.indexOf(
    "path.join(runtimeRoot, 'actions/validate-config/dist/index.js')",
  );

  assert.notEqual(output, -1);
  assert.notEqual(summary, -1);
  assert.notEqual(validator, -1);
  assert.ok(output < validator);
  assert.ok(summary < validator);
});

test(
  'real Buildchain validator qualifies the current config with empty command files',
  {
    skip: !process.env.BUILDCHAIN_PUBLICATION_TEST_RUNTIME_ROOT,
  },
  () => {
    const validationFiles = fs.mkdtempSync(
      path.join(os.tmpdir(), 'kungfu-buildchain-config-test-'),
    );
    const output = path.join(validationFiles, 'output');
    const summary = path.join(validationFiles, 'summary');
    fs.writeFileSync(output, '');
    fs.writeFileSync(summary, '');

    try {
      assert.equal(fs.statSync(output).size, 0);
      assert.equal(fs.statSync(summary).size, 0);
      const result = spawnSync(
        process.execPath,
        [
          path.join(
            process.env.BUILDCHAIN_PUBLICATION_TEST_RUNTIME_ROOT,
            'actions/validate-config/dist/index.js',
          ),
        ],
        {
          cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: summary,
            'INPUT_CONFIG-REQUIRED': 'true',
            'INPUT_REQUIRE-VERSION-STATE': 'true',
            'INPUT_REQUIRE-LIFECYCLE-STAGES': 'install,check,build,verify',
          },
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.ok(fs.statSync(output).size > 0);
      assert.match(
        fs.readFileSync(summary, 'utf8'),
        /Buildchain config validation/,
      );
    } finally {
      fs.rmSync(validationFiles, { recursive: true, force: true });
    }
  },
);

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
