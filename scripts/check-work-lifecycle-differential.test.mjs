// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import nodeBinding from '@kungfu-tech/storage/generated/work-lifecycle-v1';

const fixture = JSON.parse(
  fs.readFileSync(
    'tests/qualification/work-lifecycle/four-language-v1.json',
    'utf8',
  ),
);
const compact = (value) => JSON.stringify(value);

test('Node and Python produce byte-identical lifecycle requests without deciding unknown operations', () => {
  const nodeRequest = nodeBinding.request(
    fixture.request.operationId,
    fixture.request.input,
    fixture.request.execute,
  );
  assert.equal(compact(nodeRequest), fixture.request.exactJson);
  assert.equal(
    nodeBinding.request(fixture.negative.unknownOperation, {}, false)
      .operationId,
    fixture.negative.unknownOperation,
  );

  const python = spawnSync(
    'python3',
    [
      '-c',
      [
        'import json,sys',
        "sys.path.insert(0, 'framework/storage/python')",
        'from kungfu_sdk.generated.work_lifecycle_v1 import request',
        `print(json.dumps(request(${JSON.stringify(fixture.request.operationId)}, ${JSON.stringify(fixture.request.input)}, False), sort_keys=True, separators=(',', ':')))`,
      ].join(';'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(python.status, 0, python.stderr);
  assert.equal(python.stdout.trim(), fixture.request.exactJson);

  const pythonUnknown = spawnSync(
    'python3',
    [
      '-c',
      [
        'import sys',
        "sys.path.insert(0, 'framework/storage/python')",
        'from kungfu_sdk.generated.work_lifecycle_v1 import request',
        `print(request(${JSON.stringify(fixture.negative.unknownOperation)}, {}, False)['operationId'])`,
      ].join(';'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(pythonUnknown.status, 0, pythonUnknown.stderr);
  assert.equal(pythonUnknown.stdout.trim(), fixture.negative.unknownOperation);
});

test('the generated C++ public symbol produces the same exact request bytes', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-work-lifecycle-'),
  );
  try {
    const source = path.join(temporary, 'fixture.cpp');
    const binary = path.join(temporary, 'fixture');
    fs.writeFileSync(
      source,
      [
        '#include <kungfu/sdk/generated/work_lifecycle_v1.hpp>',
        '#include <iostream>',
        'int main() {',
        `  std::cout << kungfu::sdk::generated::work_lifecycle_v1::request(${JSON.stringify(fixture.request.operationId)}, R"(${JSON.stringify(fixture.request.input)})", false);`,
        '}',
      ].join('\n'),
    );
    const compile = spawnSync(
      'c++',
      [
        '-std=c++20',
        '-Iframework/core/src/libkungfu/include',
        source,
        '-o',
        binary,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, fixture.request.exactJson);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
