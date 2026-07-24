// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONTRACT_ENVELOPE_PATH,
  writeRegistryEnvelope,
} from './registry-envelope.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_PATH = path.join(
  ROOT,
  'framework/work-lifecycle/kungfu-work-lifecycle-operation-matrix.contract.json',
);
const DOC_PATH = path.join(
  ROOT,
  'docs/architecture/work-lifecycle-operation-matrix.md',
);
const POLICY_SOURCE_PATH = path.join(
  ROOT,
  'framework/contract/kungfu-agent-first-canonical-policy.json',
);
const POLICY_ARTIFACT_PATH = path.join(
  ROOT,
  'config/kungfu-agent-first-canonical-policy.json',
);

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function renderWorkLifecycleOperationMatrix(contract) {
  const rows = contract.operations.map((operation) => {
    const parity = ['cpp', 'python', 'node', 'rust']
      .map((language) => `${language}=${operation.currentParity[language]}`)
      .join('<br>');
    const native = `${operation.native.status}: ${operation.native.interface}${
      operation.native.operations.length > 0
        ? `<br>${operation.native.operations.join(', ')}`
        : ''
    }`;
    return `| \`${escapeCell(operation.id)}\` | ${escapeCell(operation.layer)} | ${escapeCell(operation.capability)} | ${escapeCell(operation.authorityOwner)} | ${escapeCell(native)} | ${escapeCell(parity)} |`;
  });

  return `# Work lifecycle operation matrix

This document is a generated projection of
[\`kungfu-work-lifecycle-operation-matrix.contract.json\`](../../framework/work-lifecycle/kungfu-work-lifecycle-operation-matrix.contract.json).
Edit the machine contract and rerun the renderer; do not edit the table by hand.

The matrix separates current evidence from the common four-language target.
\`proved\` means the repository contains a checked public path to the declared
authority. \`partial\` means a host or substrate exists but the full public
lifecycle operation is not proved. \`missing\` is an explicit gap.
\`not-applicable\` records a current declarative surface; it does not waive the
target requirement.

| Stable operation id | Layer | Capability | Sole authority owner | Current native route | Current language parity |
| --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

## Authority boundaries

${contract.boundaries.map((boundary) => `- ${boundary}`).join('\n')}

## Non-claims

${contract.nonClaims.map((claim) => `- ${claim}`).join('\n')}
`;
}

export function readContract() {
  return JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
}

function main() {
  const args = new Set(process.argv.slice(2));
  const rendered = renderWorkLifecycleOperationMatrix(readContract());
  if (args.has('--sync-artifacts')) {
    writeRegistryEnvelope(CONTRACT_ENVELOPE_PATH, {
      projectionIds: ['work-lifecycle-operation-matrix'],
    });
    fs.copyFileSync(POLICY_SOURCE_PATH, POLICY_ARTIFACT_PATH);
    console.log(
      '[work-lifecycle-matrix] synchronized registry-welded contract artifacts',
    );
    return;
  }
  if (args.has('--write')) {
    fs.writeFileSync(DOC_PATH, rendered);
    console.log(
      `[work-lifecycle-matrix] wrote ${path.relative(ROOT, DOC_PATH)}`,
    );
    return;
  }
  if (args.has('--check')) {
    const current = fs.existsSync(DOC_PATH)
      ? fs.readFileSync(DOC_PATH, 'utf8')
      : '';
    if (current !== rendered) {
      throw new Error(
        'Work lifecycle operation matrix documentation is stale; run ./shifu exec node scripts/render-work-lifecycle-operation-matrix.mjs --write',
      );
    }
    console.log('[work-lifecycle-matrix] documentation matches contract');
    return;
  }
  process.stdout.write(rendered);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
