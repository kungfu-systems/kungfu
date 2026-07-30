// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { typeDiagnosticsForFiles } from './check-typescript-files.mjs';

test('file-scoped type check reports only diagnostics owned by requested files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-ts-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true },
      include: ['*.ts'],
    }),
  );
  fs.writeFileSync(path.join(root, 'good.ts'), 'export const value = 1;\n');
  fs.writeFileSync(
    path.join(root, 'bad.ts'),
    'export const value = missingValue;\n',
  );

  assert.deepEqual(
    typeDiagnosticsForFiles('tsconfig.json', ['good.ts'], root),
    [],
  );
  const diagnostics = typeDiagnosticsForFiles(
    'tsconfig.json',
    ['bad.ts'],
    root,
  );
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.code),
    [2304],
  );
});
