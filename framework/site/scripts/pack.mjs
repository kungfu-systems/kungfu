#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const siteRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(siteRoot, '..', '..');
const destination = path.join(repoRoot, 'product', 'release', 'site');

fs.mkdirSync(destination, { recursive: true });
const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(
  command,
  ['pack', '--foreground-scripts', '--pack-destination', destination],
  {
    cwd: siteRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'inherit'],
  },
);
if (result.error || result.status !== 0) {
  const output = result.stdout?.trim();
  if (output) console.error(output);
  console.error(
    `[site:pack] failed: ${result.error?.message || `npm pack exited ${result.status}`}`,
  );
  process.exit(1);
}
const filename = result.stdout.trim().split('\n').at(-1);
if (!filename) {
  console.error('[site:pack] failed: npm pack did not report an artifact');
  process.exit(1);
}
const artifact = path.join(destination, filename);
const consumerRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kungfu-site-consumer-'),
);
try {
  fs.writeFileSync(
    path.join(consumerRoot, 'package.json'),
    `${JSON.stringify({ private: true }, null, 2)}\n`,
  );
  const install = spawnSync(
    command,
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      artifact,
    ],
    {
      cwd: consumerRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (install.error || install.status !== 0) {
    throw new Error(
      install.stderr?.trim() ||
        install.error?.message ||
        `npm install exited ${install.status}`,
    );
  }
  const smoke = spawnSync(
    process.execPath,
    [
      '-e',
      [
        "const site=require('@kungfu-tech/site');",
        "const experience=site.renderProductSiteExperience({canonicalBaseUrl:'https://consumer.example',context:'Packed Consumer'});",
        'const receipt=site.verifySiteExperience(experience);',
        "require.resolve('@kungfu-tech/site/experience-schema');",
        "if(receipt.pages!==11||receipt.machineEntry!=='/agent-index.json')process.exit(2);",
        'process.stdout.write(receipt.contentRoot);',
      ].join(''),
    ],
    {
      cwd: consumerRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (smoke.error || smoke.status !== 0) {
    throw new Error(
      smoke.stderr?.trim() ||
        smoke.error?.message ||
        `consumer smoke exited ${smoke.status}`,
    );
  }
  console.log(`[site:pack] consumer-smoke=${smoke.stdout.trim()}`);
} catch (error) {
  console.error(`[site:pack] packed consumer failed: ${error.message}`);
  process.exit(1);
} finally {
  fs.rmSync(consumerRoot, { recursive: true, force: true });
}
console.log(`[site:pack] ${artifact}`);
