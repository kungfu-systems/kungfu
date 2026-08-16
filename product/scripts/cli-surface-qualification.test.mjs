// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cliQualificationNonClaims,
  cliQualificationPlatform,
  cliQualificationRoot,
  cliSpawnSpecification,
  qualifyCliSurface,
} from './cli-surface-qualification.mjs';
import { verifyCliSurfaceQualification } from './verify-cli-surface-qualification.mjs';

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
        canonical_path: 'kungfu sdk',
        aliases: [],
        owner: 'core',
        maturity: 'stable',
        availability: { state: 'available' },
      },
      {
        canonical_path: 'kungfu env',
        aliases: [],
        owner: 'core',
        maturity: 'stable',
        availability: { state: 'available' },
      },
      {
        canonical_path: 'kungfu dev engage',
        aliases: [],
        owner: 'core',
        maturity: 'stable',
        availability: { state: 'available' },
      },
      {
        canonical_path: 'kungfu dev schema',
        aliases: [],
        owner: 'core',
        maturity: 'stable',
        availability: { state: 'available' },
      },
      {
        canonical_path: 'kungfu work',
        aliases: [],
        owner: 'core',
        maturity: 'stable',
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
    if (joined.endsWith('--version')) {
      return {
        status: 0,
        stdout: '4.0.0\nKungfu UNGFU™ · Never Guess. Facts Unfold.\n',
        stderr: '',
      };
    }
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
    if (joined === '' || joined.endsWith('--help')) {
      if (joined.includes(' sdk ')) {
        return {
          status: 0,
          stdout: 'SDK help\n',
          stderr: '',
        };
      }
      return {
        status: 0,
        stdout: 'Project → Work → Agent\nSTART HERE\n',
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
    if (joined.includes('agent first-value contract --json')) {
      return json({
        schema: 'kungfu.agent-first-value-contract-view/v1',
        contract: {
          result: { maximumQuestionCount: 1 },
          qualification: { ci: 'deterministic-contract-and-receipt-only' },
        },
      });
    }
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

test('qualification binds help, canonical CLI, KFD-3 and mutation receipts', () => {
  const report = qualifyCliSurface({
    cli: '/fixture/kungfu',
    expectedCatalog: catalog(),
    label: 'cli-archive',
    identity: {
      archive: 'kungfu-episodes-cli-fixture.tar.gz',
      archiveSha256: `sha256:${'a'.repeat(64)}`,
      sourceCommit: '1'.repeat(40),
    },
    runCommand: runner(),
  });
  assert.equal(report.qualified, true);
  assert.equal(report.version, '4.0.0');
  assert.equal(report.architecture, process.arch);
  assert.deepEqual(report.claims, {
    installedProduct: true,
    qualifiedPlatform: report.platform,
  });
  assert.deepEqual(
    report.nonClaims,
    cliQualificationNonClaims(report.platform),
  );
  assert.deepEqual(report.productIdentity, {
    exactMark: 'Kungfu UNGFU™',
    principle: 'Never Guess. Facts Unfold.',
    renderedVersionOutput: '4.0.0\nKungfu UNGFU™ · Never Guess. Facts Unfold.',
    verifiedFromInstalledCommand: true,
  });
  assert.deepEqual(report.roots, roots);
  assert.equal(report.inventory.aliasCount, 0);
  assert.equal(report.checks.canonicalOnly.aliases, 0);
  assert.equal(report.checks.mutationPlanReceipt.receiptVerified, true);
  assert.match(report.qualificationRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(
    verifyCliSurfaceQualification({
      report,
      expectedPlatform: report.platform,
      archiveName: report.identity.archive,
      archiveSha256: report.identity.archiveSha256,
    }).verified,
    true,
  );
});

test('qualification accepts presentation-only alignment drift in bare help', () => {
  const baseRunner = runner();
  const report = qualifyCliSurface({
    cli: '/fixture/kungfu',
    expectedCatalog: catalog(),
    runCommand(input) {
      const result = baseRunner(input);
      if (input.args.length === 0) {
        return {
          ...result,
          stdout: result.stdout.replace('Project → Work', 'Project  →  Work'),
        };
      }
      return result;
    },
  });
  assert.equal(report.qualified, true);
});

test('verification binds the qualification to the exact archive digest', () => {
  const report = qualifyCliSurface({
    cli: '/fixture/kungfu',
    expectedCatalog: catalog(),
    label: 'cli-archive',
    identity: {
      archive: 'kungfu-episodes-cli-fixture.tar.gz',
      archiveSha256: `sha256:${'a'.repeat(64)}`,
      sourceCommit: '1'.repeat(40),
    },
    runCommand: runner(),
  });
  assert.throws(
    () =>
      verifyCliSurfaceQualification({
        report,
        expectedPlatform: report.platform,
        archiveName: report.identity.archive,
        archiveSha256: `sha256:${'b'.repeat(64)}`,
      }),
    /archive SHA256 mismatch/u,
  );
});

test('verification rejects a tampered qualification root', () => {
  const report = qualifyCliSurface({
    cli: '/fixture/kungfu',
    expectedCatalog: catalog(),
    label: 'cli-archive',
    identity: {
      archive: 'kungfu-episodes-cli-fixture.tar.gz',
      archiveSha256: `sha256:${'a'.repeat(64)}`,
      sourceCommit: '1'.repeat(40),
    },
    runCommand: runner(),
  });
  report.checks.kfd3.linkedApiCount += 1;
  assert.throws(
    () =>
      verifyCliSurfaceQualification({
        report,
        expectedPlatform: report.platform,
        archiveName: report.identity.archive,
        archiveSha256: report.identity.archiveSha256,
      }),
    /qualification semantic root mismatch/u,
  );
});

test('verification rejects a qualified platform OS non-claim', () => {
  const report = qualifyCliSurface({
    cli: '/fixture/kungfu',
    expectedCatalog: catalog(),
    label: 'cli-archive',
    identity: {
      archive: 'kungfu-episodes-cli-fixture.tar.gz',
      archiveSha256: `sha256:${'a'.repeat(64)}`,
      sourceCommit: '1'.repeat(40),
    },
    runCommand: runner(),
  });
  const system = report.platform.split('-')[0];
  const qualifiedSystemLabel = {
    darwin: 'macOS',
    linux: 'Linux',
    windows: 'Windows',
  }[system];
  report.nonClaims = [
    `${qualifiedSystemLabel} is not qualified by this receipt.`,
    ...cliQualificationNonClaims(report.platform),
  ];
  Reflect.deleteProperty(report, 'qualificationRoot');
  report.qualificationRoot = cliQualificationRoot(report);
  assert.throws(
    () =>
      verifyCliSurfaceQualification({
        report,
        expectedPlatform: report.platform,
        archiveName: report.identity.archive,
        archiveSha256: report.identity.archiveSha256,
      }),
    /qualification non-claims contradict the qualified platform/u,
  );
});

test('qualification rejects a product without the secondary signature', () => {
  const unsignedRunner = runner();
  assert.throws(
    () =>
      qualifyCliSurface({
        cli: '/fixture/kungfu',
        expectedCatalog: catalog(),
        runCommand(input) {
          if (input.args.join(' ').endsWith('--version')) {
            return { status: 0, stdout: '4.0.0\n', stderr: '' };
          }
          return unsignedRunner(input);
        },
      }),
    /omitted the secondary product signature/u,
  );
});

test('qualification non-claims exclude the exact qualified platform', () => {
  const claims = cliQualificationNonClaims('linux-arm64');
  assert.deepEqual(claims, [
    'macOS is not qualified by this receipt.',
    'Windows is not qualified by this receipt.',
    'Availability metadata does not activate a KFX contribution.',
  ]);
  assert.ok(!claims.some((claim) => claim.includes('Linux')));
});

test('qualification maps the Windows runtime name to its public platform id', () => {
  assert.equal(cliQualificationPlatform('win32', 'x64'), 'windows-x64');
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

test('Windows installed CLI dispatches cmd shims through ComSpec', () => {
  const specification = cliSpawnSpecification(
    'C:\\Program Files\\Kungfu\\kungfu.cmd',
    ['--home', 'C:\\Kungfu Home', '--version'],
    'win32',
    { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
  );
  assert.equal(specification.shell, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(specification.args, []);
  assert.match(specification.command, /kungfu\.cmd/u);
  assert.match(specification.command, /--home/u);
  assert.match(specification.command, /"C:\\Kungfu Home"/u);
});
