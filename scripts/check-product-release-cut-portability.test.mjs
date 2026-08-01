// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const contract = readJson(
  'framework/data-protection/product-release-cut-portability.contract.json',
);
const parent = readJson(
  'framework/data-protection/kungfu-data-protection.contract.json',
);
const exitContract = readJson(
  'framework/exit/kungfu-exit-bundle.contract.json',
);

test('registers one typed Product Release Cut Exit member', () => {
  assert.equal(
    contract.schema,
    'kungfu.product-release-cut-portability.contract/v1',
  );
  assert.equal(contract.parentContract.id, parent.id);
  assert.equal(contract.exitMember.kind, 'product-release-cut-v1');
  assert.equal(contract.exitMember.identityRoot, 'selectedReleaseCutRoot');
  assert.deepEqual(contract.exitMember.requiredFeatures, [
    'copy-forward-installed-images-v1',
    'selection-receipt-journal-v1',
    'trust-domain-separation-v1',
  ]);
  const inventory = exitContract.memberInventory.find(
    (member) => member.id === 'product-release-cut-v1',
  );
  assert.ok(inventory);
  assert.equal(inventory.eligibleMember, true);
  assert.deepEqual(inventory.modes, ['full', 'thin']);
  assert.ok(
    exitContract.requestSchema.properties.members.items.properties.kind.enum.includes(
      'product-release-cut-v1',
    ),
  );
});

test('keeps native release, image, receipt, and Exit owners singular', () => {
  assert.match(contract.authority.releaseOwner, /Product Release Cut/u);
  assert.match(contract.authority.imageOwner, /installed-image inventory/u);
  assert.match(
    contract.authority.activationOwner,
    /selection receipt journal/u,
  );
  assert.equal(contract.authority.compositionOwner, 'Exit Bundle');
  assert.match(
    contract.authority.rule,
    /does not derive identity from SemVer/u,
  );
  assert.deepEqual(contract.trustDomains.allowed, ['public', 'shifu-local']);
  assert.match(contract.trustDomains.rule, /never upgrades shifu-local/u);
});

test('copy-forward ordering is cache-independent and interruption-safe', () => {
  assert.deepEqual(contract.protectedHistory.excludedCaches, [
    'mutable channel index cache',
    'download archive cache',
    'Shifu build cache',
    'package-manager cache',
  ]);
  assert.match(contract.migration.copyForward, /before current\.json/u);
  assert.match(contract.migration.interruption, /retry publishes only/u);
  assert.equal(
    contract.compatibility.unknownRequiredFeatures,
    'reject-before-write',
  );
  assert.match(contract.compatibility.rollback, /exact predecessor image/u);
  assert.ok(
    contract.qualification.requiredCases.includes(
      'interrupted-current-publication-recovery',
    ),
  );
  assert.match(contract.nonClaims.join('\n'), /physical-disk-loss/u);
});

test('implementation delegates to the existing owner services', () => {
  const composer = read('framework/core/src/python/kungfu/exit_bundle.py');
  const cli = read('framework/core/src/python/kungfu/cli/commands/exit.py');
  assert.match(composer, /runtime_upgrade\.validate_release_cut/u);
  assert.match(composer, /runtime_upgrade\.validate_cut_transition/u);
  assert.match(composer, /distribution_update\.cli_inventory_fsck/u);
  assert.match(composer, /_persist_cli_selection_receipt/u);
  assert.match(composer, /"current-selection"/u);
  assert.match(composer, /"product-release-cut-v1": \{/u);
  assert.match(composer, /_product_history_import/u);
  assert.match(cli, /config_home=ctx\.config_home/u);
});
