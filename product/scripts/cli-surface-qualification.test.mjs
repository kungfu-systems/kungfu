// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { qualifyCliSurface } from './cli-surface-qualification.mjs';

const roots = {
  catalogRoot: 'sha256:catalog',
  surfaceRoot: 'sha256:surface',
  contractRoot: 'sha256:contract',
  registryRoot: 'sha256:registry',
};

function catalog(changes = {}) {
  return {
    schema: 'kungfu.cli-surface-catalog/v1',
    ...roots,
    surfaces: [
      {
        canonical_path: 'kungfu dev sdk',
        aliases: ['kungfu sdk'],
        owner: 'core',
        availability: { state: 'available' },
      },
      {
        canonical_path: 'kungfu profile mission-control',
        aliases: [],
        owner: 'profile-kfx',
        availability: { state: 'available' },
      },
    ],
    kfd3Linkage: [
      { state: 'linked', apiIds: ['kungfu.agent.brief'] },
      { state: 'linked', apiIds: ['kungfu.agent.capabilities'] },
    ],
    ...changes,
  };
}

function runner(observed = catalog()) {
  return ({ args }) => {
    const joined = args.join(' ');
    const json = (value) => ({
      status: 0,
      stdout: JSON.stringify(value),
      stderr: '',
    });
    if (joined.endsWith('--version'))
      return { status: 0, stdout: '4.0.0\n', stderr: '' };
    if (joined.endsWith('--help-json')) {
      return json({
        schema: 'kungfu.cli-help-projection/v1',
        contractRoot: observed.contractRoot,
        registryRoot: observed.registryRoot,
        projectionRoot: 'sha256:projection',
      });
    }
    if (joined.endsWith('--help-all')) {
      return {
        status: 0,
        stdout:
          'START HERE\nACTION MODEL\nFACTS & PROOF\nSYSTEM & MAINTENANCE\nDEVELOPER\n',
        stderr: '',
      };
    }
    if (joined.endsWith('--help')) {
      if (joined.includes(' sdk ')) {
        return {
          status: 0,
          stdout: 'SDK help\n',
          stderr: joined.includes(' dev sdk ')
            ? ''
            : 'warning: `kungfu sdk` is a compatibility alias; use `kungfu dev sdk`\n',
        };
      }
      return {
        status: 0,
        stdout: 'START HERE\nACTION MODEL\nFACTS & PROOF\n',
        stderr: '',
      };
    }
    if (joined.includes('agent capabilities --json')) {
      return json({
        schema: 'kungfu.agent-capabilities/v1',
        commands: { schema: 'kungfu.agent-commands/v1' },
        cliSurface: observed,
      });
    }
    if (joined.includes('profile capabilities --json')) {
      return json({ schema: 'kungfu.profile-sdk-capabilities/v1' });
    }
    if (joined.includes('kfx list --json')) return json([]);
    if (joined.includes('agent brief')) {
      return { status: 0, stdout: 'Use kungfu xinfa compile\n', stderr: '' };
    }
    if (joined.includes('profile scaffold')) {
      if (joined.includes('--execute')) {
        return json({
          schema: 'kungfu.profile-source-receipt/v1',
          planId: 'sha256:plan',
          verified: true,
        });
      }
      return json({
        schema: 'kungfu.profile-source-plan/v1',
        ok: true,
        planId: 'sha256:plan',
      });
    }
    throw new Error(`unexpected command: ${joined}`);
  };
}

test('qualification binds help, Agent, alias, KFD-3 and mutation receipts', () => {
  const report = qualifyCliSurface({
    cli: '/fixture/kungfu',
    expectedCatalog: catalog(),
    runCommand: runner(),
  });
  assert.equal(report.qualified, true);
  assert.deepEqual(report.roots, roots);
  assert.equal(report.checks.mutationPlanReceipt.receiptVerified, true);
  assert.match(report.qualificationRoot, /^sha256:[0-9a-f]{64}$/u);
});

test('qualification fails closed when installed roots drift', () => {
  assert.throws(
    () =>
      qualifyCliSurface({
        cli: '/fixture/kungfu',
        expectedCatalog: catalog(),
        runCommand: runner(catalog({ surfaceRoot: 'sha256:drift' })),
      }),
    /surfaceRoot mismatch/u,
  );
});
