#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Pack and qualify only @kungfu-tech/spec and @kungfu-tech/site.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  platformCommand,
  platformCommandOptions,
  pythonCommand,
  pythonCommandArgs,
} from './platform-command.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_SOURCES = [
  ['@kungfu-tech/spec', 'framework/spec'],
  ['@kungfu-tech/site', 'framework/site'],
];

function fail(message) {
  throw new Error(message);
}

function sha256(file) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex');
}

function run(executable, args, options = {}) {
  const result = spawnSync(platformCommand(executable), args, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    ...platformCommandOptions(executable),
    env: options.env || process.env,
  });
  if (result.error || result.status !== 0) {
    if (options.capture && result.stdout) process.stdout.write(result.stdout);
    if (options.capture && result.stderr) process.stderr.write(result.stderr);
    fail(
      `${executable} ${args.join(' ')} failed (status=${result.status ?? 'spawn'})`,
    );
  }
  return (result.stdout || '').trim();
}

function archiveName(name, version) {
  return `${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`;
}

function tarEntries(archive) {
  return run('tar', ['-tzf', archive], { capture: true })
    .split('\n')
    .filter(Boolean)
    .sort();
}

function assertArchive(name, entries) {
  if (!entries.includes('package/package.json'))
    fail(`${name}: package.json is missing from archive`);
  if (entries.some((entry) => entry.includes('/node_modules/')))
    fail(`${name}: archive contains node_modules`);
  if (name === '@kungfu-tech/spec') {
    for (const required of [
      'package/dist/manifest.json',
      'package/dist/compatibility.json',
      'package/dist/vectors/index.json',
      'package/reference-readers/python/portable_format_reader.py',
      'package/bin/kungfu-spec.js',
    ])
      if (!entries.includes(required)) fail(`${name}: missing ${required}`);
    if (entries.some((entry) => entry.startsWith('package/scripts/')))
      fail(`${name}: source-tree generator leaked into archive`);
  }
  if (name === '@kungfu-tech/site') {
    for (const required of [
      'package/dist/site/site-bundle.json',
      'package/dist/site/format/manifest.json',
      'package/index.js',
    ])
      if (!entries.includes(required)) fail(`${name}: missing ${required}`);
    if (entries.some((entry) => entry.startsWith('package/src/')))
      fail(`${name}: source composition leaked into archive`);
  }
}

function qualifyInstalledConsumer(archives) {
  const consumer = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-portable-format-consumer-'),
  );
  try {
    fs.writeFileSync(
      path.join(consumer, 'package.json'),
      `${JSON.stringify({ private: true }, null, 2)}\n`,
    );
    run(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...archives],
      { cwd: consumer },
    );
    const spec = JSON.parse(
      run(
        'node',
        [
          '-e',
          "process.stdout.write(JSON.stringify(require('@kungfu-tech/spec').verifyAuthorityBundle()))",
        ],
        { cwd: consumer, capture: true },
      ),
    );
    const cli = JSON.parse(
      run(
        'node',
        [
          'node_modules/@kungfu-tech/spec/bin/kungfu-spec.js',
          'authority-verify',
        ],
        { cwd: consumer, capture: true },
      ),
    );
    const python = JSON.parse(
      run(
        pythonCommand(),
        pythonCommandArgs(
          [
            'node_modules/@kungfu-tech/spec/reference-readers/python/portable_format_reader.py',
            '--json',
          ],
          { project: path.join(ROOT, 'framework', 'core') },
        ),
        { cwd: consumer, capture: true },
      ),
    );
    const site = JSON.parse(
      run(
        'node',
        [
          '-e',
          [
            "const site=require('@kungfu-tech/site');",
            'const verified=site.verifyBundle();',
            'const pages=site.renderPageModels();',
            'process.stdout.write(JSON.stringify({verified,pages:pages.map(({id,route,contentRoot})=>({id,route,contentRoot}))}));',
          ].join(''),
        ],
        { cwd: consumer, capture: true },
      ),
    );
    if (
      spec.status !== 'read' ||
      cli.normative_root !== spec.normative_root ||
      python.normativeRoot !== spec.normative_root ||
      python.vectorCount !== 16 ||
      python.runtimeDependencies.length !== 0 ||
      site.verified.status !== 'passing' ||
      site.pages.length !== site.verified.surfaces
    )
      fail('clean installed consumer qualification mismatch');
    return {
      spec,
      cliNormativeRoot: cli.normative_root,
      python: {
        vectorCount: python.vectorCount,
        outcomes: python.outcomes,
        runtimeDependencies: python.runtimeDependencies,
      },
      site: {
        contentRoot: site.verified.contentRoot,
        pageCount: site.pages.length,
        routes: site.pages.map(({ route }) => route),
        pageRoots: site.pages.map(({ id, contentRoot }) => ({
          id,
          contentRoot,
        })),
      },
    };
  } finally {
    fs.rmSync(consumer, { recursive: true, force: true });
  }
}

export function qualifyPortableFormatPackages({ output = '' } = {}) {
  const staging = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-portable-format-pack-'),
  );
  try {
    const packages = [];
    for (const [name, relative] of PACKAGE_SOURCES) {
      const packageRoot = path.join(ROOT, relative);
      const pkg = JSON.parse(
        fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
      );
      if (
        pkg.name !== name ||
        pkg.version !== '4.0.0-alpha.3' ||
        pkg.publishConfig?.registry !== 'https://registry.npmjs.org/' ||
        pkg.publishConfig?.access !== 'public'
      )
        fail(`${name}: focused alpha publication metadata drifted`);
      run('pnpm', ['pack', '--pack-destination', staging], {
        cwd: packageRoot,
      });
      const archive = path.join(staging, archiveName(name, pkg.version));
      if (!fs.existsSync(archive)) fail(`${name}: archive was not produced`);
      const entries = tarEntries(archive);
      assertArchive(name, entries);
      packages.push({
        name,
        version: pkg.version,
        distTag: 'alpha',
        archive: path.basename(archive),
        sha256: sha256(archive),
        byteLength: fs.statSync(archive).size,
        entryCount: entries.length,
        entriesRoot: `sha256:${crypto
          .createHash('sha256')
          .update(`${entries.join('\n')}\n`)
          .digest('hex')}`,
      });
    }
    const consumer = qualifyInstalledConsumer(
      packages.map(({ archive }) => path.join(staging, archive)),
    );
    if (output) {
      fs.mkdirSync(output, { recursive: true });
      for (const pkg of packages) {
        const source = path.join(staging, pkg.archive);
        const target = path.join(output, pkg.archive);
        if (fs.existsSync(target) && sha256(target) !== pkg.sha256)
          fail(`${pkg.archive}: existing output digest differs`);
        if (!fs.existsSync(target)) fs.copyFileSync(source, target);
      }
    }
    return {
      schema: 'kungfu.portable-format-package-qualification/v1',
      sourceRevision: run('git', ['rev-parse', 'HEAD'], {
        capture: true,
      }),
      sourceDirty: Boolean(
        run('git', ['status', '--porcelain=v1'], { capture: true }),
      ),
      packageSet: PACKAGE_SOURCES.map(([name]) => name),
      packages,
      consumer,
      nonClaims: [
        'This qualification does not publish, reserve, overwrite, or delete an npm coordinate.',
        'This qualification does not modify or deploy a downstream site repository.',
        'The alpha dist-tag does not claim stable or latest compatibility.',
      ],
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function main(argv = process.argv.slice(2)) {
  const outputIndex = argv.indexOf('--output');
  const outputValue = outputIndex >= 0 ? argv[outputIndex + 1] : '';
  if (outputIndex >= 0 && !outputValue) fail('--output requires a directory');
  const reportIndex = argv.indexOf('--report');
  const reportValue = reportIndex >= 0 ? argv[reportIndex + 1] : '';
  if (reportIndex >= 0 && !reportValue) fail('--report requires a path');
  const report = qualifyPortableFormatPackages({
    output: outputValue ? path.resolve(outputValue) : '',
  });
  if (reportValue) {
    const target = path.resolve(reportValue);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try {
    main();
  } catch (error) {
    console.error(
      `[portable-format-package-qualification] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
