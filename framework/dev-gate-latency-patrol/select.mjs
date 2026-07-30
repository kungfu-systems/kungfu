#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import candidateTimeline from '../../scripts/candidate-timeline-events.cjs';

const { isAdmittedDevBranch } = candidateTimeline;

function jsonRoot(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')}`;
}

export function selectMonitoredBranches({
  eventName,
  refName = '',
  refProtected = false,
  requestedBranch = '',
  protectedBranches = [],
}) {
  const admitted = [...new Set(protectedBranches)]
    .filter((branch) => isAdmittedDevBranch(branch))
    .sort();
  let branches;
  if (eventName === 'push') {
    if (!refProtected || !isAdmittedDevBranch(refName))
      throw new Error('push target is not a protected admitted dev branch');
    branches = [refName];
  } else if (eventName === 'schedule') {
    branches = admitted;
  } else if (eventName === 'workflow_dispatch') {
    if (requestedBranch) {
      if (!admitted.includes(requestedBranch))
        throw new Error('requested branch is not protected and admitted');
      branches = [requestedBranch];
    } else {
      branches = admitted;
    }
  } else {
    throw new Error(`untrusted latency Patrol event: ${eventName}`);
  }
  if (!branches.length)
    throw new Error('no protected admitted dev branches were discovered');
  const body = {
    schema: 'kungfu.dev-gate-latency-patrol.plan/v1',
    eventName,
    requiredGate: false,
    issueAdmission: 'prohibited',
    windowSize: 30,
    branches,
  };
  return { ...body, planRoot: jsonRoot(body) };
}

export async function discoverProtectedBranches(
  repository,
  token,
  fetchImpl = fetch,
) {
  if (!/^[^/]+\/[^/]+$/u.test(repository))
    throw new Error('repository must be owner/name');
  if (!token) throw new Error('GitHub token is required');
  const branches = [];
  for (let page = 1; ; page += 1) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/branches?protected=true&per_page=100&page=${page}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'kungfu-dev-gate-latency-patrol',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    if (!response.ok)
      throw new Error(
        `GitHub protected branch discovery failed with ${response.status}`,
      );
    const pageRows = await response.json();
    if (!Array.isArray(pageRows))
      throw new Error('GitHub protected branch discovery returned non-array');
    branches.push(...pageRows.map(({ name }) => name).filter(Boolean));
    if (pageRows.length < 100) break;
  }
  return branches;
}

export function parseArgs(argv) {
  const result = {
    eventName: '',
    refName: '',
    refProtected: false,
    requestedBranch: '',
    repository: '',
    output: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--event-name') result.eventName = argv[++index] || '';
    else if (arg === '--ref-name') result.refName = argv[++index] || '';
    else if (arg === '--ref-protected')
      result.refProtected = (argv[++index] || '') === 'true';
    else if (arg === '--requested-branch')
      result.requestedBranch = argv[++index] || '';
    else if (arg === '--repository') result.repository = argv[++index] || '';
    else if (arg === '--output') result.output = argv[++index] || '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const field of ['eventName', 'repository', 'output'])
    if (!result[field])
      throw new Error(
        `--${field.replace(/[A-Z]/gu, (char) => `-${char.toLowerCase()}`)} is required`,
      );
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const protectedBranches = await discoverProtectedBranches(
      options.repository,
      process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
    );
    const plan = selectMonitoredBranches({ ...options, protectedBranches });
    fs.mkdirSync(path.dirname(path.resolve(options.output)), {
      recursive: true,
    });
    fs.writeFileSync(options.output, `${JSON.stringify(plan, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({ branches: plan.branches, planRoot: plan.planRoot })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 2;
  }
}
