// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fail, findBin, locate, run, tmpDir } from '../_harness.mjs';

const { buildDir } = locate(import.meta.url);
const host = findBin(
  buildDir,
  'native_storage_closure_host',
  'slices/native-storage-closure',
);
if (!host) fail('native_storage_closure_host not found');

const workspace = path.join(
  tmpDir('native-storage-closure-'),
  'fixture.kungfu',
);
const result = run(host, [workspace]);
process.stdout.write(result.stdout);
const report = JSON.parse(result.stdout.trim().split('\n').at(-1));
if (!report.ok || report.abi_version !== 1 || report.language_hosts !== 0)
  fail('native closure report invariant failed');
if (!fs.existsSync(workspace))
  fail('native consumer did not create .kungfu workspace');

// Inspect the native executable itself, not the Node qualification driver.
// libkungfu and system/Conan libraries are allowed; language hosts, Electron,
// and external database services are not.
const probes =
  process.platform === 'darwin'
    ? [['otool', ['-L', host]]]
    : process.platform === 'linux'
      ? [['ldd', [host]]]
      : [
          ['dumpbin', ['/DEPENDENTS', host]],
          ['ldd', [host]],
        ];
let dependencyOutput = '';
for (const [command, args] of probes) {
  const probe = spawnSync(command, args, { encoding: 'utf8' });
  if (!probe.error && probe.status === 0) {
    dependencyOutput = `${probe.stdout || ''}${probe.stderr || ''}`;
    break;
  }
}
if (
  /(python|libnode|node\.dll|electron|rust_host|postgres|mysql|mongodb)/i.test(
    dependencyOutput,
  )
)
  fail(`forbidden native dependency detected:\n${dependencyOutput}`);

console.log('native storage closure: PASS');
