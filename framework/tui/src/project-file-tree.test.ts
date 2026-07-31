// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  projectFileTreeIndexAtPoint,
  projectFileTreeLabel,
  projectFileTreeParentIndex,
  readProjectFileTree,
  toggleProjectFileTreeEntry,
} from './project-file-tree/index.js';

test('Project file tree defaults to one level and expands only selected directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-project-tree-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'src', 'feature'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.mkdirSync(path.join(root, '.kungfu'));
  fs.writeFileSync(path.join(root, 'README.md'), 'not read by the tree');
  fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'not read by the tree');
  fs.writeFileSync(
    path.join(root, 'src', 'feature', 'index.ts'),
    'not read by the tree',
  );
  fs.writeFileSync(
    path.join(root, 'node_modules', 'hidden.js'),
    'must remain hidden',
  );

  const entries = readProjectFileTree(root);
  assert.deepEqual(
    entries.map((entry) => entry.relativePath),
    ['.kungfu', 'node_modules', 'src', 'README.md'],
  );
  const srcEntry = entries[2];
  assert.ok(srcEntry);
  assert.equal(projectFileTreeLabel(srcEntry), '▸ src/');

  const expanded = readProjectFileTree(root, {
    expandedPaths: toggleProjectFileTreeEntry(new Set(), srcEntry),
  });
  assert.deepEqual(
    expanded.map((entry) => entry.relativePath),
    [
      '.kungfu',
      'node_modules',
      'src',
      'src/feature',
      'src/main.ts',
      'README.md',
    ],
  );
  const expandedSrc = expanded[2];
  const expandedFeature = expanded[3];
  const expandedMain = expanded[4];
  assert.ok(expandedSrc);
  assert.ok(expandedFeature);
  assert.ok(expandedMain);
  assert.equal(projectFileTreeLabel(expandedSrc), '▾ src/');
  assert.equal(projectFileTreeLabel(expandedFeature), '  ▸ feature/');
  assert.equal(projectFileTreeLabel(expandedMain), '  · main.ts');
});

test('Project file tree never expands protected heavy directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-project-tree-'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(
    path.join(root, 'node_modules', 'hidden.js'),
    'must remain hidden',
  );
  const entries = readProjectFileTree(root, {
    expandedPaths: new Set(['node_modules']),
  });
  assert.equal(
    entries.some((entry) => entry.relativePath === 'node_modules/hidden.js'),
    false,
  );
  assert.equal(entries[0]?.expandable, false);
});

test('Project file tree resolves parent navigation and visible pointer rows', () => {
  const entries = [
    {
      relativePath: 'src',
      absolutePath: '/project/src',
      name: 'src',
      depth: 0,
      kind: 'directory' as const,
      collapsed: false,
      expandable: true,
    },
    {
      relativePath: 'src/main.ts',
      absolutePath: '/project/src/main.ts',
      name: 'main.ts',
      depth: 1,
      kind: 'file' as const,
      collapsed: false,
      expandable: false,
    },
  ];
  assert.equal(projectFileTreeParentIndex(entries, 1), 0);
  assert.equal(
    projectFileTreeIndexAtPoint({
      column: 8,
      row: 8,
      firstColumn: 2,
      lastColumn: 32,
      windowStart: 4,
      visibleCount: 3,
      topOffset: 1,
    }),
    5,
  );
  assert.equal(
    projectFileTreeIndexAtPoint({
      column: 40,
      row: 8,
      firstColumn: 2,
      lastColumn: 32,
      windowStart: 4,
      visibleCount: 3,
      topOffset: 1,
    }),
    null,
  );
});
