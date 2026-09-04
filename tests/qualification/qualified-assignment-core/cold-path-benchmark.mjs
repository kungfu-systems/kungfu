#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { consumeQualifiedCoreForCheckout } from '../../../framework/work/assignment-capture/qualified-assignment-core-consumer.mjs';
import { summarizeQualifiedCoreUsage } from '../../../framework/work/assignment-capture/qualified-assignment-core-observability.mjs';

const SHA = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RUNS = 3;
const COLD_LIMIT_MS = 600_000;
const WARM_LIMIT_MS = 10_000;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(
      Buffer.isBuffer(value)
        ? value
        : Buffer.from(JSON.stringify(canonical(value))),
    )
    .digest('hex')}`;
}

function usage() {
  return [
    'usage: node tests/qualification/qualified-assignment-core/cold-path-benchmark.mjs',
    '  --source-repository PATH --commit SHA --http-base-url URL --output FILE',
    '  [--repository OWNER/REPO]',
  ].join(' ');
}

function parseArgs(args) {
  const result = { repository: 'kungfu-systems/kungfu' };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (
      ![
        '--source-repository',
        '--commit',
        '--http-base-url',
        '--output',
        '--repository',
      ].includes(name) ||
      !args[index + 1]
    ) {
      throw new Error(usage());
    }
    result[name.slice(2).replaceAll('-', '_')] = args[++index];
  }
  if (
    !result.source_repository ||
    !result.http_base_url ||
    !result.output ||
    !SHA.test(result.commit || '') ||
    !REPOSITORY.test(result.repository)
  ) {
    throw new Error(usage());
  }
  const provider = new URL(result.http_base_url);
  if (
    !['http:', 'https:'].includes(provider.protocol) ||
    provider.username ||
    provider.password ||
    provider.search ||
    provider.hash
  ) {
    throw new Error('benchmark HTTP provider URL is invalid');
  }
  return result;
}

function git(args, cwd = undefined) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function cloneCheckout(root, sourceRepository, repository, commit, label) {
  const checkout = path.join(root, label);
  git([
    'clone',
    '--quiet',
    '--shared',
    '--no-checkout',
    sourceRepository,
    checkout,
  ]);
  git(['checkout', '--quiet', '--detach', commit], checkout);
  git(
    ['remote', 'set-url', 'origin', `https://github.com/${repository}.git`],
    checkout,
  );
  if (git(['status', '--porcelain', '--untracked-files=no'], checkout)) {
    throw new Error('fresh benchmark checkout is dirty');
  }
  return checkout;
}

function observation(cacheRoot, recordedAt) {
  const summary = summarizeQualifiedCoreUsage(cacheRoot);
  const recent = summary.recent.find(
    (candidate) => candidate.recordedAt === recordedAt,
  );
  if (!summary.ok || !recent) {
    throw new Error('benchmark usage observation is unavailable');
  }
  const digestHex = recent.observationRoot.slice('sha256:'.length);
  return JSON.parse(
    fs.readFileSync(
      path.join(
        cacheRoot,
        'observations',
        'sha256',
        digestHex.slice(0, 2),
        `${digestHex}.json`,
      ),
      'utf8',
    ),
  );
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function measuredRun({
  temporary,
  sourceRepository,
  repository,
  commit,
  cacheRoot,
  label,
  recordedAt,
}) {
  const checkout = cloneCheckout(
    temporary,
    sourceRepository,
    repository,
    commit,
    label,
  );
  const started = performance.now();
  const result = await consumeQualifiedCoreForCheckout({
    repositoryRoot: checkout,
    publicationRoot: checkout,
    cacheRoot,
    now: recordedAt,
  });
  const wallElapsedMs = Math.round(performance.now() - started);
  const record = observation(cacheRoot, recordedAt);
  return {
    label,
    status: result.status,
    reason: record.reason,
    transportProvider: record.artifact?.transportProvider || null,
    artifactId: record.artifact?.artifactId || null,
    observationRoot: record.observationRoot,
    phasesMs: record.phases,
    wallElapsedMs,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-qualified-core-cold-benchmark-'),
  );
  const previousHttp = process.env.KUNGFU_QUALIFIED_CORE_HTTP_BASE_URL;
  const previousBundle = process.env.KUNGFU_QUALIFIED_CORE_BUNDLE;
  process.env.KUNGFU_QUALIFIED_CORE_HTTP_BASE_URL = options.http_base_url;
  Reflect.deleteProperty(process.env, 'KUNGFU_QUALIFIED_CORE_BUNDLE');
  try {
    const generatedAt = new Date().toISOString();
    const cold = [];
    const coldCaches = [];
    for (let index = 0; index < RUNS; index += 1) {
      const cacheRoot = path.join(temporary, `cold-cache-${index + 1}`);
      coldCaches.push(cacheRoot);
      cold.push(
        await measuredRun({
          temporary,
          sourceRepository: path.resolve(options.source_repository),
          repository: options.repository,
          commit: options.commit,
          cacheRoot,
          label: `cold-checkout-${index + 1}`,
          recordedAt: new Date(
            Date.parse(generatedAt) + index * 1000,
          ).toISOString(),
        }),
      );
    }
    const warm = [];
    for (let index = 0; index < RUNS; index += 1) {
      warm.push(
        await measuredRun({
          temporary,
          sourceRepository: path.resolve(options.source_repository),
          repository: options.repository,
          commit: options.commit,
          cacheRoot: coldCaches[0],
          label: `warm-checkout-${index + 1}`,
          recordedAt: new Date(
            Date.parse(generatedAt) + (RUNS + index) * 1000,
          ).toISOString(),
        }),
      );
    }
    const coldMedianMs = median(cold.map((run) => run.wallElapsedMs));
    const warmMaximumMs = Math.max(...warm.map((run) => run.wallElapsedMs));
    const body = {
      schema: 'kungfu.qualified-assignment-core-cold-path-benchmark/v1',
      authority: 'optimization-evidence-only',
      generatedAt,
      source: {
        repository: options.repository,
        commit: options.commit,
        consumerModuleRoot: digest(
          fs.readFileSync(
            new URL(
              '../../../framework/work/assignment-capture/qualified-assignment-core-consumer.mjs',
              import.meta.url,
            ),
          ),
        ),
      },
      host: {
        platform: process.platform,
        architecture: process.arch,
        osRelease: os.release(),
        node: process.version,
      },
      provider: {
        kind: 'office-http-artifact',
        authority: 'transport-only',
        endpointRetained: false,
      },
      thresholdsMs: {
        coldMedian: COLD_LIMIT_MS,
        warmEach: WARM_LIMIT_MS,
      },
      runs: { cold, retainedLocalCas: warm },
      result: {
        coldMedianMs,
        coldQualified: coldMedianMs <= COLD_LIMIT_MS,
        warmMaximumMs,
        warmQualified:
          warm.length === RUNS &&
          warm.every((run) => run.wallElapsedMs <= WARM_LIMIT_MS),
      },
    };
    const evidence = { ...body, evidenceRoot: digest(body) };
    fs.mkdirSync(path.dirname(path.resolve(options.output)), {
      recursive: true,
    });
    fs.writeFileSync(
      path.resolve(options.output),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { flag: 'wx' },
    );
    console.log(JSON.stringify(evidence, null, 2));
    if (!evidence.result.coldQualified || !evidence.result.warmQualified) {
      process.exitCode = 1;
    }
  } finally {
    if (previousHttp === undefined) {
      Reflect.deleteProperty(
        process.env,
        'KUNGFU_QUALIFIED_CORE_HTTP_BASE_URL',
      );
    } else {
      process.env.KUNGFU_QUALIFIED_CORE_HTTP_BASE_URL = previousHttp;
    }
    if (previousBundle === undefined) {
      Reflect.deleteProperty(process.env, 'KUNGFU_QUALIFIED_CORE_BUNDLE');
    } else {
      process.env.KUNGFU_QUALIFIED_CORE_BUNDLE = previousBundle;
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
