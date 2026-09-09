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
  'framework/core/exit/kungfu-exit-bundle.contract.json',
);
const catalog = readJson(
  'framework/core/src/python/kungfu/agent/cli_surface.catalog.json',
);
const kfd = readJson(
  'framework/core/src/python/kungfu/agent/kfd3_api.registry.json',
);
const cli = read('framework/core/src/python/kungfu/cli/commands/exit.py');
const core = read('framework/core/src/python/kungfu/exit_bundle.py');
const history = read('framework/core/src/python/kungfu/exit_verifier.py');
const tui = read('framework/tui/src/main.tsx');
const gui = read('framework/gui/src/renderer/src/main.tsx');
const guiObserver = read('framework/gui/src/runtime-status.ts');
const guiHistory = read('framework/gui/src/renderer/src/shell-state.ts');

const expected = new Map([
  ['kungfu exit history status', ['read', 'kungfu.exit.bundle']],
  ['kungfu exit history export', ['read', 'kungfu.exit.bundle']],
  ['kungfu exit history verify', ['plan', 'kungfu.exit.verify']],
  ['kungfu exit history import', ['write', 'kungfu.exit.bundle']],
  ['kungfu exit history rebuild', ['write', 'kungfu.exit.bundle']],
]);

test('CLI and KFD expose the complete history operation family', () => {
  for (const [command, [mutation, api]] of expected) {
    const surface = catalog.surfaces.find(
      (candidate) => candidate.canonical_path === command,
    );
    assert.ok(surface, command);
    assert.equal(surface.mutation_class, mutation, command);
    assert.deepEqual(surface.kfd3_api_ids, [api], command);
  }
  const bundleApi = kfd.apis.find((api) => api.id === 'kungfu.exit.bundle');
  const verifyApi = kfd.apis.find((api) => api.id === 'kungfu.exit.verify');
  for (const command of [
    'kungfu exit history status',
    'kungfu exit history export',
    'kungfu exit history import',
    'kungfu exit history rebuild',
  ])
    assert.match(
      JSON.stringify(bundleApi),
      new RegExp(command.replaceAll(' ', '\\s+'), 'u'),
    );
  assert.match(JSON.stringify(verifyApi), /kungfu exit history verify/u);
});

test('all history verbs delegate to the existing Core authority seams', () => {
  assert.match(cli, /exit_verifier\.status/u);
  assert.match(cli, /exit_bundle\.build/u);
  assert.match(cli, /exit_verifier\.record_verified_export/u);
  assert.match(cli, /exit_verifier\.verify_(?:file|bytes)/u);
  assert.match(cli, /exit_bundle\.import_package/u);
  assert.match(cli, /exit_verifier\.rebuild_projections/u);
  assert.match(history, /memberDomainsRemainAuthoritative/u);
  assert.match(history, /observerMutation": False/u);
  assert.match(history, /authorityMutation": False/u);
  assert.doesNotMatch(history, /shutil\.copy.*projection/u);
});

test('GUI and TUI observe the same status and exact next action', () => {
  assert.match(guiObserver, /\['exit', 'history', 'status', '--json'\]/u);
  assert.match(guiObserver, /EXIT_HISTORY_STATUS_FALLBACK/u);
  assert.match(guiObserver, /kungfu exit history status --json/u);
  assert.match(guiHistory, /status\.nextActions\[0\]/u);
  assert.match(tui, /\['exit', 'history', 'status', '--json'\]/u);
  assert.match(tui, /historyStatus\.nextActions\[0\]/u);
  assert.match(tui, /EXIT_HISTORY_STATUS_FALLBACK/u);
  assert.match(tui, /kungfu exit history status --json/u);
  assert.match(tui, /History \{historyStatus\.state\}/u);
  assert.match(guiHistory, /system\.history-protection/u);
  assert.match(gui, /exitHistoryStatusItem\(historyStatus, statusCommand\)/u);
});

test('contract keeps honest status, loss, and rebuild semantics', () => {
  assert.equal(
    contract.historySurface.schema,
    'kungfu.exit-history.surface/v1',
  );
  assert.match(
    contract.historySurface.statusSemantics['contract-ready'],
    /coverage has not been evaluated/u,
  );
  assert.match(
    contract.historySurface.statusSemantics['inventory-verified'],
    /explicit loss/u,
  );
  assert.match(contract.historySurface.observerRule, /never settle Work/u);
  assert.match(contract.historySurface.rebuildRule, /local Episode and Fact/u);
});
