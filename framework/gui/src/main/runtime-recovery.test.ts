import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isResettableRuntimeFailure } from '../runtime-recovery-contract';
import { backupAndResetRuntime } from './runtime-recovery';

function fixture(name: string): { dataHome: string; runtimeDir: string } {
  const dataHome = path.join(tmpdir(), `kungfu-gui-runtime-recovery-${name}`);
  rmSync(dataHome, { recursive: true, force: true });
  const runtimeDir = path.join(dataHome, 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  return { dataHome, runtimeDir };
}

test('classifies missing journal pages as resettable without blaming KFE_PATH', () => {
  assert.equal(
    isResettableRuntimeFailure(
      'failed to open file for page /tmp/runtime/journal/a.1.journal, errno: No such file or directory',
    ),
    true,
  );
  assert.equal(isResettableRuntimeFailure('KFE_PATH not set'), false);
  assert.equal(isResettableRuntimeFailure('journal epoch incompatible'), true);
});

test('backs up the complete runtime and creates an empty replacement', () => {
  const { dataHome, runtimeDir } = fixture('success');
  writeFileSync(path.join(runtimeDir, 'sentinel.json'), '{"kept":true}\n');

  const receipt = backupAndResetRuntime({
    dataHome,
    runtimeDir,
    reason: 'missing journal page',
    now: new Date('2026-07-15T00:00:00.000Z'),
  });

  assert.equal(existsSync(runtimeDir), true);
  assert.equal(existsSync(path.join(runtimeDir, 'sentinel.json')), false);
  assert.equal(
    readFileSync(path.join(receipt.backupPath, 'sentinel.json'), 'utf8'),
    '{"kept":true}\n',
  );
  assert.deepEqual(
    JSON.parse(
      readFileSync(
        path.join(receipt.backupPath, 'gui-runtime-recovery.json'),
        'utf8',
      ),
    ),
    receipt,
  );
});

test('refuses to move a runtime outside the selected data home', () => {
  const { dataHome } = fixture('boundary');
  const otherRuntime = path.join(tmpdir(), 'kungfu-gui-runtime-other');
  mkdirSync(otherRuntime, { recursive: true });
  assert.throws(
    () =>
      backupAndResetRuntime({
        dataHome,
        runtimeDir: otherRuntime,
        reason: 'boundary test',
      }),
    /outside the selected data home/u,
  );
});
