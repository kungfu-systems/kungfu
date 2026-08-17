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
  assemblySelector,
  copyFirstPartyProfile,
  copyWorkProfileConformance,
  documentationAtlasSource,
  firstPartyProfileFilter,
  requireAssemblySelector,
} = require(path.join(ROOT, 'framework', 'core', '.gyp', 'run-freeze.js'));
const SELECTOR = JSON.parse(
  fs.readFileSync(path.join(ROOT, '.xinfa', 'product-documentation-pack.json')),
);
const ATLAS = path.join(
  process.env.KUNGFU_DOCUMENTATION_ATLAS ||
    path.join(
      ROOT,
      '.xinfa',
      'baselines',
      'sha256',
      SELECTOR.atlasRoot.slice('sha256:'.length),
    ),
);
if (!process.env.KUNGFU_DOCUMENTATION_ATLAS_BUNDLE)
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
  assert.match(receipt.bundleRoot, /^sha256:[0-9a-f]{64}$/);
  const bundle = probe(ATLAS, 'bundle(root)');
  assert.equal(bundle.valid, true);
  assert.equal(bundle.bundleRoot, receipt.bundleRoot);
  assert.equal(bundle.routes.incompleteRoutes, 0);
  assert.equal(bundle.classification.unknown, 0);
  const catalog = probe(ATLAS, 'catalog(root)');
  assert.ok(catalog.entries.length > 300);
  assert.equal(catalog.roots.atlasRoot, receipt.atlasRoot);
  const human = probe(ATLAS, "projection('human', root)");
  const agent = probe(ATLAS, "projection('agent', root)");
  assert.equal(human.roots.atlasRoot, receipt.atlasRoot);
  assert.equal(agent.roots.atlasRoot, receipt.atlasRoot);
});

test('tampered portable classification fails closed', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-portable-pack-'),
  );
  try {
    fs.cpSync(ATLAS, temporary, { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, '.xinfa', 'product-atlas-bundle.json'),
      path.join(temporary, 'bundle.json'),
    );
    const classification = JSON.parse(
      zlib.gunzipSync(
        fs.readFileSync(
          path.join(ROOT, '.xinfa', 'portable-atlas-classification.json.gz'),
        ),
      ),
    );
    classification.unknown = 1;
    const classificationPath = path.join(temporary, 'classification.json.gz');
    if (fs.existsSync(classificationPath))
      fs.chmodSync(classificationPath, 0o644);
    fs.writeFileSync(
      classificationPath,
      zlib.gzipSync(Buffer.from(`${JSON.stringify(classification)}\n`)),
    );
    const receipt = probe(temporary);
    assert.equal(receipt.valid, false);
    assert.ok(
      receipt.diagnostics.some(
        (item) => item.code === 'portable-classification-root',
      ),
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('tampered product bytes fail closed before any read', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-doc-pack-'));
  try {
    fs.cpSync(ATLAS, temporary, { recursive: true });
    const receiptPath = path.join(temporary, 'receipt.json');
    fs.chmodSync(receiptPath, 0o644);
    const tampered = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    tampered.verdict = 'tampered';
    fs.writeFileSync(receiptPath, `${JSON.stringify(tampered)}\n`);
    const receipt = probe(temporary);
    assert.equal(receipt.valid, false);
    assert.ok(receipt.diagnostics.some((item) => item.code === 'receipt-root'));
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
  assert.match(source, /documentationDestination/);
  assert.match(source, /portableAtlasBundleSource\(\)/);
  assert.match(source, /classification\.json\.gz/);
});

test('freeze assembly stages the complete Work conformance checker closure', (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-work-conformance-pack-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  copyWorkProfileConformance(temporary, ROOT);

  assert.equal(
    fs.existsSync(path.join(temporary, 'work-profile-conformance.mjs')),
    true,
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(temporary, 'authority-manifest.json'), 'utf8'),
  );
  for (const coordinate of manifest.files) {
    const installed = path.join(temporary, 'authority', coordinate.path);
    assert.equal(fs.existsSync(installed), true, coordinate.path);
    assert.equal(
      `sha256:${crypto
        .createHash('sha256')
        .update(fs.readFileSync(installed))
        .digest('hex')}`,
      coordinate.sha256,
      coordinate.path,
    );
  }
});

test('freeze assembly accepts only the assembled product selector', () => {
  assert.equal(assemblySelector(''), 'assemble');
  assert.equal(requireAssemblySelector('assemble'), 'assemble');
  for (const retired of ['nuitka', ['py', 'installer'].join('')]) {
    assert.throws(
      () => requireAssemblySelector(retired),
      /retired product packager selector rejected/u,
    );
  }
});

test('freeze replaces transient workspace links with stable Suite members', (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-mission-profile-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const extensions = path.join(temporary, 'extensions');
  const source = path.join(extensions, 'source');
  const member = path.join(extensions, 'member');
  const destination = path.join(temporary, 'installed');
  fs.mkdirSync(path.join(source, 'node_modules', '@kungfu-tech'), {
    recursive: true,
  });
  fs.mkdirSync(member);
  fs.writeFileSync(
    path.join(source, 'package.json'),
    `${JSON.stringify({
      name: '@test/suite',
      version: '1.0.0',
    })}\n`,
  );
  fs.writeFileSync(
    path.join(source, 'kungfu.kfx.json'),
    `${JSON.stringify({
      schema: 'kungfu.kfx.manifest/v1',
      name: '@test/suite',
      version: '1.0.0',
      kungfuConfig: {
        key: 'suite',
        suite: { members: ['member'] },
      },
    })}\n`,
  );
  fs.writeFileSync(
    path.join(member, 'package.json'),
    `${JSON.stringify({ name: '@test/member', version: '1.0.0' })}\n`,
  );
  fs.writeFileSync(
    path.join(member, 'kungfu.kfx.json'),
    `${JSON.stringify({
      schema: 'kungfu.kfx.manifest/v1',
      name: '@test/member',
      version: '1.0.0',
      kungfuConfig: { key: 'member' },
    })}\n`,
  );
  fs.symlinkSync(
    member,
    path.join(source, 'node_modules', '@kungfu-tech', 'member'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  copyFirstPartyProfile(source, destination);
  assert.equal(fs.existsSync(path.join(destination, 'node_modules')), false);
  const installedMember = path.join(destination, 'members', 'member');
  assert.equal(fs.lstatSync(installedMember).isSymbolicLink(), false);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(installedMember, 'kungfu.kfx.json'), 'utf8'),
    ).kungfuConfig.key,
    'member',
  );
  assert.equal(
    firstPartyProfileFilter(
      path.join(
        ROOT,
        'extensions',
        'work-control',
        'node_modules',
        '@kungfu-tech',
        'kfx-view-work-dashboard',
      ),
    ),
    false,
  );
  assert.equal(
    firstPartyProfileFilter(
      path.join(
        ROOT,
        'extensions',
        'work-control',
        'node_modules',
        '@kungfu-tech',
        'kfx-view-work-dashboard',
        'node_modules',
        '@kungfu-tech',
        'core',
      ),
    ),
    false,
  );
  assert.equal(
    firstPartyProfileFilter(
      path.join(
        ROOT,
        'extensions',
        'work-control',
        'work-control-actions',
        '__pycache__',
        'adapter.cpython-313.pyc',
      ),
    ),
    false,
  );
  assert.equal(
    firstPartyProfileFilter(
      path.join(
        ROOT,
        'extensions',
        'work-control',
        'work-control-actions',
        'adapter.py',
      ),
    ),
    true,
  );
});

test('freeze closes a product-declared Profile when pnpm dependencies are hoisted', (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-hoisted-profile-'),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const extensions = path.join(temporary, 'extensions');
  const source = path.join(extensions, 'suite');
  const nestedMember = path.join(source, 'nested-member');
  const hoistedMember = path.join(extensions, 'hoisted-member');
  const destination = path.join(temporary, 'installed', 'suite');
  fs.mkdirSync(nestedMember, { recursive: true });
  fs.mkdirSync(hoistedMember, { recursive: true });
  fs.writeFileSync(
    path.join(source, 'package.json'),
    `${JSON.stringify({
      name: '@test/suite',
      version: '1.0.0',
    })}\n`,
  );
  fs.writeFileSync(
    path.join(source, 'kungfu.kfx.json'),
    `${JSON.stringify({
      schema: 'kungfu.kfx.manifest/v1',
      name: '@test/suite',
      version: '1.0.0',
      kungfuConfig: {
        key: 'suite',
        suite: { members: ['nested-member', 'hoisted-member'] },
      },
    })}\n`,
  );
  fs.writeFileSync(
    path.join(nestedMember, 'package.json'),
    `${JSON.stringify({ name: '@test/nested-member', version: '1.0.0' })}\n`,
  );
  fs.writeFileSync(
    path.join(hoistedMember, 'package.json'),
    `${JSON.stringify({ name: '@test/hoisted-member', version: '1.0.0' })}\n`,
  );
  fs.writeFileSync(
    path.join(nestedMember, 'kungfu.kfx.json'),
    `${JSON.stringify({
      schema: 'kungfu.kfx.manifest/v1',
      name: '@test/nested-member',
      version: '1.0.0',
      kungfuConfig: { key: 'nested-member' },
    })}\n`,
  );
  fs.writeFileSync(
    path.join(hoistedMember, 'kungfu.kfx.json'),
    `${JSON.stringify({
      schema: 'kungfu.kfx.manifest/v1',
      name: '@test/hoisted-member',
      version: '1.0.0',
      kungfuConfig: { key: 'hoisted-member' },
    })}\n`,
  );

  copyFirstPartyProfile(source, destination);

  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(destination, 'members', 'hoisted-member', 'kungfu.kfx.json'),
        'utf8',
      ),
    ).kungfuConfig.key,
    'hoisted-member',
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
        originTree: '2'.repeat(40),
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
