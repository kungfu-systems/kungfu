// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  dockerArgs,
  dockerIsRootless,
  validateDockerHost,
} from '@kungfu-tech/work/agent-repository-work/opencode-docker-proxy';
import {
  classifyFailure,
  parseInvestigationClaim,
  parseArgs as parseRepositoryWorkArgs,
  runExperiment,
  runtimeProfile,
  validateExperimentReport,
} from '@kungfu-tech/work/agent-repository-work/run';
import {
  REPOSITORY_WORK_FIXTURES,
  SYNTHETIC_REPOSITORY_WORK_FIXTURES,
  getRepositoryWorkFixture,
} from '../tests/qualification/agent-repository-work/fixture-catalog.mjs';
import {
  applyIncidentBoardReferenceRepair,
  materializeIncidentBoardFixture,
  qualifyReferenceIncidentBoardRepair,
  qualifySeededIncidentBoardFixture,
  verifyIncidentBoardWorkspace,
} from '../tests/qualification/agent-repository-work/incident-board-replay-v1-oracle.mjs';
import { INCIDENT_BOARD_FIXTURE } from '../tests/qualification/agent-repository-work/incident-board-replay-v1.mjs';
import {
  applyRealModuleSnapshotReferenceRepair,
  materializeRealModuleSnapshot,
  qualifyReferenceRealModuleSnapshot,
  qualifySeededRealModuleSnapshot,
  verifyRealModuleSnapshotWorkspace,
} from '../tests/qualification/agent-repository-work/kungfu-agent-patrol-real-module-snapshot-v1-oracle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(
  root,
  'tests/qualification/agent-repository-work/contract.json',
);
const fixturePath = path.join(
  root,
  'tests/qualification/agent-repository-work/incident-board-replay-v1.mjs',
);
const oraclePath = path.join(
  root,
  'tests/qualification/agent-repository-work/incident-board-replay-v1-oracle.mjs',
);
const referencePath = path.join(
  root,
  'tests/qualification/agent-repository-work/incident-board-replay-v1-reference.mjs',
);
const mockOpenCodePath = path.join(
  root,
  'tests/qualification/agent-repository-work/mock-opencode.mjs',
);

function fileRoot(file) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex')}`;
}

function withWorkspace(callback) {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-repository-work-test.'),
  );
  try {
    const initial = materializeIncidentBoardFixture(workspace);
    return callback(workspace, initial);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

test('fixture contract pins a moderate deterministic repository', () => {
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const fileCount = Object.keys(INCIDENT_BOARD_FIXTURE.files).length;
  const lineCount = Object.values(INCIDENT_BOARD_FIXTURE.files).reduce(
    (count, content) => count + content.split('\n').length,
    0,
  );
  assert.equal(contract.schema, 'kungfu.agent-repository-work.v1');
  assert.equal(fileCount, contract.fixture.fileCount);
  assert.equal(lineCount, contract.fixture.lineCount);
  assert.ok(fileCount >= 30 && fileCount <= 50);
  assert.ok(lineCount >= 2_000 && lineCount <= 4_000);
  assert.equal(contract.fixture.sourceRoot, fileRoot(fixturePath));
  assert.equal(contract.oracle.sourceRoot, fileRoot(oraclePath));
  assert.equal(contract.oracle.referenceRoot, fileRoot(referencePath));
  assert.equal(contract.oracle.mountedIntoAgentWorkspace, false);
  assert.deepEqual(
    contract.fixtureCatalog.entries.map(({ id }) => id).sort(),
    SYNTHETIC_REPOSITORY_WORK_FIXTURES.map(({ id }) => id).sort(),
  );
  assert.equal(REPOSITORY_WORK_FIXTURES.length, 4);
});

test('fixture catalog exposes three independently seeded synthetic repairs', () => {
  assert.equal(SYNTHETIC_REPOSITORY_WORK_FIXTURES.length, 3);
  assert.equal(
    new Set(SYNTHETIC_REPOSITORY_WORK_FIXTURES.map(({ id }) => id)).size,
    SYNTHETIC_REPOSITORY_WORK_FIXTURES.length,
  );
  for (const fixture of SYNTHETIC_REPOSITORY_WORK_FIXTURES) {
    const seeded = qualifySeededIncidentBoardFixture(fixture);
    assert.equal(seeded.passed, true, fixture.id);
    assert.deepEqual(
      seeded.expectedFailures,
      fixture.investigation.expectedFailures,
    );
    const reference = qualifyReferenceIncidentBoardRepair(fixture);
    assert.equal(reference.passed, true, fixture.id);
    assert.deepEqual(
      reference.changedPaths,
      fixture.warrants.agentB.writablePaths.slice().sort(),
    );
  }
});

test('real module snapshot is content-rooted, seeded, and independently repairable', () => {
  const fixture = getRepositoryWorkFixture(
    'kungfu-agent-patrol-real-module-snapshot-v1',
  );
  const seeded = qualifySeededRealModuleSnapshot({ fixture });
  assert.equal(seeded.passed, true, JSON.stringify(seeded));
  assert.match(seeded.sourceTreeRoot, /^sha256:[0-9a-f]{64}$/u);
  const reference = qualifyReferenceRealModuleSnapshot({ fixture });
  assert.equal(reference.passed, true);
  assert.deepEqual(reference.changedPaths, [
    'developer/agent-patrol/classify.mjs',
  ]);
  assert.equal(reference.checks.visible.passed, true);
  assert.equal(reference.checks.hidden.passed, true);
});

test('real module snapshot external oracle rejects protected-path changes', () => {
  const fixture = getRepositoryWorkFixture(
    'kungfu-agent-patrol-real-module-snapshot-v1',
  );
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-patrol-real-snapshot-scope.'),
  );
  try {
    const materialized = materializeRealModuleSnapshot(workspace, { fixture });
    applyRealModuleSnapshotReferenceRepair(workspace);
    fs.appendFileSync(
      path.join(workspace, 'developer/agent-patrol/select.mjs'),
      '\n// out-of-scope mutation\n',
    );
    const report = verifyRealModuleSnapshotWorkspace(workspace, {
      fixture,
      expectedInitialTree: materialized.initialTree,
    });
    assert.equal(report.passed, false);
    assert.deepEqual(report.scopeViolations, [
      'developer/agent-patrol/select.mjs',
    ]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('repository-work CLI selects one declared fixture explicitly', () => {
  const parsed = parseRepositoryWorkArgs([
    '--',
    '--fixture',
    'incident-board-lease-v1',
    '--opencode',
    mockOpenCodePath,
  ]);
  assert.equal(parsed.fixture, 'incident-board-lease-v1');
  assert.equal(
    getRepositoryWorkFixture(parsed.fixture).warrants.agentB.writablePaths
      .length,
    1,
  );
  assert.throws(
    () =>
      parseRepositoryWorkArgs([
        '--fixture',
        'unknown-fixture',
        '--opencode',
        mockOpenCodePath,
      ]),
    /unknown repository-work fixture/u,
  );
});

test('seeded defect fails and independent reference repair passes', () => {
  assert.equal(qualifySeededIncidentBoardFixture().passed, true);
  const reference = qualifyReferenceIncidentBoardRepair();
  assert.equal(reference.passed, true);
  assert.deepEqual(
    reference.changedPaths,
    INCIDENT_BOARD_FIXTURE.warrants.agentB.writablePaths.slice().sort(),
  );
  assert.equal(reference.checks.visible.passed, true);
  assert.equal(reference.checks.hidden.passed, true);
});

test('external oracle fails closed on protected or added paths', () => {
  withWorkspace((workspace, initial) => {
    applyIncidentBoardReferenceRepair(workspace);
    fs.appendFileSync(path.join(workspace, 'README.md'), '\ntampered\n');
    const report = verifyIncidentBoardWorkspace(workspace, {
      expectedInitialTree: initial,
    });
    assert.equal(report.passed, false);
    assert.deepEqual(report.scopeViolations, ['README.md']);
  });
  withWorkspace((workspace, initial) => {
    applyIncidentBoardReferenceRepair(workspace);
    fs.writeFileSync(path.join(workspace, 'incident_board/shortcut.py'), '');
    const report = verifyIncidentBoardWorkspace(workspace, {
      expectedInitialTree: initial,
    });
    assert.equal(report.passed, false);
    assert.deepEqual(report.scopeViolations, ['incident_board/shortcut.py']);
  });
});

test('Docker profile is digest-pinned, bounded, and mode-specific', () => {
  const input = {
    id: 'test',
    model: 'qwen3-coder:30b-opencode-64k',
    image:
      'example.invalid/opencode-ci@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    baseUrl: 'http://host.docker.internal:11435/v1',
    opencode: '',
    agent: 'plan',
    dockerHost: 'unix:///run/user/996/docker.sock',
  };
  const profile = runtimeProfile({ ...input, mode: 'read-only' });
  assert.equal(profile.provider, 'opencode');
  assert.equal(profile.launch.executable, process.execPath);
  assert.ok(profile.launch.argv.includes('--mode'));
  assert.ok(profile.launch.argv.includes('read-only'));
  const dockerHostIndex = profile.launch.argv.indexOf('--docker-host');
  assert.equal(
    profile.launch.argv[dockerHostIndex + 1],
    'unix:///run/user/996/docker.sock',
  );
  const rootfulProfile = runtimeProfile({
    ...input,
    mode: 'read-only',
    dockerHost: '',
  });
  assert.equal(rootfulProfile.launch.argv.includes('--docker-host'), false);
  const args = dockerArgs(
    {
      image: input.image,
      baseUrl: input.baseUrl,
      model: input.model,
      context: 65_536,
      mode: 'read-only',
      command: ['run', '--pure', 'prompt'],
    },
    '/tmp/disposable-workspace',
  );
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('ALL'));
  assert.ok(args.includes('no-new-privileges'));
  assert.ok(args.includes('PYTHONDONTWRITEBYTECODE=1'));
  assert.ok(args.includes('/tmp/disposable-workspace:/workspace:ro'));
  assert.ok(!args.includes('--privileged'));
  assert.ok(!args.includes('/var/run/docker.sock'));
  assert.ok(!args.includes('host'));
});

test('Docker bind-mount identity follows rootful and rootless ownership', () => {
  const options = {
    image:
      'example.invalid/opencode-ci@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    baseUrl: 'http://host.docker.internal:11435/v1',
    model: 'qwen3-coder:30b-opencode-64k',
    context: 65_536,
    mode: 'bounded-write',
    command: ['run', '--pure', 'prompt'],
  };
  const rootlessArgs = dockerArgs(
    { ...options, rootless: true },
    '/tmp/disposable-workspace',
  );
  const rootfulArgs = dockerArgs(
    { ...options, rootless: false },
    '/tmp/disposable-workspace',
  );
  const userIndex = rootlessArgs.indexOf('--user');
  assert.equal(rootlessArgs[userIndex + 1], '0:0');
  assert.equal(
    rootfulArgs[userIndex + 1],
    `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
  );
  assert.equal(dockerIsRootless('["name=seccomp","name=rootless"]'), true);
  assert.equal(dockerIsRootless('["name=seccomp","name=cgroupns"]'), false);
  assert.equal(
    validateDockerHost('unix:///run/user/996/docker.sock', 996),
    'unix:///run/user/996/docker.sock',
  );
  assert.equal(
    validateDockerHost('unix:///var/run/docker.sock', 996),
    'unix:///var/run/docker.sock',
  );
  assert.throws(
    () => validateDockerHost('tcp://127.0.0.1:2375', 996),
    /current user rootless socket/u,
  );
  assert.throws(
    () => validateDockerHost('unix:///run/user/1000/docker.sock', 996),
    /current user rootless socket/u,
  );
});

test('Agent A claim and final report require deterministic continuity evidence', () => {
  const claim = {
    schema: 'kungfu.agent-repository-work.investigation-claim/v1',
    investigationComplete: true,
    failingTests: [
      'test_expired_lease_cannot_complete',
      'test_legacy_duplicate_log_has_stable_restart_summary',
    ],
    repairPaths: [
      'incident_board/commands.py',
      'incident_board/lease.py',
      'incident_board/replay.py',
    ],
    remainingObligation: 'implement-and-verify-bounded-repair',
    nextAction: 'repair-seeded-completion-idempotency',
  };
  assert.deepEqual(parseInvestigationClaim(JSON.stringify(claim)), claim);
  assert.throws(
    () => parseInvestigationClaim('javascript\nnot-json'),
    (error) => {
      assert.equal(
        error.message,
        'Agent A returned invalid JSON investigation output',
      );
      assert.equal(error.failureCategory, 'model-tool-runtime');
      assert.equal(classifyFailure(error), 'model-tool-runtime');
      return true;
    },
  );
  const report = {
    schema: 'kungfu.agent-repository-work.report/v1',
    evidenceClass: 'bounded-experiment',
    passed: true,
    sessions: {
      distinct: 2,
      a: { providerSessionId: 'session-a' },
      b: { providerSessionId: 'session-b' },
    },
    continuity: {
      priorTranscriptBytes: 0,
      humanRestatementCount: 0,
      root: `sha256:${'a'.repeat(64)}`,
    },
    warrant: { agentAZeroModification: true },
    claim: { root: `sha256:${'b'.repeat(64)}` },
    assessment: { root: `sha256:${'c'.repeat(64)}` },
    oracle: {
      passed: true,
      authoritative: true,
      reportRoot: `sha256:${'d'.repeat(64)}`,
    },
    nonClaims: {
      auditableDemo: true,
      agentWorkLab: true,
      releaseGate: true,
      publicClaim: true,
    },
  };
  assert.equal(validateExperimentReport(report), true);
  report.sessions.b.providerSessionId = 'session-a';
  assert.throws(
    () => validateExperimentReport(report),
    /not fresh and distinct/u,
  );
});

test('native Kungfu runner carries a transcript-free continuation end to end', () => {
  const output = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-repository-work-runner-test.'),
  );
  try {
    const result = runExperiment({
      output,
      opencode: mockOpenCodePath,
      model: 'mock-repository-model',
      sourceHead: '0123456789abcdef0123456789abcdef01234567',
      timeoutSeconds: 120,
    });
    assert.equal(result.report.passed, true, result.report.failure?.message);
    assert.equal(result.report.sessions.distinct, 2);
    assert.equal(result.report.continuity.priorTranscriptBytes, 0);
    assert.equal(result.report.continuity.humanRestatementCount, 0);
    assert.equal(result.report.warrant.agentAZeroModification, true);
    assert.equal(result.report.oracle.passed, true);
    assert.deepEqual(result.report.warrant.scopeViolations, []);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test('failed repair retains bounded session and oracle diagnostics', () => {
  const output = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-repository-work-failure-test.'),
  );
  try {
    const result = runExperiment({
      output,
      opencode: mockOpenCodePath,
      model: 'mock-incomplete-repository-model',
      sourceHead: '0123456789abcdef0123456789abcdef01234567',
      timeoutSeconds: 120,
    });
    assert.equal(result.report.passed, false);
    assert.equal(result.report.failure.category, 'verifier');
    assert.equal(result.report.sessions.distinct, 2);
    assert.equal(result.report.oracle.passed, false);
    assert.equal(result.report.oracle.checks.visible.passed, false);
    assert.equal(result.report.oracle.checks.hidden.passed, false);
    assert.deepEqual(result.report.warrant.scopeViolations, []);
    assert.ok(fs.existsSync(result.reportPath));
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});
