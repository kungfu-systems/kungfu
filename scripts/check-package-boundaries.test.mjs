// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  collectPackageBoundaryIssues,
  installFixturePackages,
  moduleReferences,
} from './check-package-boundaries.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-package-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function write(file, value) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  }
  write('pnpm-workspace.yaml', 'packages:\n  - "framework/*"\n');
  write('package.json', { name: 'repository', private: true });
  write('framework/provider/package.json', {
    name: '@test/provider',
    type: 'module',
    exports: { '.': './index.js', './feature': './feature.js' },
  });
  write('framework/provider/index.js', 'export const value = 42;\n');
  write('framework/provider/feature.js', 'export const feature = true;\n');
  write('framework/provider/internal.js', 'export const secret = true;\n');
  write('framework/consumer/package.json', {
    name: '@test/consumer',
    type: 'module',
    dependencies: { '@test/provider': 'workspace:*' },
  });
  return { root, write, check: () => collectPackageBoundaryIssues({ root }) };
}

test('public package imports and local implementation imports pass', (t) => {
  const { write, check } = fixture(t);
  write(
    'framework/consumer/index.js',
    "import {value} from '@test/provider'; export * from '@test/provider/feature'; import './local.js';",
  );
  write('framework/consumer/local.js', 'export const local = true;');
  assert.deepEqual(check().issues, []);
});

test('subprocess consumers cannot execute another package through source paths', (t) => {
  const { write, check } = fixture(t);
  write(
    'framework/consumer/runner.mjs',
    `
    const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../provider/internal.js');
    spawnSync(process.execPath, [target]);
    execFileSync('node', ['--enable-source-maps', '../provider/index.js']);
    fork('../provider/internal.js');
  `,
  );
  assert.equal(check().issues.length, 3);
  assert.ok(
    check().issues.every((issue) => issue.code === 'cross-package-path'),
  );
  write(
    'framework/consumer/runner.mjs',
    `
    const target = fileURLToPath(import.meta.resolve('@test/provider/feature'));
    spawnSync(process.execPath, [target]);
  `,
  );
  assert.deepEqual(check().issues, []);
});

test('root npm scripts must use package entrypoints rather than repository paths', (t) => {
  const { write, check } = fixture(t);
  write('package.json', {
    name: 'repository',
    private: true,
    dependencies: { '@test/provider': 'workspace:*' },
    scripts: { probe: 'node framework/provider/internal.js' },
  });
  assert.deepEqual(
    check().issues.map((issue) => issue.code),
    ['cross-package-path'],
  );
});

test('declarative source check executables obey the same package boundary', (t) => {
  const { write, check } = fixture(t);
  write(
    'scripts/gate.mjs',
    "const nodeChecks = [['provider check', 'framework/provider/internal.js']];",
  );
  assert.deepEqual(
    check().issues.map((issue) => issue.code),
    ['cross-package-path'],
  );
});

test('cross-package imports fail for ESM, CommonJS, type imports and file URLs', (t) => {
  const { write, check } = fixture(t);
  write(
    'framework/consumer/index.ts',
    `
    import '../provider/index.js';
    export * from '../provider/feature.js';
    import('../provider/index.js');
    import('../provider/' + 'feature.js');
    require('../provider/index.js');
    require.resolve('../provider/index.js');
    import.meta.resolve('../provider/index.js');
    const sibling = new URL('../provider/index.js', import.meta.url);
    type Value = import('../provider/index.js').value;
    import legacy = require('../provider/index.js');
    const load = createRequire(import.meta.url);
    load('../provider/index.js');
  `,
  );
  const result = check();
  assert.equal(result.issues.length, 11);
  assert.ok(
    result.issues.every((issue) => issue.code === 'cross-package-path'),
  );
});

test('undeclared dependencies and non-exported deep imports fail separately', (t) => {
  const { write, check } = fixture(t);
  write('framework/consumer/package.json', { name: '@test/consumer' });
  write('framework/consumer/index.js', "import '@test/provider/internal.js';");
  assert.deepEqual(
    check().issues.map((issue) => issue.code),
    ['undeclared-workspace-dependency', 'private-package-entry'],
  );
});

test('TypeScript paths and extends cannot pierce a sibling package', (t) => {
  const { write, check } = fixture(t);
  write('framework/consumer/tsconfig.json', {
    extends: '../provider/tsconfig.json',
    compilerOptions: {
      baseUrl: '.',
      paths: { '@test/provider': ['../provider/index.js'] },
    },
  });
  assert.deepEqual(
    check().issues.map((issue) => issue.code),
    ['cross-package-path', 'source-alias'],
  );
});

test('build aliases and entrypoints cannot pierce a sibling package', (t) => {
  const { write, check } = fixture(t);
  write(
    'framework/consumer/build.mjs',
    "const config = { resolve: { alias: { provider: '../provider/index.js' } }, entryPoints: ['../provider/feature.js'] };",
  );
  assert.deepEqual(
    check().issues.map((issue) => issue.code),
    ['source-alias', 'cross-package-path'],
  );
});

test('comments and generated source strings are not actual module imports', () => {
  assert.deepEqual(
    moduleReferences(
      `// import '../provider/index.js';
    const generated = "import '../provider/index.js';";
    const documentation = \`require('../provider/index.js')\`;
  `,
      'index.mjs',
    ),
    [],
  );
});

test('Node resolves the declared public entry and rejects the private module', (t) => {
  const { root, write } = fixture(t);
  installFixturePackages(root);
  write(
    'framework/consumer/probe.mjs',
    `
    import assert from 'node:assert/strict';
    import {value} from '@test/provider';
    assert.equal(value, 42);
    await assert.rejects(import('@test/provider/internal.js'), {code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'});
  `,
  );
  const result = spawnSync(process.execPath, ['probe.mjs'], {
    cwd: path.join(root, 'framework/consumer'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('constant paths and interpolated imports are checked without executing source', (t) => {
  const { write, check } = fixture(t);
  write(
    'framework/consumer/build.mjs',
    `
    const root = path.dirname(fileURLToPath(import.meta.url));
    const sibling = path.resolve(root, '../provider/index.js');
    const moduleName = '../provider/feature.js';
    require(sibling);
    import(pathToFileURL(sibling).href);
    import(\`\${moduleName}\`);
    const config = { resolve: { alias: { provider: path.resolve(root, '../provider') } } };
  `,
  );
  assert.deepEqual(
    check().issues.map((issue) => issue.code),
    [
      'cross-package-path',
      'cross-package-path',
      'cross-package-path',
      'source-alias',
    ],
  );
});

test('an export cannot legitimize a path outside its owning package', (t) => {
  const { write, check } = fixture(t);
  write('framework/provider/package.json', {
    name: '@test/provider',
    exports: { './escape': '../consumer/index.js' },
  });
  assert.equal(check().issues[0].code, 'invalid-export-target');
});

test('package scripts use declared package tasks instead of sibling paths', (t) => {
  const { write, check } = fixture(t);
  write('framework/consumer/package.json', {
    name: '@test/consumer',
    scripts: {
      dev: 'node ../provider/index.js',
      build: 'pnpm --filter @test/provider build',
    },
  });
  assert.deepEqual(
    check().issues.map((issue) => issue.code),
    ['cross-package-path', 'undeclared-workspace-dependency'],
  );
});

test('a bundler alias cannot expose a private package subpath', (t) => {
  const { write, check } = fixture(t);
  write(
    'framework/consumer/build.mjs',
    "const config = {alias: {shortcut: '@test/provider/internal.js'}};",
  );
  assert.deepEqual(
    check().issues.map((issue) => issue.code),
    ['private-package-entry'],
  );
});

test('test mode checks every file and public npm tasks must exist', (t) => {
  const { write, check } = fixture(t);
  write('package.json', {
    name: 'repository',
    dependencies: { '@test/provider': 'workspace:*' },
    scripts: {
      test: 'node --test local.test.mjs framework/provider/internal.js',
      missing: 'pnpm --filter @test/provider run missing',
    },
  });
  assert.deepEqual(
    check().issues.map(({ code }) => code),
    ['cross-package-path', 'missing-package-task'],
  );
});

test('the public entry runner preserves cwd, argv, main entry and exit status', (t) => {
  const { root, write } = fixture(t);
  write('package.json', {
    name: 'repository',
    dependencies: { '@test/provider': 'workspace:*' },
  });
  write(
    'scripts/run-project-cut-entry.mjs',
    fs.readFileSync(
      new URL('./run-project-cut-entry.mjs', import.meta.url),
      'utf8',
    ),
  );
  write(
    'framework/provider/feature.js',
    `
    import {pathToFileURL} from 'node:url';
    if (import.meta.url === pathToFileURL(process.argv[1]).href) {
      console.log(JSON.stringify({cwd:process.cwd(), args:process.argv.slice(2)}));
      process.exitCode = 7;
    }
  `,
  );
  installFixturePackages(root);
  const cwd = path.join(root, 'framework/consumer');
  const runner = path.join(root, 'scripts/run-project-cut-entry.mjs');
  const result = spawnSync(
    process.execPath,
    [runner, '@test/provider/feature', 'one two', '--flag'],
    { cwd, encoding: 'utf8' },
  );
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    cwd: fs.realpathSync(cwd),
    args: ['one two', '--flag'],
  });
  const privateEntry = spawnSync(
    process.execPath,
    [runner, '@test/provider/internal.js'],
    { cwd, encoding: 'utf8' },
  );
  assert.equal(privateEntry.status, 1);
  assert.match(privateEntry.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
});

test('filtered exec paths use the selected package directory', (t) => {
  const { write, check } = fixture(t);
  write('package.json', {
    name: 'repository',
    dependencies: { '@test/consumer': 'workspace:*' },
    scripts: {
      test: 'pnpm --filter @test/consumer exec node ../provider/internal.js',
    },
  });
  assert.ok(check().issues.some(({ code }) => code === 'cross-package-path'));
});

test('workflow and composite-action commands consume declared public entries', (t) => {
  const { write, check } = fixture(t);
  write(
    '.github/workflows/probe.yml',
    `jobs:
  probe:
    steps:
      - run: node framework/provider/internal.js
      - uses: ./action
        with:
          verify-command: node scripts/run-project-cut-entry.mjs @test/provider/feature
`,
  );
  assert.deepEqual(
    check().issues.map(({ code }) => code),
    ['cross-package-path', 'undeclared-workspace-dependency'],
  );
  write('package.json', {
    name: 'repository',
    dependencies: { '@test/provider': 'workspace:*' },
  });
  write(
    '.github/workflows/probe.yml',
    'jobs: {probe: {steps: [{run: "node scripts/run-project-cut-entry.mjs @test/provider/feature"}]}}',
  );
  assert.deepEqual(check().issues, []);
});

test('Python Node bridges declare dependencies and resolve only public exports', (t) => {
  const { write, check } = fixture(t);
  write(
    'framework/consumer/probe.py',
    'ENTRY = "@test/provider/feature"\nentry = host.node_package_entry(ENTRY)',
  );
  assert.deepEqual(check().issues, []);
  write(
    'framework/consumer/probe.py',
    'entry = host.node_package_entry("@test/provider/internal.js")',
  );
  assert.deepEqual(
    check().issues.map(({ code }) => code),
    ['private-package-entry'],
  );
  write('framework/consumer/package.json', { name: '@test/consumer' });
  assert.deepEqual(
    check().issues.map(({ code }) => code),
    ['undeclared-workspace-dependency', 'private-package-entry'],
  );
});
