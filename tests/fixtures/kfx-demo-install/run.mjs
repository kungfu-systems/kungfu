// SPDX-License-Identifier: Apache-2.0
//
// Kfx distribution fixture: `npm pack` of a view extension is a complete,
// offline installable unit. Packs the real work-dashboard package, installs
// the tgz into a clean home through `kungfu kfx install`, and asserts the
// managed lifecycle: list, double-install refusal, --force replace, remove.
// Requires the core dev environment (built dist/kungfu) and the extension's
// own build output (dist/view/index.js, from `kungfu sdk kfx build`).
//
// Usage: node tests/fixtures/kfx-demo-install/run.mjs

import fs from 'node:fs';
import path from 'node:path';
import {
  locate,
  tmpDir,
  run,
  kfc,
  uvPython,
  fail,
  extractPackedKfx,
  kfxQualificationAuthorityFile,
  kfxRemovalAuthorityFile,
} from '../_harness.mjs';

const { fixtureDir, coreDir } = locate(import.meta.url);
const repoDir = path.resolve(coreDir, '..', '..');

const home = tmpDir('kfx-install-home-');
const packdir = tmpDir('kfx-install-pack-');

const k = (args, opts) => kfc(coreDir, home, args, opts);

// the distribution unit: a plain npm tgz of the built extension package
const extDir = path.join(repoDir, 'extensions', 'work-dashboard');
if (!fs.existsSync(path.join(extDir, 'dist', 'view', 'index.js'))) {
  fail('work-dashboard is not built (run kungfu sdk kfx build first)');
}
const packed = run('npm', ['pack', '--pack-destination', packdir], { cwd: extDir });
const tgzName = packed.stdout.trim().split(/\r?\n/).pop();
const tgz = path.join(packdir, tgzName);
if (!fs.existsSync(tgz)) fail('npm pack produced no tgz');

const authority = kfxQualificationAuthorityFile(
  coreDir,
  home,
  extractPackedKfx(coreDir, tgz),
  'work-dashboard',
);
const installArgs = ['kfx', 'install', tgz, '--authority-file', authority];
k(installArgs);
k(['kfx', 'list']);

// double install must refuse without --force, succeed with it
if (k(installArgs, { allowFail: true }).status === 0) {
  fail('double install did not refuse');
}
k([...installArgs, '--force']);

uvPython(coreDir, [path.join(fixtureDir, 'check_install.py'), home]);

const removalAuthority = kfxRemovalAuthorityFile(
  coreDir,
  home,
  'work-dashboard',
);
const removeArgs = [
  'kfx',
  'remove',
  'work-dashboard',
  '--authority-file',
  removalAuthority,
];
k(removeArgs);
if (k(removeArgs, { allowFail: true }).status === 0) {
  fail('removing a missing key did not fail');
}
if (fs.existsSync(path.join(home, 'extensions', 'work-dashboard'))) fail('not removed');
console.log('[kfx-demo-install] lifecycle ok');
