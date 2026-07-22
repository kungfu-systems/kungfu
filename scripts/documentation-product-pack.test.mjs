// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { documentationAtlasSource } = require(
  path.join(ROOT, 'framework', 'core', '.gyp', 'run-freeze.js'),
);
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

test('freeze restores an ignored product Atlas body from exact witnessed Git history', (t) => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-doc-history-'),
  );
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const runGit = (...args) => {
    const result = spawnSync('git', args, {
      cwd: repository,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  };
  runGit('init', '-q');
  runGit('config', 'user.name', 'Documentation Test');
  runGit('config', 'user.email', 'documentation-test@example.invalid');

  const atlas = Buffer.from(
    `${JSON.stringify({
      atlas_root: SELECTOR.atlasRoot,
      roots: { context_pack: SELECTOR.contextPackRoot },
      visibility: 'public',
    })}\n`,
  );
  const relative = `.xinfa/baselines/sha256/${SELECTOR.atlasRoot.slice(7)}`;
  const baseline = path.join(repository, relative);
  fs.mkdirSync(baseline, { recursive: true });
  fs.writeFileSync(path.join(baseline, 'atlas.json'), atlas);
  fs.writeFileSync(
    path.join(baseline, 'manifest.json'),
    `${JSON.stringify({
      artifacts: [
        {
          content_root: `sha256:${crypto.createHash('sha256').update(atlas).digest('hex')}`,
          path: 'atlas.json',
          size: atlas.length,
        },
      ],
    })}\n`,
  );
  runGit('add', '.');
  runGit('commit', '-qm', 'test: retain product documentation material');
  const materialCommit = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).stdout.trim();
  fs.writeFileSync(
    path.join(repository, '.xinfa', 'product-documentation-pack.json'),
    `${JSON.stringify({
      ...SELECTOR,
      materialSource: { kind: 'git-history', commit: materialCommit },
    })}\n`,
  );
  fs.rmSync(path.join(baseline, 'atlas.json'));
  runGit('add', '.');
  runGit('commit', '-qm', 'test: publish witness only');

  const checkout = path.join(repository, 'shallow');
  runGit('clone', '--depth=1', `file://${repository}`, checkout);
  const restoredBaseline = path.join(checkout, relative);
  assert.equal(documentationAtlasSource(checkout), restoredBaseline);
  assert.deepEqual(
    fs.readFileSync(path.join(restoredBaseline, 'atlas.json')),
    atlas,
  );
  fs.appendFileSync(path.join(restoredBaseline, 'atlas.json'), ' ');
  assert.throws(
    () => documentationAtlasSource(checkout),
    /material differs from its tracked witness/,
  );
});
