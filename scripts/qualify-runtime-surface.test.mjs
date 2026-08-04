// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  valueRoot,
  verifyConsumerEvidence,
} from './qualify-runtime-surface.mjs';

const ROOT = `sha256:${'a'.repeat(64)}`;
const candidate = {
  executable: {
    path: '/installed/kungfu',
    digest: ROOT,
    kind: 'installed-kungfu',
    version: '4.0.0-alpha.1',
  },
  source: { commit: null, tree: null, worktree: null },
  bundleRoot: ROOT,
};
const authorityRoots = {
  assignmentRequestRoot: null,
  workDefinitionRoot: null,
  workRoot: null,
};

function fixture(directory) {
  const receipt = {
    schema: 'kungfu.runtime-surface-receipt/v1',
    receiptRoot: ROOT,
    operationId: 'portable-bundle.consume',
    runtimeSurface: 'installed-product',
    authorityRoots,
    executable: candidate.executable,
    source: candidate.source,
    bundleRoot: candidate.bundleRoot,
  };
  const probe = {
    schema: 'kungfu.runtime-surface-consumer-probe/v1',
    ok: true,
    output: {
      schema: 'kungfu.documentation-pack-verification/v1',
      valid: true,
      readOnly: true,
      diagnostics: [],
      receiptRoot: ROOT,
      bundleRoot: candidate.bundleRoot,
    },
  };
  probe.outputRoot = valueRoot(probe.output);
  const body = {
    schema: 'kungfu.runtime-surface-consumer-evidence/v1',
    rowId: 'portable-bundle-installed',
    consumer: 'kungfu.agent.docs.verify',
    probe,
    receipts: [receipt],
  };
  const value = { ...body, evidenceRoot: valueRoot(body) };
  const file = path.join(directory, 'evidence.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return { file, value };
}

function verify(file) {
  return verifyConsumerEvidence({
    rowId: 'portable-bundle-installed',
    file,
    sourceCommand: ['/source/shifu', 'kungfu'],
    installedCommand: ['/installed/kungfu'],
    authorityRoots,
    sourceCandidate: candidate,
    installedCandidate: candidate,
    hybridCandidate: candidate,
    invokeCommand: () => ({ ok: true, receiptRoot: ROOT }),
  });
}

test('qualifier accepts a rooted consumer output and reverified receipt', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-qualifier-'));
  try {
    const { file, value } = fixture(directory);
    assert.deepEqual(verify(file), value);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('qualifier compares receipt coordinates by canonical value, not JSON key order', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-qualifier-'));
  try {
    const { file, value } = fixture(directory);
    value.receipts[0].executable = {
      version: candidate.executable.version,
      kind: candidate.executable.kind,
      digest: candidate.executable.digest,
      path: candidate.executable.path,
    };
    value.receipts[0].source = {
      worktree: null,
      tree: null,
      commit: null,
    };
    value.receipts[0].authorityRoots = {
      workRoot: null,
      workDefinitionRoot: null,
      assignmentRequestRoot: null,
    };
    const body = Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== 'evidenceRoot'),
    );
    value.evidenceRoot = valueRoot(body);
    fs.writeFileSync(file, JSON.stringify(value));
    assert.deepEqual(verify(file), value);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('qualifier rejects re-rooted evidence with forged probe output root', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-qualifier-'));
  try {
    const { file, value } = fixture(directory);
    value.probe.output.valid = false;
    value.evidenceRoot = valueRoot(
      Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== 'evidenceRoot'),
      ),
    );
    fs.writeFileSync(file, JSON.stringify(value));
    assert.throws(() => verify(file), /consumer probe output root mismatch/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('qualifier rejects a semantically failed output even after both roots are recomputed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-qualifier-'));
  try {
    const { file, value } = fixture(directory);
    value.probe.output.valid = false;
    value.probe.outputRoot = valueRoot(value.probe.output);
    value.evidenceRoot = valueRoot(
      Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== 'evidenceRoot'),
      ),
    );
    fs.writeFileSync(file, JSON.stringify(value));
    assert.throws(
      () => verify(file),
      /consumer probe output is not successful/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('qualifier rejects the re-rooted failed seal output from terminal review', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-qualifier-'));
  try {
    const receipt = {
      schema: 'kungfu.runtime-surface-receipt/v1',
      receiptRoot: ROOT,
      operationId: 'assignment.seal-verify',
      runtimeSurface: 'installed-product',
      authorityRoots,
      executable: candidate.executable,
      source: candidate.source,
      bundleRoot: candidate.bundleRoot,
    };
    const probe = {
      schema: 'kungfu.runtime-surface-consumer-probe/v1',
      ok: true,
      output: {
        schema: 'kungfu.assignment-orchestration.seal-verification/v1',
        ok: false,
        reason: 'seal rejected',
      },
      observers: [],
    };
    probe.outputRoot = valueRoot(probe.output);
    const body = {
      schema: 'kungfu.runtime-surface-consumer-evidence/v1',
      rowId: 'seal-installed',
      consumer: 'kungfu.work.verify-seal',
      probe,
      receipts: [receipt],
    };
    const file = path.join(directory, 'seal-evidence.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ ...body, evidenceRoot: valueRoot(body) }),
    );
    assert.throws(
      () =>
        verifyConsumerEvidence({
          rowId: 'seal-installed',
          file,
          sourceCommand: ['/source/shifu', 'kungfu'],
          installedCommand: ['/installed/kungfu'],
          authorityRoots,
          sourceCandidate: candidate,
          installedCandidate: candidate,
          hybridCandidate: candidate,
          invokeCommand: () => ({ ok: true, receiptRoot: ROOT }),
        }),
      /consumer probe output is not successful/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
