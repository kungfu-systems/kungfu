// SPDX-License-Identifier: Apache-2.0
//
// Kfx scaffold fixture: `kungfu sdk create extension` output builds and installs
// from a clean directory. Scaffolds a view extension into a temp dir, links
// the workspace contract packages the way pnpm would (the fixture stays
// offline), builds it with `kungfu sdk kfx build`, asserts the bundle honors the
// load contract (View export, shell-injected modules left external), then
// packs the tgz and runs it through the `kungfu kfx install` lifecycle.
// Requires the core dev environment (built dist/kungfu) and the repository's
// installed node_modules (the sdk's esbuild).
//
// Usage: node tests/fixtures/kfx-demo-scaffold/run.mjs

import fs from 'node:fs';
import path from 'node:path';
import {
  locate,
  tmpDir,
  run,
  kfc,
  assertContains,
  fail,
} from '../_harness.mjs';

const { coreDir } = locate(import.meta.url);
const repoDir = path.resolve(coreDir, '..', '..');
const sdk = path.join(repoDir, 'developer', 'sdk', 'src', 'sdk.js');

const work = tmpDir('kfx-scaffold-work-');
const home = tmpDir('kfx-scaffold-home-');
const packdir = tmpDir('kfx-scaffold-pack-');

const k = (args, opts) => kfc(coreDir, home, args, opts);

const extDir = path.join(work, 'my-view');
run(process.execPath, [sdk, 'create', 'extension', extDir, '--workspace']);
if (!fs.existsSync(path.join(extDir, 'package.json'))) fail('no package.json scaffolded');
if (!fs.existsSync(path.join(extDir, '.gitignore'))) {
  fail('_gitignore not renamed to .gitignore');
}
if (fs.readFileSync(path.join(extDir, 'package.json'), 'utf8').includes('__EXT_')) {
  fail('unreplaced template token');
}

// workspace deps in a standalone dir: link the contract packages like pnpm
// would inside the monorepo (the build only needs their sources)
fs.mkdirSync(path.join(extDir, 'node_modules', '@kungfu-tech'), { recursive: true });
fs.symlinkSync(
  path.join(repoDir, 'framework', 'kfx'),
  path.join(extDir, 'node_modules', '@kungfu-tech', 'kfx'),
);
fs.symlinkSync(
  path.join(repoDir, 'framework', 'api'),
  path.join(extDir, 'node_modules', '@kungfu-tech', 'api'),
);

run(process.execPath, [sdk, 'kfx', 'build'], { cwd: extDir });
const bundle = path.join(extDir, 'dist', 'view', 'index.js');
if (!fs.existsSync(bundle)) fail('kungfu sdk kfx build produced no bundle');

// the load contract, asserted the way the shell loads it: CommonJS-wrap with
// a require shim; only shell-provided modules may be required; the bundle
// must export a View component function
const providedModules = JSON.parse(
  fs.readFileSync(path.join(repoDir, 'framework', 'kfx', 'shared-modules.json')),
).modules;
const loadContract = `
const fs = require("node:fs");
const code = fs.readFileSync(process.argv[1], "utf8");
const provided = ${JSON.stringify(providedModules)};
const m = { exports: {} };
new Function("require", "module", "exports", code)(
  (id) => { if (provided.includes(id)) return {}; throw new Error("unexpected require: " + id); },
  m, m.exports,
);
if (typeof m.exports.View !== "function") { console.error("FAIL: bundle does not export View"); process.exit(1); }
`;
run(process.execPath, ['-e', loadContract, bundle]);

// the distribution unit: npm pack, then the managed install lifecycle
const packed = run('npm', ['pack', '--pack-destination', packdir], { cwd: extDir });
const tgzName = packed.stdout.trim().split(/\r?\n/).pop();
const tgz = path.join(packdir, tgzName);
if (!fs.existsSync(tgz)) fail('npm pack produced no tgz');

k(['kfx', 'install', tgz]);
assertContains(k(['kfx', 'list']), 'my-view', 'installed kfx not listed');
if (!fs.existsSync(path.join(home, 'extensions', 'my-view', 'dist', 'view', 'index.js'))) {
  fail('bundle missing from install root');
}
k(['kfx', 'remove', 'my-view']);
if (fs.existsSync(path.join(home, 'extensions', 'my-view'))) fail('not removed');
console.log('[kfx-demo-scaffold] scaffold-to-install ok');
