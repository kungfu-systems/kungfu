// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  JsonFileWorkConsoleRegistryStore,
  WorkConsoleRegistry,
  normalizeWorkConsoleRegistry,
} from '../framework/agent-session/src/work-console-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const contract = readJson(
  'framework/core/data-protection/work-agent-history.contract.json',
);
const ROOT_VALUE = `sha256:${'a'.repeat(64)}`;

function workRef() {
  return {
    schema: 'kungfu.work-ref/v1',
    workspaceId: 'project:history-fixture',
    profileId: 'work-control',
    profileRoot: ROOT_VALUE,
    entityType: 'assignment',
    entityId: 'history-fixture',
    initiativeId: 'history-initiative',
    entityRoot: `sha256:${'b'.repeat(64)}`,
    purpose: 'qualify exact history continuity',
    systemTimeCut: '2026-08-01T00:00:00Z',
  };
}

test('all supported entrypoints route to one semantic authority and projection', () => {
  assert.equal(
    contract.schema,
    'kungfu.work-agent-history-continuity.contract/v1',
  );
  assert.deepEqual(contract.entrypoints.map((entry) => entry.id).sort(), [
    'cli',
    'gui',
    'kfd',
    'managed-run',
    'native-agent-ui',
    'skill-envelope',
    'tui',
  ]);
  assert.deepEqual(
    new Set(contract.entrypoints.map((entry) => entry.semanticRoute)),
    new Set(['profile-kfd-action-episode']),
  );
  assert.equal(contract.authority.kind, 'projection-and-routing-contract');
  assert.equal(
    contract.canonicalProjection.activityRules.processExitSettlesWork,
    false,
  );
  assert.equal(
    contract.canonicalProjection.activityRules.semanticAdmissionReceiptRoot,
    null,
  );
});

test('managed and native Agent activity shares the Core projection contract', () => {
  const runner = read('framework/core/src/python/kungfu/agent/run_agent.py');
  const resources = read('framework/core/src/python/kungfu/agent/resources.py');
  assert.match(runner, /def agent_activity_history_projection\(/u);
  assert.match(runner, /agent_resources\.agent_activity_history_projection\(/u);
  assert.match(
    resources,
    /"schema": "kungfu\.work-agent-history\.projection\/v1"/u,
  );
  assert.match(resources, /"state": "session-activity-only"/u);
  assert.match(resources, /"workRefRoot": canonical_root\(work_ref\)/u);
  assert.match(resources, /"semanticAdmissionReceiptRoot": None/u);
  assert.match(resources, /"processExitSettlesWork": False/u);
  assert.match(resources, /"selfReportSettlesWork": False/u);
  assert.match(resources, /"nextAction": "independent-assessment-required"/u);
  assert.equal(
    contract.canonicalProjection.schema,
    'kungfu.work-agent-history.projection/v1',
  );
});

test('WorkConsole v1 readback preserves exact Work roots but remains observer-only', () => {
  const original = workRef();
  const migrated = normalizeWorkConsoleRegistry({
    schema: 'kungfu.work-console-registry/v1',
    workspaceId: original.workspaceId,
    consoles: [
      {
        consoleId: 'work:work-control:assignment:history-fixture',
        workspaceId: original.workspaceId,
        bindingKind: 'work',
        workRef: original,
        runtimeProfileId: 'codex',
        backend: 'direct',
        attempts: [
          {
            attemptId: 'attempt:legacy',
            provider: 'codex',
            status: 'exited',
            startedAt: 1,
            endedAt: 2,
            receipts: [],
            plans: [],
            transcript: 'must-not-survive',
          },
        ],
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  });
  const attempt = migrated.consoles[0].attempts[0];
  assert.deepEqual(migrated.consoles[0].binding.workRef, original);
  assert.equal(attempt.historyProtection.state, 'session-activity-only');
  assert.equal(attempt.historyProtection.semanticAdmissionReceiptRoot, null);
  assert.equal(attempt.historyProtection.processExitSettlesWork, false);
  assert.equal('transcript' in attempt, false);
});

test('registry deletion loses convenience only and cannot mutate owner history', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-work-history-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const registryPath = path.join(home, 'runtime', 'work-consoles.json');
  const ownerPath = path.join(home, 'owner-history.json');
  const ownerHistory = {
    schema: 'synthetic.owner-history/v1',
    workRef: workRef(),
    ownerReceiptRoot: `sha256:${'c'.repeat(64)}`,
  };
  fs.writeFileSync(ownerPath, `${JSON.stringify(ownerHistory)}\n`, {
    mode: 0o600,
  });
  const store = new JsonFileWorkConsoleRegistryStore(registryPath);
  const registry = new WorkConsoleRegistry({ store, now: () => 1 });
  registry.recordPlan({
    workspaceId: ownerHistory.workRef.workspaceId,
    workConsoleId: 'work:work-control:assignment:history-fixture',
    binding: { kind: 'work', workRef: ownerHistory.workRef },
    runtimeProfileId: 'codex',
    backend: 'direct',
    sessionAttemptId: 'attempt:disposable',
    provider: 'codex',
    providerVersion: 'fixture',
    operation: 'start',
    root: ROOT_VALUE,
    effects: ['start provider'],
    rollback: 'end attempt',
  });
  fs.rmSync(registryPath);
  const reopened = new WorkConsoleRegistry({ store });
  assert.deepEqual(reopened.snapshot().consoles, []);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(ownerPath, 'utf8')),
    ownerHistory,
  );
  assert.ok(home.startsWith(os.tmpdir()));
});

test('surface copy and runtime reports expose the activity versus history boundary', () => {
  const sources = {
    cli: read('framework/core/src/python/kungfu/cli/commands/run.py'),
    tui: read('framework/tui/src/work-window/project-work-session-view.tsx'),
    gui: read('framework/kfx/src/project-work-run.tsx'),
    guiEntrypoint: read('framework/gui/src/renderer/src/main.tsx'),
    tuiEntrypoint: read('framework/tui/src/main.tsx'),
    runner: read('framework/core/src/python/kungfu/agent/run_agent.py'),
    session: read('framework/agent-session/kungfu-agent-session.contract.json'),
    product: read('product/contracts/project-work-agent.contract.json'),
  };
  assert.match(
    sources.cli,
    /protected Work history begins only with an accepted domain receipt/u,
  );
  assert.match(
    sources.cli,
    /History: session activity only; no semantic admission receipt/u,
  );
  assert.match(sources.tui, /Agent session activity is retained/u);
  assert.match(
    sources.gui,
    /Agent session activity is not protected Work history/u,
  );
  assert.match(sources.guiEntrypoint, /ProjectWorkControlView/u);
  assert.match(sources.tuiEntrypoint, /ProjectWorkHost/u);
  assert.match(
    sources.runner,
    /"historyProtection": agent_activity_history_projection\(work\)/u,
  );
  assert.match(sources.session, /"workConsoleAuthority": "observer-only"/u);
  assert.match(sources.product, /"processExitSettlesWork": false/u);
});

test('interruption, exit signals, privacy, and migration remain fail closed', () => {
  const runner = read('framework/core/src/python/kungfu/agent/run_agent.py');
  const cli = read('framework/core/src/python/kungfu/cli/commands/run.py');
  assert.match(runner, /"interrupted": result\.interrupted/u);
  assert.match(runner, /"timedOut": result\.timed_out/u);
  assert.match(runner, /"exitCode": result\.exit_code/u);
  assert.match(cli, /sys\.exit\(int\(payload\["launch"\]\["exitCode"\]\)\)/u);
  assert.equal(contract.migration.qualificationHome, 'disposable-only');
  assert.equal(contract.migration.realUserHomeMutation, false);
  assert.equal(contract.migration.inPlaceReinterpretation, false);
  assert.equal(contract.workConsoleBoundary.transcriptAuthority, false);
  for (const excluded of [
    'credentials',
    'hidden reasoning',
    'full transcripts',
    'provider-private session stores',
  ]) {
    assert.ok(contract.privacy.excluded.includes(excluded));
  }
  assert.deepEqual([...contract.qualification.requiredSurfaces].sort(), [
    'api',
    'cli',
    'gui',
    'interruption',
    'kfd',
    'managed-run',
    'migration',
    'native-run',
    'source',
    'tui',
  ]);
});
