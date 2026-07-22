// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELECTOR = JSON.parse(
  fs.readFileSync(path.join(ROOT, '.xinfa', 'product-documentation-pack.json')),
);
const ATLAS = path.join(
  ROOT,
  '.xinfa',
  'baselines',
  'sha256',
  SELECTOR.atlasRoot.slice('sha256:'.length),
);

function probe(atlas, expression = 'verify(root)') {
  const program = `
import json
from kungfu.agent import documentation
root = ${JSON.stringify(atlas)}
value = documentation.${expression}
print(json.dumps(value, sort_keys=True))
`;
  const result = spawnSync('python3', ['-c', program], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONPATH: path.join(ROOT, 'framework', 'core', 'src', 'python'),
      KUNGFU_DOCUMENTATION_ATLAS: atlas,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('installed reader verifies and reads the exact offline Xinfa pack', () => {
  const receipt = probe(ATLAS);
  assert.equal(receipt.valid, true);
  assert.equal(receipt.readOnly, true);
  assert.equal(receipt.atlasRoot, SELECTOR.atlasRoot);
  assert.equal(receipt.packRoot, SELECTOR.contextPackRoot);
  const catalog = probe(ATLAS, 'catalog(root)');
  assert.ok(catalog.entries.length > 300);
  assert.equal(catalog.roots.atlasRoot, receipt.atlasRoot);
  const human = probe(ATLAS, "projection('human', root)");
  const agent = probe(ATLAS, "projection('agent', root)");
  assert.equal(human.roots.atlasRoot, receipt.atlasRoot);
  assert.equal(agent.roots.atlasRoot, receipt.atlasRoot);
});

test('tampered product bytes fail closed before any read', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-doc-pack-'));
  try {
    fs.cpSync(ATLAS, temporary, { recursive: true });
    fs.appendFileSync(path.join(temporary, 'views', 'agent.json'), ' ');
    const receipt = probe(temporary);
    assert.equal(receipt.valid, false);
    assert.ok(
      receipt.diagnostics.some((item) => item.code === 'artifact-root'),
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('freeze assembly stages the selected verified Atlas into the product', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'framework', 'core', '.gyp', 'run-freeze.js'),
    'utf8',
  );
  assert.match(source, /documentationAtlasSource\(\)/);
  assert.match(source, /product-documentation-pack\.json/);
  assert.match(source, /agent', 'documentation'/);
});
