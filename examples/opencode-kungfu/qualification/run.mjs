#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const qualificationDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(qualificationDir, '..');
const rootDir = path.resolve(packageDir, '..', '..');
const coreDir = path.join(rootDir, 'framework', 'core');
const crashDriver = path.join(qualificationDir, 'crash-driver.mjs');

function fail(message) {
  throw new Error(`OpenCode vendor embedding qualification: ${message}`);
}

function parseArgs(argv) {
  const options = {
    runtimeDist:
      process.env.KUNGFU_RUNTIME_DIST || path.join(coreDir, 'dist', 'kungfu'),
    kfdQualification: process.env.KUNGFU_KFD_QUALIFICATION || '',
    outputDir: '',
    allowDirty: false,
    keepScratch: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    const next = () => {
      index += 1;
      if (index >= argv.length) fail(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === '--runtime-dist') options.runtimeDist = next();
    else if (arg === '--kfd-qualification') options.kfdQualification = next();
    else if (arg === '--output-dir') options.outputDir = next();
    else if (arg === '--allow-dirty') options.allowDirty = true;
    else if (arg === '--keep-scratch') options.keepScratch = true;
    else fail(`unknown argument: ${arg}`);
  }
  if (!options.kfdQualification) {
    fail('--kfd-qualification is required');
  }
  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout || 180_000,
  });
  if (options.expectCrash) {
    if (result.status === 0) fail(`${options.label || command} did not crash`);
    return result;
  }
  if (result.status !== 0) {
    fail(
      `${options.label || command} failed (${result.status ?? result.signal})\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function sha256File(file) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex')}`;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      value,
      (_, item) => (typeof item === 'bigint' ? item.toString() : item),
      2,
    )}\n`,
  );
}

function commandVersion(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) return null;
  return (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || null;
}

function sourceIdentity() {
  const head = run('git', ['rev-parse', 'HEAD']).stdout.trim();
  const status = run('git', [
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]).stdout;
  const diff = run('git', ['diff', '--binary', 'HEAD']).stdout;
  return {
    repository: 'kungfu-systems/kungfu',
    head,
    clean: status.trim() === '',
    workingTreeDigest: `sha256:${crypto
      .createHash('sha256')
      .update(diff)
      .digest('hex')}`,
  };
}

function findTarball(directory, prefix) {
  const entries = fs
    .readdirSync(directory)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.tgz'));
  if (entries.length !== 1) {
    fail(`expected one ${prefix} tarball, found ${entries.length}`);
  }
  return path.join(directory, entries[0]);
}

function percentile(values, ratio) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[
    Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)
  ];
}

function loadKfdQualification(configured, outputDir) {
  const input = path.resolve(configured);
  const reportPath = fs.statSync(input).isDirectory()
    ? path.join(input, 'qualification-report.json')
    : input;
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(
    report.contract,
    'kungfu.kfd-agent-runtime.qualification-report/v1',
  );
  assert.ok(['passed', 'development-pass'].includes(report.verdict));
  assert.equal(report.kfd.report.valid, true);
  assert.equal(report.kfd.verifier.valid, true);
  const retained = path.join(outputDir, 'kfd-agent-runtime-qualification.json');
  fs.copyFileSync(reportPath, retained);
  return {
    path: path.basename(retained),
    sha256: sha256File(retained),
    verdict: report.verdict,
    adapter: report.artifacts.adapter,
    profile: report.kfd.report.profile,
    suite: report.kfd.report.suite,
    verifier: report.kfd.verifier,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = sourceIdentity();
  if (!source.clean && !options.allowDirty) {
    fail('source tree is dirty; commit exact source or pass --allow-dirty');
  }
  const runtimeDist = path.resolve(options.runtimeDist);
  const nodeBinding = path.join(runtimeDist, 'kungfu_node.node');
  if (!fs.existsSync(nodeBinding)) {
    fail(`frozen Node binding not found: ${nodeBinding}; run ./shifu freeze`);
  }

  const outputDir = path.resolve(
    options.outputDir ||
      path.join(
        coreDir,
        'build',
        'qualification',
        'opencode-vendor-embedding',
        new Date().toISOString().replaceAll(/[:.]/g, '-'),
      ),
  );
  if (fs.existsSync(outputDir)) fail(`output already exists: ${outputDir}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-opencode-vendor-'),
  );
  try {
    const artifacts = path.join(scratch, 'artifacts');
    fs.mkdirSync(artifacts);
    run('pnpm', ['pack', '--pack-destination', artifacts], {
      cwd: packageDir,
      label: 'plugin pack',
    });
    run('pnpm', ['pack', '--pack-destination', artifacts], {
      cwd: coreDir,
      label: 'core pack',
    });
    const pluginTarball = findTarball(
      artifacts,
      'kungfu-tech-opencode-kungfu-',
    );
    const coreTarball = findTarball(artifacts, 'kungfu-tech-core-');

    const consumer = path.join(scratch, 'consumer');
    fs.mkdirSync(consumer);
    writeJson(path.join(consumer, 'package.json'), {
      name: 'clean-opencode-kungfu-consumer',
      version: '1.0.0',
      private: true,
    });
    const installStarted = performance.now();
    run(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        pluginTarball,
        coreTarball,
      ],
      { cwd: consumer, label: 'clean npm install' },
    );
    const installMs = performance.now() - installStarted;

    const installedPlugin = path.join(
      consumer,
      'node_modules',
      '@kungfu-tech',
      'opencode-kungfu',
      'index.mjs',
    );
    const installedCoreDist = path.join(
      consumer,
      'node_modules',
      '@kungfu-tech',
      'core',
      'dist',
      'kungfu',
    );
    const runtimeDir = path.join(scratch, 'source.kungfu');
    const env = {
      ...process.env,
      KUNGFU_DIR: installedCoreDist,
      KUNGFU_OPENCODE_RUNTIME_DIR: runtimeDir,
    };
    const crashed = run(
      process.execPath,
      [crashDriver, pathToFileURL(installedPlugin).href, runtimeDir],
      {
        cwd: consumer,
        env,
        expectCrash: true,
        label: 'forced process termination',
      },
    );

    process.env.KUNGFU_DIR = installedCoreDist;
    const { createKungfuOpenCodePlugin } = await import(
      `${pathToFileURL(installedPlugin).href}?qualification=${Date.now()}`
    );
    const plugin = createKungfuOpenCodePlugin({ runtimeDir });
    const hooks = await plugin({
      directory: consumer,
      worktree: consumer,
      client: { providerCredential: 'must-not-be-retained' },
    });
    const hookDurations = [];
    await hooks.event({
      event: {
        type: 'session.updated',
        properties: {
          info: {
            id: 'qualification-long-task',
            prompt: 'must-not-be-retained',
          },
        },
      },
    });
    for (let index = 0; index < 100; index += 1) {
      const started = performance.now();
      const output = { payload: 'must-remain-vendor-owned' };
      await hooks['tool.execute.before'](
        {
          sessionID: 'qualification-long-task',
          tool: 'fixture',
          args: { providerToken: 'must-not-be-retained' },
        },
        output,
      );
      await hooks['tool.execute.after'](
        { sessionID: 'qualification-long-task', tool: 'fixture' },
        output,
      );
      assert.deepEqual(output, { payload: 'must-remain-vendor-owned' });
      hookDurations.push(performance.now() - started);
    }

    const core = await import(
      `${
        pathToFileURL(
          path.join(
            consumer,
            'node_modules',
            '@kungfu-tech',
            'core',
            'lib',
            'index.js',
          ),
        ).href
      }?qualification=${Date.now()}`
    );
    const binding = core.default.kungfu();
    await hooks.event({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'qualification-long-task' },
      },
    });
    const episodesAfterClose = binding.storageEpisodeListTyped(runtimeDir);
    const sealedEpisode = episodesAfterClose.episodes.find(
      (episode) =>
        episode.open?.source === 'opencode.plugin.lifecycle' &&
        episode.close?.status === 2,
    );
    assert.ok(sealedEpisode);
    const episodeId = String(sealedEpisode.episode_id);
    const bundleJson = binding.runStorageTransferOperationJson(
      'export_bundle',
      runtimeDir,
      JSON.stringify({
        scope: 'episode',
        episode_id: episodeId,
        thin: false,
      }),
    );
    assert.equal(JSON.parse(bundleJson).manifest.status, 'ended');
    const bundlePath = path.join(outputDir, 'episode-bundle.json');
    fs.writeFileSync(bundlePath, `${bundleJson}\n`);
    const projectCutBundleJson = binding.runStorageTransferOperationJson(
      'export_bundle',
      runtimeDir,
      JSON.stringify({
        scope: 'episode',
        episode_id: episodeId,
        thin: true,
      }),
    );
    const projectCutBundlePath = path.join(
      outputDir,
      'episode-project-cut-bundle.json',
    );
    fs.writeFileSync(projectCutBundlePath, `${projectCutBundleJson}\n`);
    const sourceFsck = binding.storageFsckTyped(runtimeDir, {});
    assert.equal(sourceFsck.ok, true);
    const episodeFsck = binding.storageFsckTyped(runtimeDir, {
      episode_id: BigInt(episodeId),
    });
    assert.equal(episodeFsck.ok, true);
    const episodeQualificationPath = path.join(
      outputDir,
      'episode-qualification.json',
    );
    writeJson(episodeQualificationPath, episodeFsck);

    const destinationRuntime = path.join(scratch, 'destination.kungfu');
    const imported = JSON.parse(
      binding.runStorageTransferOperationJson(
        'import_bundle',
        destinationRuntime,
        `{"scope":"episode","episode_id":"${episodeId}","verify":true,"dry_run":false,"bundle":${bundleJson}}`,
      ),
    );
    assert.equal(imported.ok, true);
    const destinationFsck = binding.storageFsckTyped(destinationRuntime, {});
    assert.equal(destinationFsck.ok, true);

    const retainedKfd = loadKfdQualification(
      options.kfdQualification,
      outputDir,
    );
    const report = {
      schemaVersion: 1,
      contract: 'kungfu.vendor-embedding.qualification-report/v1',
      verdict: source.clean ? 'passed' : 'development-pass',
      claim:
        'The exact candidate package retained OpenCode public lifecycle-hook evidence through libkungfu, recovered after forced process termination, exported and imported an Episode, and links an independently verified exact KFD reference-runtime report.',
      source,
      observedEnvironment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        opencode: commandVersion('opencode'),
        python: commandVersion('python3'),
        cCompiler: commandVersion('cc', ['--version']),
      },
      vendorBoundary: {
        vendor: 'OpenCode',
        seam: 'public npm plugin lifecycle hooks',
        providerAccountUsed: false,
        promptPayloadRetained: false,
        toolPayloadRetained: false,
        hookOutputModified: false,
        tuiReplaced: false,
        providerRoutingReplaced: false,
        permissionsReplaced: false,
        cloudConnectionReplaced: false,
      },
      cleanInstall: {
        packageManager: commandVersion('npm'),
        installMs,
        pluginTarballBytes: fs.statSync(pluginTarball).size,
        pluginTarballSha256: sha256File(pluginTarball),
        coreTarballSha256: sha256File(coreTarball),
        installedPlugin: true,
      },
      faultAndPortability: {
        forcedTermination: {
          status: crashed.status,
          signal: crashed.signal,
        },
        recoveredEpisodeCount: episodesAfterClose.episodes.filter(
          (episode) => episode.close?.status === 3,
        ).length,
        sourceFsck: sourceFsck.ok,
        exportBundle: {
          path: path.basename(bundlePath),
          sha256: sha256File(bundlePath),
          episodeId,
        },
        episodeQualification: {
          path: path.basename(episodeQualificationPath),
          sha256: sha256File(episodeQualificationPath),
          status: episodeFsck.qualification.status,
        },
        projectCutBundle: {
          path: path.basename(projectCutBundlePath),
          sha256: sha256File(projectCutBundlePath),
          thin: true,
        },
        import: {
          ok: imported.ok,
          status: imported.status,
          destinationFsck: destinationFsck.ok,
        },
      },
      measurements: {
        samples: hookDurations.length,
        pairedHookLatencyMs: {
          p50: percentile(hookDurations, 0.5),
          p95: percentile(hookDurations, 0.95),
          p99: percentile(hookDurations, 0.99),
          max: Math.max(...hookDurations),
        },
      },
      kfdReferenceRuntime: retainedKfd,
      residualRisk: [
        `Only ${process.platform}/${process.arch} was observed by this report.`,
        'OpenCode lifecycle compatibility is observed through the installed public hook shape without invoking a model provider.',
        'Forced process termination is not a physical power-loss test.',
        'This reference candidate does not assert OpenCode endorsement, universal compatibility, or external adoption.',
      ],
    };
    assert.ok(report.faultAndPortability.recoveredEpisodeCount >= 1);
    const reportPath = path.join(outputDir, 'qualification-report.json');
    writeJson(reportPath, report);
    process.stdout.write(
      `[opencode-vendor-embedding] verdict=${report.verdict} opencode=${report.observedEnvironment.opencode || 'not-found'} recovered=${report.faultAndPortability.recoveredEpisodeCount}\n`,
    );
    process.stdout.write(`[opencode-vendor-embedding] report=${reportPath}\n`);
  } finally {
    if (options.keepScratch) {
      process.stdout.write(`[opencode-vendor-embedding] scratch=${scratch}\n`);
    } else {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

await main();
