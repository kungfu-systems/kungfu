// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { INCIDENT_BOARD_REFERENCE_REPAIR } from './incident-board-replay-v1-reference.mjs';
import { INCIDENT_BOARD_FIXTURE } from './incident-board-replay-v1.mjs';

const REPORT_SCHEMA = 'kungfu.agent-repository-work.oracle-report/v1';
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function root(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function normalizedRelative(value) {
  return value.split(path.sep).join('/');
}

function walkFiles(workspace) {
  const rows = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = normalizedRelative(path.relative(workspace, absolute));
      const stats = fs.lstatSync(absolute);
      if (stats.isSymbolicLink())
        throw new Error(`fixture workspace contains a symlink: ${relative}`);
      if (stats.isDirectory()) walk(absolute);
      else if (stats.isFile())
        rows.push({
          path: relative,
          bytes: stats.size,
          root: root(fs.readFileSync(absolute)),
        });
      else throw new Error(`unsupported fixture entry: ${relative}`);
    }
  }
  walk(workspace);
  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

function expectedTree() {
  return Object.entries(INCIDENT_BOARD_FIXTURE.files)
    .map(([relative, content]) => ({
      path: relative,
      bytes: Buffer.byteLength(content),
      root: root(content),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout || 120_000,
  });
  return {
    command: [command, ...args],
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function visibleSuite(workspace) {
  return run(
    process.env.PYTHON || 'python3',
    ['-m', 'unittest', 'discover', '-s', 'tests', '-v'],
    { cwd: workspace },
  );
}

function hiddenSuite(workspace) {
  const oracleDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'incident-board-hidden-oracle.'),
  );
  const oraclePath = path.join(oracleDirectory, 'hidden_oracle.py');
  fs.writeFileSync(
    oraclePath,
    `import tempfile
import unittest
from pathlib import Path

from incident_board.errors import CompletionRejected
from incident_board.events import Event
from incident_board.replay import replay
from incident_board.service import IncidentBoard


class HiddenLeaseReplayOracle(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.board = IncidentBoard(Path(self.temporary.name) / "events.jsonl")
        self.board.open(
            incident_id="inc-hidden",
            title="Hidden retry boundary",
            severity="critical",
            at="2026-01-01T00:00:00Z",
            command_id="cmd-hidden-open",
        )
        self.board.lease(
            incident_id="inc-hidden",
            lease_id="lease-hidden-one",
            worker_id="worker-hidden-one",
            ttl_seconds=10,
            at="2026-01-01T00:00:00Z",
            command_id="cmd-hidden-lease-one",
        )

    def test_successor_lease_revokes_expired_predecessor(self):
        self.board.lease(
            incident_id="inc-hidden",
            lease_id="lease-hidden-two",
            worker_id="worker-hidden-two",
            ttl_seconds=20,
            at="2026-01-01T00:00:11Z",
            command_id="cmd-hidden-lease-two",
        )
        with self.assertRaises(CompletionRejected):
            self.board.complete(
                incident_id="inc-hidden",
                lease_id="lease-hidden-one",
                completion_id="done-hidden-stale",
                result="stale result",
                at="2026-01-01T00:00:12Z",
                command_id="cmd-hidden-stale",
            )
        self.board.complete(
            incident_id="inc-hidden",
            lease_id="lease-hidden-two",
            completion_id="done-hidden-current",
            result="current result",
            at="2026-01-01T00:00:12Z",
            command_id="cmd-hidden-current",
        )
        self.assertEqual(self.board.summary()["completed"], 1)

    def test_distinct_retry_after_completion_is_idempotent(self):
        self.board.complete(
            incident_id="inc-hidden",
            lease_id="lease-hidden-one",
            completion_id="done-hidden-one",
            result="first result",
            at="2026-01-01T00:00:05Z",
            command_id="cmd-hidden-complete-one",
        )
        self.assertIsNone(
            self.board.complete(
                incident_id="inc-hidden",
                lease_id="lease-hidden-one",
                completion_id="done-hidden-two",
                result="retry result",
                at="2026-01-01T00:00:06Z",
                command_id="cmd-hidden-complete-two",
            )
        )
        self.assertEqual(len(self.board.store.read()), 3)

    def test_three_historical_completions_count_once(self):
        self.board.complete(
            incident_id="inc-hidden",
            lease_id="lease-hidden-one",
            completion_id="done-hidden-one",
            result="first result",
            at="2026-01-01T00:00:05Z",
            command_id="cmd-hidden-complete-one",
        )
        source = self.board.store.read()[-1].as_dict()
        for sequence, suffix in ((4, "two"), (5, "three")):
            duplicate = {
                **source,
                "event_id": f"evt-hidden-{suffix}",
                "sequence": sequence,
                "data": {
                    **source["data"],
                    "completion_id": f"done-hidden-{suffix}",
                    "result": f"{suffix} result",
                },
            }
            self.board.store.append(Event.from_dict(duplicate))
        live = self.board.summary()
        restarted = self.board.summary(restarted=True)
        self.assertEqual(live["completed"], 1)
        self.assertEqual(restarted["completed"], 1)
        self.assertEqual(live, restarted)
        incident = replay(self.board.store.read()).require_incident("inc-hidden")
        self.assertEqual(incident.result, "first result")


if __name__ == "__main__":
    unittest.main(verbosity=2)
`,
  );
  try {
    return run(process.env.PYTHON || 'python3', [oraclePath], {
      cwd: oracleDirectory,
      env: {
        PYTHONPATH: [workspace, process.env.PYTHONPATH]
          .filter(Boolean)
          .join(path.delimiter),
      },
    });
  } finally {
    fs.rmSync(oracleDirectory, { recursive: true, force: true });
  }
}

function diffTrees(initial, current) {
  const initialMap = new Map(initial.map((row) => [row.path, row.root]));
  const currentMap = new Map(current.map((row) => [row.path, row.root]));
  return [...new Set([...initialMap.keys(), ...currentMap.keys()])]
    .filter((relative) => initialMap.get(relative) !== currentMap.get(relative))
    .sort();
}

export function materializeIncidentBoardFixture(workspace) {
  if (fs.existsSync(workspace) && fs.readdirSync(workspace).length > 0)
    throw new Error('fixture workspace must be new or empty');
  fs.mkdirSync(workspace, { recursive: true });
  for (const [relative, content] of Object.entries(
    INCIDENT_BOARD_FIXTURE.files,
  )) {
    const target = path.resolve(workspace, relative);
    if (!target.startsWith(`${path.resolve(workspace)}${path.sep}`))
      throw new Error(`fixture path escapes workspace: ${relative}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return walkFiles(workspace);
}

export function applyIncidentBoardReferenceRepair(workspace) {
  for (const [relative, content] of Object.entries(
    INCIDENT_BOARD_REFERENCE_REPAIR,
  ))
    fs.writeFileSync(path.join(workspace, relative), content);
}

export function verifyIncidentBoardWorkspace(
  workspace,
  {
    expectedInitialTree = expectedTree(),
    requireModification = true,
    runHidden = true,
  } = {},
) {
  const before = expectedInitialTree;
  const current = walkFiles(workspace);
  const changedPaths = diffTrees(before, current);
  const allowed = new Set(INCIDENT_BOARD_FIXTURE.warrants.agentB.writablePaths);
  const scopeViolations = changedPaths.filter(
    (relative) => !allowed.has(relative),
  );
  const visible = visibleSuite(workspace);
  const hidden = runHidden ? hiddenSuite(workspace) : null;
  const passed =
    scopeViolations.length === 0 &&
    (!requireModification || changedPaths.length > 0) &&
    visible.status === 0 &&
    (!hidden || hidden.status === 0);
  const report = {
    schema: REPORT_SCHEMA,
    fixtureId: INCIDENT_BOARD_FIXTURE.id,
    passed,
    authoritative: true,
    verifierLocation: 'outside-agent-workspace',
    workspaceTreeRoot: root(JSON.stringify(current)),
    initialTreeRoot: root(JSON.stringify(before)),
    changedPaths,
    allowedWritablePaths: [...allowed].sort(),
    scopeViolations,
    checks: {
      modificationRequired: !requireModification || changedPaths.length > 0,
      scope: scopeViolations.length === 0,
      visible: {
        passed: visible.status === 0,
        status: visible.status,
        signal: visible.signal,
        error: visible.error,
        outputRoot: root(`${visible.stdout}\n${visible.stderr}`),
      },
      hidden: hidden
        ? {
            passed: hidden.status === 0,
            status: hidden.status,
            signal: hidden.signal,
            error: hidden.error,
            outputRoot: root(`${hidden.stdout}\n${hidden.stderr}`),
          }
        : null,
    },
  };
  report.reportRoot = root(JSON.stringify(report));
  if (!ROOT_PATTERN.test(report.reportRoot))
    throw new Error('oracle report root is invalid');
  return report;
}

export function qualifySeededIncidentBoardFixture() {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), 'incident-board-seeded.'),
  );
  try {
    materializeIncidentBoardFixture(workspace);
    const visible = visibleSuite(workspace);
    const combined = `${visible.stdout}\n${visible.stderr}`;
    const expectedFailures = [
      'test_expired_lease_cannot_complete',
      'test_legacy_duplicate_log_has_stable_restart_summary',
    ];
    return {
      schema: 'kungfu.agent-repository-work.seeded-defect-report/v1',
      passed:
        visible.status !== 0 &&
        expectedFailures.every((name) => combined.includes(name)),
      expectedFailures,
      status: visible.status,
      outputRoot: root(combined),
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

export function qualifyReferenceIncidentBoardRepair() {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), 'incident-board-reference.'),
  );
  try {
    const initialTree = materializeIncidentBoardFixture(workspace);
    applyIncidentBoardReferenceRepair(workspace);
    return verifyIncidentBoardWorkspace(workspace, {
      expectedInitialTree: initialTree,
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}
