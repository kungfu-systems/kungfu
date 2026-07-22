#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  platformCommand,
  platformCommandOptions,
} from '../../../../scripts/platform-command.mjs';
import { qualificationHoldMs, runMeasured } from '../process-metrics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    package: '',
    report: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--package' || arg === '--report') {
      index += 1;
      if (index >= argv.length) fail(`${arg} requires a path`);
      options[arg.slice(2)] = path.resolve(argv[index]);
    } else fail(`unknown argument '${arg}'`);
  }
  if (!options.package) {
    const releaseRoot = path.join(ROOT, 'product', 'release', 'spec');
    const matches = fs.existsSync(releaseRoot)
      ? fs
          .readdirSync(releaseRoot)
          .filter((name) => name.endsWith('.tgz'))
          .map((name) => path.join(releaseRoot, name))
      : [];
    if (matches.length !== 1)
      fail(
        `expected one spec package under ${releaseRoot}, found ${matches.length}`,
      );
    options.package = matches[0];
  }
  return options;
}

function directorySize(root) {
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) total += directorySize(target);
    else if (entry.isFile()) total += fs.statSync(target).size;
  }
  return total;
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) fail(`git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-format-qualification-'),
  );
  try {
    fs.writeFileSync(
      path.join(temp, 'package.json'),
      `${JSON.stringify({ private: true }, null, 2)}\n`,
    );
    const install = spawnSync(
      platformCommand('npm'),
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        options.package,
      ],
      {
        cwd: temp,
        encoding: 'utf8',
        ...platformCommandOptions('npm'),
      },
    );
    if (install.status !== 0)
      fail(`clean npm install failed:\n${install.stderr}`);
    const packageRoot = path.join(temp, 'node_modules', '@kungfu-tech', 'spec');
    const binary = path.join(packageRoot, 'bin', 'kungfu-spec.js');
    const bundle = path.join(packageRoot, 'conformance', 'unknown-record');
    const preserved = path.join(temp, 'preserved');
    const env = {
      ...process.env,
      KUNGFU_QUALIFICATION_HOLD_MS: String(qualificationHoldMs()),
    };
    const inspect = await runMeasured(
      process.execPath,
      [binary, 'inspect', bundle],
      {
        cwd: temp,
        env,
      },
    );
    const verify = await runMeasured(
      process.execPath,
      [binary, 'verify', bundle],
      {
        cwd: temp,
        env,
      },
    );
    const preserve = await runMeasured(
      process.execPath,
      [binary, 'preserve', bundle, preserved],
      { cwd: temp, env },
    );
    const outputs = [inspect, verify, preserve].map((result) =>
      JSON.parse(result.stdout.trim()),
    );
    if (outputs.some((result) => result.status !== 'passing'))
      fail('format conformance command did not pass');
    if (
      outputs[0].unknown_records !== 1 ||
      outputs[2].unknown_records_preserved !== 1
    )
      fail('unknown-record preservation proof is incomplete');
    const source = {
      commit: git(['rev-parse', 'HEAD']),
      tree_dirty: git(['status', '--porcelain']).length > 0,
    };
    const report = {
      schema: 'kungfu.layer-qualification.format-report/v1',
      status: 'passing',
      platform: 'portable',
      architecture: 'any',
      source,
      qualification: {
        id: 'format-spec',
        status: 'passing',
        exact_artifact: path.relative(ROOT, options.package),
        exact_artifact_sha256: sha256(options.package),
        capabilities: ['open', 'inspect', 'verify', 'preserve_unknowns'],
        measurements: {
          dependency_count: 1,
          installed_size_bytes: directorySize(packageRoot),
          cold_start_ms: inspect.durationMs,
          resident_runtime_count: 1,
          resident_memory_bytes: Math.max(
            inspect.peakResidentBytes,
            verify.peakResidentBytes,
            preserve.peakResidentBytes,
          ),
          onboarding_concept_count: 4,
        },
      },
    };
    if (options.report) {
      fs.mkdirSync(path.dirname(options.report), { recursive: true });
      fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(
      `[layers:qualify:format] passing; artifact=${report.qualification.exact_artifact_sha256}`,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `[layers:qualify:format] failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
