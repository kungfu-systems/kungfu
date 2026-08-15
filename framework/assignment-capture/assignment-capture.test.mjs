// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { semanticRoot } from '../project-cut/src/project-cut.mjs';
import {
  ASSIGNMENT_REQUEST_SCHEMA,
  AssignmentCaptureError,
  RETENTION_POLICY,
  captureAssignmentRequest,
  executeAssignmentCleanup,
  planAssignmentCleanup,
  resolveCaptureTarget,
} from './assignment-capture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FIXTURE = path.join(
  HERE,
  'fixtures',
  'assignment-request-roundtrip-v1.json',
);

function temporary() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-assignment-capture-'));
}

function request(workDefinition, expiresAt = null) {
  return {
    schema: ASSIGNMENT_REQUEST_SCHEMA,
    source: { kind: 'external-work-coordinator' },
    retention: { policy: RETENTION_POLICY, expiresAt },
    workDefinition,
  };
}

test('capture round-trips a complete external Assignment definition', () => {
  const root = temporary();
  try {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const response = captureAssignmentRequest(request(fixture.workDefinition), {
      workspaceRoot: root,
      cwd: root,
      env: { HOME: path.join(root, 'home') },
    });
    assert.equal(response.status, 'captured');
    assert.equal(response.authority, 'capture-material-only');
    assert.equal(response.admitted, false);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(response.requestPath, 'utf8')).workDefinition,
      fixture.workDefinition,
    );
    assert.deepEqual(
      Object.keys(
        JSON.parse(fs.readFileSync(response.requestPath, 'utf8'))
          .workDefinition,
      ).sort(),
      Object.keys(fixture.workDefinition).sort(),
    );
    const fieldNames = Object.keys(fixture.workDefinition).sort();
    assert.equal(fieldNames.length, fixture.provenance.topLevelFieldCount);
    assert.equal(
      semanticRoot(fieldNames),
      fixture.provenance.topLevelFieldRoot,
    );
    assert.match(response.requestRoot, /^sha256:[0-9a-f]{64}$/u);
    assert.match(response.receiptRoot, /^sha256:[0-9a-f]{64}$/u);
    const receipt = JSON.parse(fs.readFileSync(response.receiptPath, 'utf8'));
    const { receiptRoot: declaredReceiptRoot, ...receiptCore } = receipt;
    assert.equal(semanticRoot(receiptCore), declaredReceiptRoot);
    assert.equal(fs.existsSync(path.join(root, '.kungfu', 'runtime')), false);
    assert.equal(
      captureAssignmentRequest(request(fixture.workDefinition), {
        workspaceRoot: root,
        cwd: root,
        env: { HOME: path.join(root, 'home') },
      }).status,
      'already-present',
    );

    const nested = path.join(root, 'nested');
    fs.mkdirSync(nested);
    const discovered = captureAssignmentRequest(
      request(fixture.workDefinition),
      {
        cwd: nested,
        env: { HOME: path.join(root, 'home') },
      },
    );
    assert.equal(discovered.status, 'captured');
    assert.equal(discovered.requestPath, response.requestPath);
    assert.notEqual(discovered.receiptRoot, response.receiptRoot);
    assert.equal(
      captureAssignmentRequest(request(fixture.workDefinition), {
        cwd: nested,
        env: { HOME: path.join(root, 'home') },
      }).status,
      'already-present',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('capture target order matches workspace.py capture-only resolution', () => {
  const root = temporary();
  try {
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const nested = path.join(project, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(project, '.kungfu'));
    const env = { HOME: home };

    const explicit = resolveCaptureTarget({
      workspaceRoot: project,
      cwd: nested,
      env,
    });
    assert.equal(explicit.resolutionReason, 'explicit-workspace');
    assert.equal(
      explicit.workspaceId,
      `project:${createHash('sha256').update(canonical(project), 'utf8').digest('hex').slice(0, 16)}`,
    );
    assert.equal(
      resolveCaptureTarget({ home: true, cwd: nested, env }).resolutionReason,
      'explicit-home',
    );
    assert.equal(
      resolveCaptureTarget({
        cwd: root,
        env: { ...env, KF_WORKSPACE_ROOT: project },
      }).resolutionReason,
      'environment-workspace-root',
    );
    assert.equal(
      resolveCaptureTarget({
        cwd: root,
        env: { ...env, KF_HOME: `${home}/.kungfu` },
      }).resolutionReason,
      'environment-home',
    );
    assert.equal(
      resolveCaptureTarget({ cwd: nested, env }).resolutionReason,
      'discovered-project-workspace',
    );

    const gitProject = path.join(root, 'git-project');
    fs.mkdirSync(gitProject);
    const initialized = spawnSync('git', ['init', '-q', gitProject]);
    assert.equal(initialized.status, 0);
    assert.equal(
      resolveCaptureTarget({ cwd: gitProject, env }).dataHome,
      path.join(canonical(gitProject), '.kungfu'),
    );

    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    const fallback = resolveCaptureTarget({ cwd: outside, env });
    assert.equal(fallback.workspaceKind, 'home');
    assert.equal(fallback.association, 'unassigned');
    assert.equal(fallback.resolutionReason, 'no-project-workspace');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function canonical(value) {
  return fs.realpathSync.native(path.resolve(value));
}

test('expiry cleanup is dry-run-first and retains captured bytes', () => {
  const root = temporary();
  try {
    const response = captureAssignmentRequest(
      request({ assignment_id: 'expired' }, '2026-01-01T00:00:00Z'),
      {
        workspaceRoot: root,
        cwd: root,
        env: { HOME: path.join(root, 'home') },
      },
    );
    const options = {
      workspaceRoot: root,
      cwd: root,
      env: { HOME: path.join(root, 'home') },
      now: '2026-07-22T00:00:00Z',
    };
    const plan = planAssignmentCleanup(options);
    assert.equal(plan.executed, false);
    assert.equal(plan.candidates.length, 1);
    assert.deepEqual(plan.candidates[0].captureReceiptPaths, [
      path.relative(
        canonical(path.join(root, '.kungfu')),
        response.receiptPath,
      ),
    ]);
    assert.equal(
      fs.existsSync(
        path.join(path.dirname(response.requestPath), 'expiry-receipt.json'),
      ),
      false,
    );
    assert.throws(
      () =>
        executeAssignmentCleanup({
          ...options,
          execute: true,
          expectedPlanRoot: `sha256:${'0'.repeat(64)}`,
        }),
      (error) =>
        error instanceof AssignmentCaptureError &&
        error.code === 'cleanup-plan-stale',
    );
    const executed = executeAssignmentCleanup({
      ...options,
      execute: true,
      expectedPlanRoot: plan.planRoot,
    });
    assert.equal(executed.executed, true);
    assert.equal(executed.receipts.length, 1);
    assert.equal(fs.existsSync(response.requestPath), true);
    assert.equal(fs.existsSync(response.receiptPath), true);
    assert.equal(planAssignmentCleanup(options).candidates.length, 0);
    assert.equal(fs.existsSync(path.join(root, '.kungfu', 'runtime')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup fails closed for request material without a valid receipt', () => {
  const root = temporary();
  try {
    const response = captureAssignmentRequest(
      request({ assignment_id: 'incomplete' }, '2026-01-01T00:00:00Z'),
      {
        workspaceRoot: root,
        cwd: root,
        env: { HOME: path.join(root, 'home') },
      },
    );
    fs.rmSync(response.receiptPath);
    assert.throws(
      () =>
        planAssignmentCleanup({
          workspaceRoot: root,
          cwd: root,
          env: { HOME: path.join(root, 'home') },
          now: '2026-07-22T00:00:00Z',
        }),
      (error) =>
        error instanceof AssignmentCaptureError &&
        error.code === 'capture-incomplete',
    );
    assert.equal(fs.existsSync(response.requestPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Shifu source entry captures without compiled Kungfu artifacts', () => {
  const root = temporary();
  try {
    const requestPath = path.join(root, 'request.json');
    fs.writeFileSync(
      requestPath,
      `${JSON.stringify(request({ assignment_id: 'source-entry' }))}\n`,
    );
    const args = [
      'work',
      'capture',
      '--request',
      requestPath,
      '--home',
      '--cwd',
      root,
      '--json',
    ];
    const sourceOnlyPath = [
      path.dirname(process.execPath),
      process.platform === 'win32'
        ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
        : '/usr/bin',
      ...(process.platform === 'win32' ? [] : ['/bin']),
    ].join(path.delimiter);
    const result =
      process.platform === 'win32'
        ? spawnSync(
            process.env.ComSpec || 'cmd.exe',
            ['/d', '/s', '/c', 'shifu.cmd', ...args],
            {
              cwd: REPO_ROOT,
              encoding: 'utf8',
              env: {
                ...process.env,
                HOME: path.join(root, 'home'),
                PATH: sourceOnlyPath,
              },
            },
          )
        : spawnSync('./shifu', args, {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            env: {
              ...process.env,
              HOME: path.join(root, 'home'),
              PATH: sourceOnlyPath,
            },
          });
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.target.workspaceKind, 'home');
    assert.equal(response.target.runtimeInitialized, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
