// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runtimeUpgradeUvCommand } from './run-runtime-upgrade-tests.mjs';
import { checkUpgradeContract } from './upgrade-contract.mjs';

test('upgrade contract weld and state fixtures stay complete', () => {
  const result = checkUpgradeContract();
  assert.equal(result.fixtures, 6);
  assert.ok(result.states >= 12);
  assert.ok(result.reasons >= 12);
  assert.ok(result.messages >= result.reasons);
});

test('every reason keeps one complete user message', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-upgrade-messages-'),
  );
  try {
    for (const relative of [
      'product/upgrade/kungfu-upgrade.contract.json',
      'framework/spec/contract/kungfu-contracts.registry.json',
      'tests/fixtures/runtime-upgrade-control-plane/cases.json',
    ]) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.resolve(relative), target);
    }
    const contractPath = path.join(
      root,
      'product/upgrade/kungfu-upgrade.contract.json',
    );
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    contract.messageRegistry.reasonMessages['readiness-failed'] = undefined;
    fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
    assert.throws(
      () => checkUpgradeContract(root),
      /upgrade message missing: readiness-failed/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('activation authority drift fails closed', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-upgrade-contract-'),
  );
  try {
    for (const relative of [
      'product/upgrade/kungfu-upgrade.contract.json',
      'framework/spec/contract/kungfu-contracts.registry.json',
      'tests/fixtures/runtime-upgrade-control-plane/cases.json',
    ]) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.resolve(relative), target);
    }
    const contractPath = path.join(
      root,
      'product/upgrade/kungfu-upgrade.contract.json',
    );
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    contract.authority.activation = 'desktop-installer';
    fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
    assert.throws(
      () => checkUpgradeContract(root),
      /activation authority drifted from Core/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime upgrade tests enter pinned uv through Shifu', () => {
  const command = runtimeUpgradeUvCommand(['run', '--frozen'], 'linux');
  assert.equal(path.basename(command.command), 'shifu');
  assert.deepEqual(command.args, ['exec', 'uv', 'run', '--frozen']);
});

test('runtime upgrade tests use the welded Windows Shifu entry', () => {
  const command = runtimeUpgradeUvCommand(['run'], 'win32');
  assert.equal(path.basename(command.command), 'shifu.cmd');
  assert.deepEqual(command.args, ['exec', 'uv', 'run']);
});
