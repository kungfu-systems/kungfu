// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  isMachOHeader,
  resolveMacSigningIdentity,
  resolveMacSigningIgnore,
} from './sign-macos.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');

test('preserves an explicit certificate hash for duplicate named identities', () => {
  assert.equal(
    resolveMacSigningIdentity(
      { identity: 'Developer ID Application: Example (TEAMID)' },
      { CSC_NAME: '0123456789abcdef0123456789abcdef01234567' },
    ),
    '0123456789abcdef0123456789abcdef01234567',
  );
});

test('falls back to the identity resolved by electron-builder', () => {
  assert.equal(
    resolveMacSigningIdentity(
      { identity: 'Developer ID Application: Example (TEAMID)' },
      { CSC_NAME: 'Example' },
    ),
    'Developer ID Application: Example (TEAMID)',
  );
});

test('recognizes thin and universal Mach-O headers', () => {
  for (const magic of [
    0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
    0xcafebabf, 0xbfbafeca,
  ]) {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(magic);
    assert.equal(isMachOHeader(header), true);
  }
  assert.equal(isMachOHeader(Buffer.from('data')), false);
  assert.equal(isMachOHeader(Buffer.alloc(3)), false);
});

test('skips ordinary resources without skipping native runtime code', () => {
  const code = new Set([
    '/app/runtime/pkg/native.so',
    '/app/runtime/pkg/native.dylib',
    '/app/runtime/pkg/native.node',
    '/app/runtime/kungfu',
    '/app/Frameworks/Electron Framework.framework',
  ]);
  const shouldIgnore = resolveMacSigningIgnore(undefined, (filePath) =>
    code.has(filePath),
  );

  assert.equal(shouldIgnore('/app/runtime/pkg/module.pyc'), true);
  assert.equal(shouldIgnore('C:\\app\\runtime\\pkg\\module.pyo'), true);
  assert.equal(shouldIgnore('/app/runtime/pkg/__pycache__/module.data'), true);
  assert.equal(shouldIgnore('/app/Resources/en.lproj/locale.pak'), true);
  assert.equal(shouldIgnore('/app/Resources/app/config.json'), true);
  assert.equal(shouldIgnore('/app/runtime/pkg/native.so'), false);
  assert.equal(shouldIgnore('/app/runtime/pkg/native.dylib'), false);
  assert.equal(shouldIgnore('/app/runtime/pkg/native.node'), false);
  assert.equal(shouldIgnore('/app/runtime/kungfu'), false);
  assert.equal(
    shouldIgnore('/app/Frameworks/Electron Framework.framework'),
    false,
  );
});

test('fails closed when a candidate cannot be inspected', () => {
  const shouldIgnore = resolveMacSigningIgnore(undefined, () => {
    throw new Error('unreadable');
  });
  assert.equal(shouldIgnore('/app/unreadable'), false);
});

test('preserves existing string, array, and function ignore rules', () => {
  const existingFunction = (filePath) => filePath.endsWith('.map');
  const code = () => true;

  assert.equal(
    resolveMacSigningIgnore('existing-pattern', code)('/app/existing-pattern'),
    true,
  );
  assert.equal(
    resolveMacSigningIgnore(
      ['first-pattern', 'second-pattern'],
      code,
    )('/app/second-pattern'),
    true,
  );
  assert.equal(
    resolveMacSigningIgnore(existingFunction, code)('/app/source.map'),
    true,
  );
});

test('returns one function so osx-sign does not discard the ignore option', () => {
  assert.equal(
    typeof resolveMacSigningIgnore(['existing-pattern']),
    'function',
  );
});

test('both desktop builders resolve the signing hook from the GUI project', () => {
  for (const config of [
    'framework/gui/electron-builder.yml',
    'product/electron-builder.yml',
  ]) {
    assert.match(
      fs.readFileSync(path.join(ROOT, config), 'utf8'),
      /^\s+sign: \.\/scripts\/sign-macos\.mjs$/m,
      config,
    );
  }
});
