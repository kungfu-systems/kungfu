#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = 'docs/toolchain.contract.json';

export function checkDocsToolchain(root = ROOT) {
  const contract = JSON.parse(
    fs.readFileSync(path.join(root, CONTRACT), 'utf8'),
  );
  const findings = [];
  const add = (message) =>
    findings.push({ code: 'docs-toolchain', file: CONTRACT, line: 1, message });
  if (contract.schemaVersion !== 1) add('unsupported schemaVersion');
  if (!fs.existsSync(path.join(root, contract.node?.versionFile || '')))
    add('pinned Node version file is missing');
  if (!fs.existsSync(path.join(root, contract.node?.packageLock || '')))
    add('documentation package lock is missing');
  if (!/^.+@sha256:[0-9a-f]{64}$/.test(contract.vale?.container || ''))
    add('Vale container must use an immutable digest');
  for (const [platform, archive] of Object.entries(
    contract.vale?.archives || {},
  )) {
    if (!archive.name || !/^[0-9a-f]{64}$/.test(archive.sha256 || ''))
      add(`Vale archive is not checksum-pinned: ${platform}`);
  }
  for (const [workflow, actionName, expected] of [
    [
      '.github/workflows/docs-check.yml',
      'actions/checkout',
      contract.githubActions?.['actions/checkout'],
    ],
    [
      '.github/workflows/docs-external-links.yml',
      'actions/checkout',
      contract.githubActions?.['actions/checkout'],
    ],
    [
      '.github/workflows/docs-external-links.yml',
      'lycheeverse/lychee-action',
      contract.githubActions?.['lycheeverse/lychee-action'],
    ],
  ]) {
    const text = fs.readFileSync(path.join(root, workflow), 'utf8');
    for (const match of text.matchAll(/^\s*uses:\s*([^\s#]+)\s*(?:#.*)?$/gm))
      if (!/@[0-9a-f]{40}$/.test(match[1]))
        add(`${workflow} contains a mutable Action ref: ${match[1]}`);
    if (!expected || !text.includes(`uses: ${actionName}@${expected.sha}`))
      add(`${workflow} does not use the contracted ${actionName} SHA`);
  }
  return findings;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const findings = checkDocsToolchain();
  if (findings.length) {
    for (const finding of findings)
      console.error(
        `${finding.file}:${finding.line} [${finding.code}] ${finding.message}`,
      );
    process.exit(1);
  }
  console.log(
    '[docs:toolchain] immutable action, container, and archive pins passed',
  );
}
