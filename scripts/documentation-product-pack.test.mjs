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
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const {
  copyMissionControlProfile,
  documentationAtlasSource,
  missionControlProfileFilter,
} = require(path.join(ROOT, 'framework', 'core', '.gyp', 'run-freeze.js'));
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
documentationAtlasSource(ROOT);

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

test('freeze materializes Mission Control dependency links', (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-mission-profile-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source');
  const member = path.join(temporary, 'member');
  const destination = path.join(temporary, 'installed');
  fs.mkdirSync(path.join(source, 'node_modules', '@kungfu-tech'), {
    recursive: true,
  });
  fs.mkdirSync(member);
  fs.writeFileSync(path.join(member, 'package.json'), '{}\n');
  fs.symlinkSync(
    member,
    path.join(source, 'node_modules', '@kungfu-tech', 'member'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  copyMissionControlProfile(source, destination);
  const installedMember = path.join(
    destination,
    'node_modules',
    '@kungfu-tech',
    'member',
  );
  assert.equal(fs.lstatSync(installedMember).isSymbolicLink(), false);
  assert.equal(
    fs.readFileSync(path.join(installedMember, 'package.json'), 'utf8'),
    '{}\n',
  );
  assert.equal(
    missionControlProfileFilter(
      path.join(
        ROOT,
        'extensions',
        'mission-control',
        'node_modules',
        '@kungfu-tech',
        'kfx-view-work-dashboard',
      ),
    ),
    true,
  );
  assert.equal(
    missionControlProfileFilter(
      path.join(
        ROOT,
        'extensions',
        'mission-control',
        'mission-control-actions',
        '__pycache__',
        'adapter.cpython-313.pyc',
      ),
    ),
    false,
  );
  assert.equal(
    missionControlProfileFilter(
      path.join(
        ROOT,
        'extensions',
        'mission-control',
        'mission-control-actions',
        'adapter.py',
      ),
    ),
    true,
  );
});

test('freeze restores an ignored product Atlas body from a tracked gzip bundle without Git', (t) => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-doc-history-'),
  );
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
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
  const bundleRelative = `.xinfa/material-bundles/sha256/${SELECTOR.atlasRoot.slice(7)}`;
  const bundle = path.join(repository, bundleRelative);
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(
    path.join(bundle, 'atlas.json.gz'),
    zlib.gzipSync(atlas, { level: 9 }),
  );
  fs.writeFileSync(
    path.join(repository, '.xinfa', 'product-documentation-pack.json'),
    `${JSON.stringify({
      ...SELECTOR,
      materialSource: {
        kind: 'tracked-gzip',
        originCommit: '19915bafad261d8d9357149b53ff584c9db56bcf',
        bundleRoot: bundleRelative,
      },
    })}\n`,
  );
  fs.rmSync(path.join(baseline, 'atlas.json'));
  fs.writeFileSync(
    path.join(bundle, 'atlas.json.gz'),
    zlib.gzipSync(Buffer.concat([atlas, Buffer.from(' ')]), { level: 9 }),
  );
  assert.throws(
    () => documentationAtlasSource(repository),
    /material source differs from its tracked witness/,
  );
  fs.writeFileSync(
    path.join(bundle, 'atlas.json.gz'),
    zlib.gzipSync(atlas, { level: 9 }),
  );
  const restoredBaseline = path.join(repository, relative);
  assert.equal(documentationAtlasSource(repository), restoredBaseline);
  assert.deepEqual(
    fs.readFileSync(path.join(restoredBaseline, 'atlas.json')),
    atlas,
  );
  fs.appendFileSync(path.join(restoredBaseline, 'atlas.json'), ' ');
  assert.throws(
    () => documentationAtlasSource(repository),
    /material differs from its tracked witness/,
  );
});
