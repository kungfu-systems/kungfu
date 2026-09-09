#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const readJson = (relative) =>
  JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const fixture = readJson(
  'tests/fixtures/runtime-surface-integration/cases.json',
);
const contract = readJson(
  'framework/core/runtime/kungfu-runtime.contract.json',
);
const definitions = contract.valueSchemaBundle.$defs;

const typeProgram = ts.createProgram(
  [path.join(root, 'framework/core/tests/runtime-product-status-types.ts')],
  {
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    noEmit: true,
    skipLibCheck: false,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  },
);
const typeDiagnostics = ts.getPreEmitDiagnostics(typeProgram);
assert.equal(
  typeDiagnostics.length,
  0,
  ts.formatDiagnosticsWithColorAndContext(typeDiagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
  }),
);

assert.equal(
  definitions.runtimeProductStatus.properties.schema.const,
  fixture.productStatusSchema,
);

for (const relative of Object.values(fixture.surfaces)) {
  assert.ok(
    fs.existsSync(path.join(root, relative)),
    `missing surface: ${relative}`,
  );
}

for (const relative of [
  fixture.surfaces.python,
  fixture.surfaces.cliOwner,
  fixture.surfaces.node,
  fixture.surfaces.libkungfuTypes,
  fixture.surfaces.gui,
  fixture.surfaces.kfx,
]) {
  assert.match(
    read(relative),
    /kungfu\.runtime\.product-status\/v1|RuntimeProductStatus|product_status|payload\.get\("product"\)/,
    `surface does not expose the shared product status: ${relative}`,
  );
}

const cliFacade = read(fixture.surfaces.cliFacade);
assert.match(
  cliFacade,
  /from kungfu\.cli\.commands\._runtime\.base import \(/,
  'stable CLI facade does not re-export the runtime command owner',
);
assert.match(
  cliFacade,
  /_plain_status as _plain_status/,
  'stable CLI facade does not preserve the shared product-status renderer',
);

const guiMain = read('framework/gui/src/main/index.ts');
for (const command of fixture.ordinaryLifecycleCommands) {
  assert.doesNotMatch(
    guiMain,
    new RegExp(`\\['runtime', '${command}'`),
    `GUI main bypasses the shared runtime surface for ${command}`,
  );
}
assert.match(guiMain, /Advanced Runtime Diagnostics/);
assert.match(guiMain, /stopRuntimeForRecovery/);

const guiRecovery = read('framework/gui/src/main/runtime-recovery.ts');
assert.match(guiRecovery, /shared public CLI/);
assert.match(
  guiRecovery,
  /\[\.\.\.\(options\.argsPrefix \?\? \[\]\), 'runtime', 'stop'\]/,
);
for (const command of fixture.ordinaryLifecycleCommands.filter(
  (item) => item !== 'stop',
)) {
  assert.doesNotMatch(
    guiRecovery,
    new RegExp(`\\['runtime', '${command}'`),
    `runtime recovery unexpectedly owns ${command}`,
  );
}

const ordinaryCopies = [read(fixture.surfaces.gui), read(fixture.surfaces.tui)];
for (const message of fixture.forbiddenOrdinaryMessages) {
  for (const source of ordinaryCopies) {
    assert.equal(
      source.toLowerCase().includes(message.toLowerCase()),
      false,
      `ordinary surface exposes process-management copy: ${message}`,
    );
  }
}

const operations = new Set(
  contract.operationRegistry.operations.map((operation) => operation.id),
);
const actionRegistry = readJson(
  'extensions/work-control/actions/registry.json',
);
for (const action of actionRegistry.actions) {
  if (action.runtimeOperation) {
    assert.ok(
      operations.has(action.runtimeOperation),
      `unregistered KFX runtime operation: ${action.runtimeOperation}`,
    );
  }
}

console.log(
  `runtime surface parity passed: ${Object.keys(fixture.surfaces).length} surfaces, ${actionRegistry.actions.length} KFX actions`,
);
