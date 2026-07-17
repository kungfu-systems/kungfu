#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateDefinitionDigest, gateDigest } from './shifu-gate-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  throw new Error(`[controller-measurement] ${message}`);
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) fail(`${name} is required`);
  return process.argv[index + 1];
}

function apiJson(repository, endpoint) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    fail('repository must be OWNER/REPO');
  try {
    return JSON.parse(
      childProcess.execFileSync(
        'gh',
        ['api', `repos/${repository}/${endpoint}`],
        {
          cwd: ROOT,
          encoding: 'utf8',
        },
      ),
    );
  } catch {
    fail(`cannot read GitHub API endpoint ${endpoint}`);
  }
}

function sourceJson(sourceSha, relative) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha))
    fail('source SHA must be a full Git SHA');
  try {
    return JSON.parse(
      childProcess.execFileSync('git', ['show', `${sourceSha}:${relative}`], {
        cwd: ROOT,
        encoding: 'utf8',
      }),
    );
  } catch {
    fail(`cannot read ${relative} from source ${sourceSha}`);
  }
}

function workflowPath(value) {
  return String(value || '').replace(/^\.\/|@.+$/g, '');
}

function durationMs(startedAt, finishedAt) {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(finished) ||
    finished < started
  )
    fail('job timestamps are invalid');
  return finished - started;
}

function main() {
  const gateId = option('--gate');
  const bindingId = option('--binding');
  const platform = option('--platform');
  const repository = option('--repository');
  const runId = option('--run-id');
  const jobId = option('--job-id');
  if (!/^\d+$/.test(runId) || !/^\d+$/.test(jobId))
    fail('run and job ids must be positive integers');
  const run = apiJson(repository, `actions/runs/${runId}`);
  const job = apiJson(repository, `actions/jobs/${jobId}`);
  const output = path.resolve(option('--output'));
  const sourceSha = String(run.head_sha || '');
  if (job.head_sha !== sourceSha) fail('run and job source SHAs differ');
  if (job.run_id !== run.id)
    fail('job does not belong to the supplied workflow run');
  if (run.status !== 'completed') fail('workflow run must be completed');
  if (job.status !== 'completed' || job.conclusion !== 'success')
    fail('controller job must be a completed success');

  const registry = sourceJson(sourceSha, 'shifu.gates.json');
  const bindings = sourceJson(
    sourceSha,
    'docs/qualification/gates/workflow-bindings.json',
  );
  const gate = registry.gates.find((item) => item.id === gateId);
  if (!gate) fail(`source does not define Gate ${gateId}`);
  if (gate.action?.kind !== 'handler') fail(`${gateId} is not a handler Gate`);
  if (!gate.platforms.includes(platform))
    fail(`${gateId} does not declare platform ${platform}`);
  const binding = bindings.bindings.find((item) => item.id === bindingId);
  if (!binding) fail(`source does not define binding ${bindingId}`);
  if (binding.execution !== 'controller' || !binding.gates.includes(gateId))
    fail(`${bindingId} is not a controller binding for ${gateId}`);
  if (workflowPath(run.path) !== workflowPath(binding.workflow))
    fail(`workflow path does not match binding ${bindingId}`);
  if (
    job.name !== binding.job &&
    !job.name.endsWith(` / ${binding.job}`) &&
    !job.name.startsWith(`${binding.job} / `)
  )
    fail(`job name '${job.name}' does not match binding job '${binding.job}'`);

  const receipt = {
    $schema:
      'https://libkungfu.dev/schemas/shifu/gate-controller-receipt-v1.schema.json',
    schema: 'kungfu.gate-controller-receipt/v1',
    gateId,
    definitionDigest: gateDefinitionDigest(gate),
    source: { sha: sourceSha, dirty: false },
    registry: {
      ref: 'shifu.gates.json',
      digest: gateDigest(registry),
      projectId: registry.project.id,
    },
    environment: {
      platform,
      runnerName: job.runner_name,
      runnerLabels: [...new Set(job.labels || [])].sort(),
    },
    binding: {
      id: binding.id,
      workflow: binding.workflow,
      job: binding.job,
      adapterDigest: gateDigest(binding.adapter),
    },
    run: {
      repository: run.repository.full_name,
      workflowRunId: run.id,
      jobId: job.id,
      event: run.event,
      url: job.html_url,
    },
    startedAt: job.started_at,
    finishedAt: job.completed_at,
    durationMs: durationMs(job.started_at, job.completed_at),
    status: 'pass',
    attempted: true,
    conclusion: 'success',
  };
  const signed = { ...receipt, integrity: { digest: gateDigest(receipt) } };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(signed, null, 2)}\n`);
  console.log(
    `[controller-measurement] ${gateId}:${platform} ${signed.durationMs} ms -> ${path.relative(ROOT, output)}`,
  );
}

main();
