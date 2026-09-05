// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const contract = readJson(
  'framework/core/data-protection/kungfu-data-protection.contract.json',
);
const fixtures = readJson('tests/fixtures/data-protection-contract/cases.json');

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function canonicalJson(value) {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function protectionReceiptRoot(receipt) {
  const { receiptRoot: _receiptRoot, ...body } = receipt;
  return `sha256:${crypto
    .createHash('sha256')
    .update(
      `kungfu.data-protection.receipt/v1\0admission\0${canonicalJson(body)}`,
    )
    .digest('hex')}`;
}

function validateRegistry(candidate) {
  const familyIds = new Set();
  const memberOwners = new Map();
  for (const family of candidate.domainRegistry ?? []) {
    if (familyIds.has(family.id)) return 'duplicate-domain-family';
    familyIds.add(family.id);
    if (family.authority?.mode !== 'reference-only')
      return 'authority-reimplementation';
    for (const member of family.criticalMembers ?? []) {
      if (memberOwners.has(member)) return 'duplicate-domain-member-authority';
      memberOwners.set(member, family.id);
    }
  }
  return null;
}

function validateReceipt(receipt, candidate = contract) {
  const registryDiagnostic = validateRegistry(candidate);
  if (registryDiagnostic) return registryDiagnostic;
  if (receipt.schema !== candidate.protectionBoundary.receiptSchema)
    return 'unsupported-protection-receipt';
  if (
    receipt.contract?.id !== candidate.id ||
    receipt.contract?.version !== candidate.version
  )
    return 'protection-contract-mismatch';
  if (receipt.status !== candidate.protectionBoundary.successStatus)
    return 'protection-not-accepted';

  const entrypoint = candidate.entrypointAuthorityMatrix.find(
    (row) => row.id === receipt.entrypointId,
  );
  if (!entrypoint) return 'unknown-entrypoint';
  if (receipt.semanticAdmission === false)
    return 'activity-is-not-protected-history';

  const family = candidate.domainRegistry.find(
    (row) => row.id === receipt.domainFamily,
  );
  if (!family || !entrypoint.domainFamilyRefs.includes(family.id))
    return 'entrypoint-authority-mismatch';
  if (!family.criticalMembers.includes(receipt.memberKind))
    return 'activity-is-not-protected-history';

  const authoritySources = new Set(
    family.authority.sourceBindings.map((binding) => binding.path),
  );
  if (
    receipt.authority?.owner !== family.authority.owner ||
    !authoritySources.has(receipt.authority?.source)
  )
    return 'authority-mismatch';
  if (
    !receipt.object?.identity ||
    !receipt.object?.rootProtocol ||
    !ROOT_PATTERN.test(receipt.object?.root ?? '') ||
    !receipt.authority?.ownerReceiptSchema ||
    !ROOT_PATTERN.test(receipt.authority?.ownerReceiptRoot ?? '')
  )
    return 'owner-receipt-or-root-invalid';

  if (receipt.closure?.hiddenLoss) return 'hidden-required-loss';
  if ((receipt.closure?.unknownRequiredMembers ?? []).length > 0)
    return 'unknown-required-member';
  if (
    receipt.closure?.completeForDeclaredScope !== true ||
    (receipt.closure?.omissions ?? []).some(
      (omission) => omission.requiredForScope !== false,
    )
  )
    return 'accepted-scope-incomplete';

  if (receipt.migration?.kind === 'reinterpret-in-place')
    return 'in-place-reinterpretation';
  if (receipt.migration?.downgrade && !receipt.migration?.supported)
    return 'unsupported-downgrade';
  if (
    receipt.migration?.kind === 'copy-forward' &&
    (receipt.migration.sourceRoot === receipt.migration.successorRoot ||
      !ROOT_PATTERN.test(receipt.migration?.successorRoot ?? '') ||
      !ROOT_PATTERN.test(receipt.migration?.mappingReceiptRoot ?? ''))
  )
    return 'copy-forward-receipt-invalid';

  if (
    family.retentionClass === 'critical' &&
    ['observer-projection', 'cache-rebuildable'].includes(
      receipt.recovery?.kind,
    )
  )
    return 'cache-dependent-recovery';

  if (receipt.gc?.requested && family.retentionClass === 'critical') {
    const successorVerified =
      receipt.gc.successorEquivalent === true &&
      ROOT_PATTERN.test(receipt.gc?.successorRoot ?? '') &&
      ROOT_PATTERN.test(receipt.gc?.successorReceiptRoot ?? '');
    const exportVerified =
      receipt.gc.exportRecoveryVerified === true &&
      receipt.recovery?.kind === 'verified-export-import' &&
      receipt.recovery?.postflightEquivalent === true &&
      ROOT_PATTERN.test(receipt.recovery?.exportRoot ?? '') &&
      ROOT_PATTERN.test(receipt.recovery?.importReceiptRoot ?? '');
    if (!successorVerified && !exportVerified)
      return 'gc-without-successor-or-export';
  }

  if (receipt.receiptRoot !== protectionReceiptRoot(receipt))
    return 'protection-receipt-root-mismatch';
  return null;
}

function mutate(kind) {
  const receipt = structuredClone(fixtures.base);
  const candidate = structuredClone(contract);
  const recompute = () => {
    receipt.receiptRoot = protectionReceiptRoot(receipt);
  };
  if (kind === 'none') return { receipt, candidate };
  if (kind === 'copy-forward') {
    receipt.migration = {
      kind: 'copy-forward',
      sourceRoot: receipt.object.root,
      successorRoot:
        'sha256:5555555555555555555555555555555555555555555555555555555555555555',
      mappingReceiptRoot:
        'sha256:6666666666666666666666666666666666666666666666666666666666666666',
      downgrade: false,
      supported: true,
    };
    receipt.object.root = receipt.migration.successorRoot;
  } else if (kind === 'gc-with-successor') {
    receipt.gc = {
      requested: true,
      retentionClass: 'critical',
      successorRoot:
        'sha256:7777777777777777777777777777777777777777777777777777777777777777',
      successorReceiptRoot:
        'sha256:8888888888888888888888888888888888888888888888888888888888888888',
      successorEquivalent: true,
      exportRecoveryVerified: false,
    };
  } else if (kind === 'gc-with-export') {
    receipt.gc.requested = true;
    receipt.gc.exportRecoveryVerified = true;
  } else if (kind === 'duplicate-authority') {
    candidate.domainRegistry[1].criticalMembers.push('accepted-work');
  } else if (kind === 'activity-only') {
    receipt.semanticAdmission = false;
    receipt.memberKind = 'provider-session-event';
  } else if (kind === 'authority-mismatch') {
    receipt.authority.source = 'provider/session/cache.json';
  } else if (kind === 'hidden-loss') {
    receipt.closure.hiddenLoss = true;
  } else if (kind === 'reinterpret-in-place') {
    receipt.migration.kind = 'reinterpret-in-place';
    receipt.migration.successorRoot = receipt.migration.sourceRoot;
  } else if (kind === 'unknown-required-member') {
    receipt.closure.unknownRequiredMembers.push('future-required-history/v2');
  } else if (kind === 'unsupported-downgrade') {
    receipt.migration.downgrade = true;
    receipt.migration.supported = false;
  } else if (kind === 'cache-recovery') {
    receipt.recovery.kind = 'cache-rebuildable';
  } else if (kind === 'gc-without-recovery') {
    receipt.gc.requested = true;
  } else if (kind === 'tampered-root') {
    receipt.object.identity = 'kungfu:assignment:tampered-after-root';
    return { receipt, candidate };
  } else {
    throw new Error(`unknown fixture mutation: ${kind}`);
  }
  recompute();
  return { receipt, candidate };
}

test('freezes one versioned composition policy without taking domain authority', () => {
  assert.equal(contract.schema, 'kungfu.data-protection.contract/v1');
  assert.equal(contract.version, 1);
  assert.equal(contract.status.specification, 'accepted');
  assert.equal(
    contract.status.domainAdapters,
    'work-agent-project-cut-dogfood-product-release-exit-source-qualified',
  );
  assert.equal(contract.status.sourceQualification, 'accepted');
  assert.equal(contract.status.releaseQualification, 'not-qualified');
  assert.equal(contract.authority.kind, 'composition-policy');
  assert.match(contract.authority.receiptRule, /does not replace/u);
  assert.equal(validateRegistry(contract), null);
  for (const family of contract.domainRegistry)
    assert.equal(family.authority.mode, 'reference-only', family.id);
});

test('binds every authority descriptor to an existing owner source', () => {
  for (const family of contract.domainRegistry) {
    assert.ok(family.criticalMembers.length, family.id);
    assert.ok(family.authority.rootFamilies.length, family.id);
    assert.ok(family.exportRole, family.id);
    assert.ok(family.migrationRule, family.id);
    assert.ok(family.lossPolicy, family.id);
    for (const binding of family.authority.sourceBindings) {
      assert.equal(
        fs.existsSync(path.join(ROOT, binding.path)),
        true,
        `${family.id}: ${binding.path}`,
      );
      assert.match(
        read(binding.path),
        new RegExp(binding.marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
        `${family.id}: ${binding.marker}`,
      );
    }
  }
});

test('classifies every required retention class with an explicit deletion rule', () => {
  assert.deepEqual(
    contract.retentionTaxonomy.map((row) => row.id),
    [
      'critical',
      'retained-optional',
      'observer-projection',
      'cache-rebuildable',
      'provider-owned',
      'private',
      'explicitly-excluded',
    ],
  );
  for (const row of contract.retentionTaxonomy) {
    assert.ok(row.meaning, row.id);
    assert.ok(row.deletionRule, row.id);
  }
});

test('routes every registered family through supported product and dogfood entrypoints', () => {
  const familyIds = new Set(contract.domainRegistry.map((row) => row.id));
  const routed = new Set();
  assert.deepEqual(
    contract.entrypointAuthorityMatrix.map((row) => row.id),
    ['cli-work', 'cli-upgrade', 'tui', 'gui', 'agent-runner', 'shifu-dogfood'],
  );
  for (const row of contract.entrypointAuthorityMatrix) {
    assert.equal(row.activation, 'verified-domain-success-receipt');
    assert.ok(row.activityExcluded);
    for (const familyId of row.domainFamilyRefs) {
      assert.equal(familyIds.has(familyId), true, `${row.id}: ${familyId}`);
      routed.add(familyId);
    }
  }
  assert.deepEqual(routed, familyIds);
});

test('success begins at an owner receipt, never UI, process, or provider activity', () => {
  assert.equal(
    contract.protectionBoundary.receiptSchema,
    'kungfu.data-protection.admission-receipt/v1',
  );
  assert.equal(contract.protectionBoundary.successStatus, 'accepted');
  assert.match(contract.promise.beginsAt, /owner-domain success receipt/u);
  for (const excluded of ['provider', 'UI', 'transcript', 'Agent session'])
    assert.equal(
      contract.protectionBoundary.neverBeginsFrom.some((row) =>
        row.includes(excluded),
      ),
      true,
      excluded,
    );
});

test('compatibility and GC policies fail closed without widening support', () => {
  assert.equal(
    contract.compatibilityPolicy.unknownRequiredMember,
    'fail-closed-before-write-and-retain-descriptor',
  );
  assert.equal(
    contract.compatibilityPolicy.inPlaceReinterpretation,
    'forbidden',
  );
  assert.match(contract.compatibilityPolicy.downgrade, /explicit-qualified/u);
  assert.equal(contract.garbageCollectionPolicy.default, 'plan-only');
  assert.equal(
    contract.garbageCollectionPolicy.criticalDeletionRequiresOneOf.length,
    2,
  );
  assert.match(contract.promise.scope, /not physical-media durability/u);
});

test('positive and adversarial fixtures pin exact success and refusal diagnostics', () => {
  assert.deepEqual(
    fixtures.cases
      .filter((fixture) => !fixture.expected.ok)
      .map((fixture) => fixture.expected.diagnostic)
      .filter((diagnostic) =>
        contract.qualification.requiredAdversarialCases.includes(diagnostic),
      ),
    contract.qualification.requiredAdversarialCases,
  );
  for (const fixture of fixtures.cases) {
    const { receipt, candidate } = mutate(fixture.mutation);
    const diagnostic = validateReceipt(receipt, candidate);
    assert.equal(
      diagnostic,
      fixture.expected.ok ? null : fixture.expected.diagnostic,
      fixture.id,
    );
  }
});

test('human contract states the same authority and non-claim boundaries', () => {
  const guide = read('framework/core/data-protection/README.md');
  assert.match(
    guide,
    /semantic history only after the owning domain has accepted it/u,
  );
  assert.match(
    guide,
    /composition policy,[\s\S]*not another data[\s\S]*store or event log/u,
  );
  assert.match(guide, /Garbage collection is plan-only by default/u);
  assert.match(guide, /does not claim protection against physical media loss/u);
  assert.match(guide, /.\/shifu check:data-protection-contract/u);
  assert.match(guide, /.\/shifu check:durable-history-qualification/u);
});
