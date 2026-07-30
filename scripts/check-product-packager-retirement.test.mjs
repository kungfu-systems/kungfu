// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { retirementIssues } from './check-runtime-greenfield.mjs';

const retiredName = ['Py', 'Installer'].join('');
const resetEnvironment = ['PY', 'INSTALLER', '_RESET_ENVIRONMENT'].join('');

test('retirement ratchet rejects active runtime signatures and dependencies', () => {
  const issues = retirementIssues([
    {
      path: 'framework/core/src/python/kungfu/host.py',
      text: `if sys.frozen: ${resetEnvironment} = ${JSON.stringify(retiredName)}`,
    },
  ]);

  assert.ok(issues.some((issue) => issue.includes('product-packager name')));
  assert.ok(issues.some((issue) => issue.includes('product-host probe')));
  assert.ok(issues.some((issue) => issue.includes('reset environment')));
});

test('retirement ratchet rejects hooks, specs, and active product terminology', () => {
  const issues = retirementIssues([
    { path: 'framework/core/src/python/legacy.spec', text: '' },
    { path: 'framework/core/src/python/pyi-hooks/hook.py', text: '' },
    { path: 'docs/guides/config.md', text: 'the frozen product loads config' },
  ]);

  assert.ok(issues.some((issue) => issue.includes('legacy.spec')));
  assert.ok(issues.some((issue) => issue.includes('pyi-hooks')));
  assert.ok(issues.some((issue) => issue.includes('frozen product')));
});

test('retirement ledger allowlist is exact and cannot absorb active prose', () => {
  const allowed = retirementIssues([
    {
      path: 'docs/development/buildchain.md',
      text: 'the Nuitka/PyInstaller freeze legs were retired 2026-07-11',
    },
  ]);
  const rejected = retirementIssues([
    {
      path: 'docs/development/buildchain.md',
      text: `${retiredName} remains available as a fallback`,
    },
  ]);

  assert.deepEqual(allowed, []);
  assert.ok(rejected.some((issue) => issue.includes('name is active')));
});

test('historical product terminology is limited to named records', () => {
  const historical = retirementIssues([
    {
      path: 'docs/adr/KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05.md',
      text: 'the frozen host was replaced by the assembled product',
    },
  ]);
  const active = retirementIssues([
    {
      path: 'docs/adr/KF-ADR-019f86da-4f90-74c2-9cbb-24f1c34303bf.md',
      text: 'the frozen product remains supported',
    },
  ]);

  assert.deepEqual(historical, []);
  assert.ok(active.some((issue) => issue.includes('frozen product')));
});

test('Nuitka AOT terminology remains valid outside the product host taxonomy', () => {
  assert.deepEqual(
    retirementIssues([
      {
        path: 'framework/core/src/python/kungfu/cli/bridging/nuitka/__init__.py',
        text: 'from nuitka.__main__ import main as nuitka_main',
      },
    ]),
    [],
  );
});
