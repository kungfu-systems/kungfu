// SPDX-License-Identifier: Apache-2.0
// Exact, source-bound component manifest shared by the CLI and desktop forms.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function sha256Buffer(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

export function internalSymlinkTarget(root, file) {
  const target = fs.readlinkSync(file);
  if (path.isAbsolute(target)) {
    throw new Error(`release tree contains absolute symlink: ${file}`);
  }
  const rootReal = fs.realpathSync(root);
  const targetReal = fs.realpathSync(file);
  const relative = path.relative(rootReal, targetReal);
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`release tree contains escaping symlink: ${file}`);
  }
  return target;
}

export const isPythonBytecodePath = (value) =>
  /(^|\/)__pycache__(\/|$)|\.pyc$/i.test(value.replaceAll('\\', '/'));

export function sha256Tree(root, { filter = () => true } = {}) {
  const rows = [];
  const visit = (dir) => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(dir, entry.name);
      if (!filter(full, entry)) continue;
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        rows.push(
          `${path.relative(root, full).split(path.sep).join('/')}\0${sha256File(full)}`,
        );
      } else if (entry.isSymbolicLink()) {
        const target = internalSymlinkTarget(root, full);
        rows.push(
          `${path.relative(root, full).split(path.sep).join('/')}\0symlink:${target}`,
        );
      }
    }
  };
  visit(root);
  rows.sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
  );
  return sha256Buffer(`${rows.join('\n')}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function gitHead(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error('cannot resolve source commit');
  return result.stdout.trim();
}

function component(root, relativePath, kind = 'file') {
  const file = path.join(root, relativePath);
  if (!fs.existsSync(file))
    throw new Error(`compatibility input missing: ${relativePath}`);
  return {
    path: relativePath.split(path.sep).join('/'),
    sha256: kind === 'tree' ? sha256Tree(file) : sha256File(file),
  };
}

export function buildCompatibilityManifest({ root, includeGui }) {
  const packageVersion = (relativePath) =>
    readJson(path.join(root, relativePath)).version;
  const guiOut = path.join(root, 'framework', 'gui', 'out');
  const components = {
    native_contract: component(
      root,
      'framework/core/src/libkungfu/include/kungfu/api.h',
    ),
    native_build: component(
      root,
      'framework/core/dist/kungfu/kungfubuildinfo.json',
    ),
    libwasm_abi: component(
      root,
      'framework/core/src/libwasm/include/kungfu/libwasm.h',
    ),
    libwasm_contract: component(root, 'crates/libwasm/contract.json'),
    libwasm_runtime: component(
      root,
      'framework/core/dist/kungfu/libwasm',
      'tree',
    ),
    sdk_contract: component(
      root,
      'framework/storage/kungfu-storage.contract.json',
    ),
    upgrade_contract: component(
      root,
      'product/upgrade/kungfu-upgrade.contract.json',
    ),
    sdk_fixture: component(
      root,
      'tests/qualification/layers/sdk/semantic-fixture-v1.json',
    ),
    tui_bundle: component(root, 'framework/tui/dist/tui.mjs'),
    extensions: component(root, 'product/extensions', 'tree'),
  };
  if (includeGui) {
    components.gui_bundle = component(
      root,
      path.relative(root, guiOut),
      'tree',
    );
  }
  return {
    schema: 'kungfu.product.compatibility/v1',
    source_commit: gitHead(root),
    platform: `${process.platform}-${process.arch}`,
    selected_products: includeGui ? ['cli', 'gui', 'assembled'] : ['cli'],
    versions: {
      core: packageVersion('framework/core/package.json'),
      sdk: packageVersion('framework/storage/package.json'),
      tui: packageVersion('framework/tui/package.json'),
      gui: includeGui ? packageVersion('framework/gui/package.json') : null,
      product: packageVersion('product/package.json'),
    },
    components,
    qualification_contracts: {
      layer_matrix: component(
        root,
        'tests/qualification/layers/artifact-matrix.json',
      ),
      surface_fixture: component(
        root,
        'tests/qualification/layers/surfaces/semantic-fixture-v1.json',
      ),
    },
    boundary:
      'Component hashes prove one source-bound assembly. Runtime negotiation and activation use the separately welded kungfu.product-upgrade.contract/v1; this manifest does not grant live authority.',
  };
}

export function writeCompatibilityManifest({ root, output, includeGui }) {
  const manifest = buildCompatibilityManifest({ root, includeGui });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}
