// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  cliArchiveLayout,
  stageCoreRuntimeForCli,
  verifyDarwinCliExecutableLayout,
} from './dist.mjs';

test('macOS CLI executable qualification is architecture-exact and signed', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS executable qualification');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-macos-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const layout = cliArchiveLayout('darwin');
  const files = [
    layout.runtimeEntrypoint,
    layout.pythonEntrypoint,
    'tui/node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
    'tui/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  ];
  for (const relative of files) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture');
    fs.chmodSync(file, 0o755);
  }
  const calls = [];
  const result = verifyDarwinCliExecutableLayout(root, (command, args) => {
    calls.push([command, ...args]);
    return {
      status: 0,
      stdout: command === 'file' ? 'Mach-O 64-bit arm64\n' : '',
      stderr: '',
    };
  });

  assert.equal(result.architectureExact, true);
  assert.equal(result.codesignStrict, true);
  assert.equal(calls.filter(([command]) => command === 'file').length, 4);
  assert.equal(calls.filter(([command]) => command === 'codesign').length, 4);
});

test('CLI staging copies only the declared Work Design package closure', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-work-design-'));
  try {
    const source = path.join(parent, 'source');
    const target = path.join(parent, 'target');
    const workDesign =
      'python/lib/python3.13/site-packages/kungfu/work_design_runtime';
    const spec = 'node_modules/@kungfu-tech/spec';
    const specFiles = ['package.json', 'format/project-cut-canonical-json.mjs'];
    const closure = {
      schema: 'kungfu.work-design.runtime-closure/v1',
      packageDependencies: [{ name: '@kungfu-tech/spec', files: specFiles }],
    };
    for (const [relative, content] of [
      ['kungfu', 'runtime'],
      ['bin/python3', 'interpreter'],
      [
        path.join(workDesign, 'work-design-runtime.json'),
        JSON.stringify(closure),
      ],
      [
        path.join(workDesign, spec, specFiles[0]),
        '{"name":"@kungfu-tech/spec"}',
      ],
      [
        path.join(workDesign, spec, specFiles[1]),
        'export const canonical = true;',
      ],
      ['node_modules/unrelated/index.js', 'development-only'],
      [path.join(workDesign, 'node_modules/rogue/index.js'), 'undeclared'],
    ]) {
      const file = path.join(source, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${content}\n`);
    }
    stageCoreRuntimeForCli(source, target);

    const stagedWorkDesign = path.join(target, workDesign);
    for (const relative of specFiles) {
      assert.equal(
        fs.existsSync(path.join(stagedWorkDesign, spec, relative)),
        true,
      );
    }
    assert.equal(fs.existsSync(path.join(target, 'node_modules')), false);
    assert.equal(
      fs.existsSync(path.join(stagedWorkDesign, 'node_modules/rogue')),
      false,
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
