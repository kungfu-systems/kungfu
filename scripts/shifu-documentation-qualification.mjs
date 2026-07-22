#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runConsumerQualification } from './shifu-documentation-consumers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(
  ROOT,
  'docs',
  'qualification',
  'documentation-control-plane.receipt.json',
);

/** @param {any} value */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

/** @param {any} value */
function digest(value) {
  const bytes = `${JSON.stringify(canonical(value))}\n`;
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

/** @param {any} matrix */
export function validateQualificationMatrix(matrix) {
  const diagnostics = [];
  for (const authority of ['compiler', 'selector']) {
    if (
      !Array.isArray(matrix.authorities?.[authority]) ||
      matrix.authorities[authority].length !== 1 ||
      matrix.authorities[authority][0] !== 'xinfa'
    )
      diagnostics.push({ code: 'parallel-authority', authority });
  }
  for (const item of matrix.acceptance || []) {
    if (item.state !== 'proved' || !item.evidence?.length)
      diagnostics.push({ code: 'unproved-acceptance', id: item.id });
    for (const reference of item.evidence || [])
      if (!fs.existsSync(path.join(ROOT, reference)))
        diagnostics.push({
          code: 'missing-evidence',
          id: item.id,
          path: reference,
        });
  }
  for (const alias of matrix.compatibilityAliases || [])
    if (
      alias.documentationCompiler !== false ||
      !alias.owner ||
      !alias.parityGate ||
      !alias.sunset
    )
      diagnostics.push({ code: 'unbounded-compatibility-alias', id: alias.id });
  return diagnostics;
}

function productProbe(atlas) {
  const program = `
import json
from kungfu.agent import documentation
print(json.dumps(documentation.verify(${JSON.stringify(atlas)}), sort_keys=True))
`;
  const result = spawnSync('python3', ['-c', program], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONPATH: path.join(ROOT, 'framework', 'core', 'src', 'python'),
    },
  });
  if (result.status !== 0)
    throw new Error(
      `product Documentation Atlas probe failed: ${result.stderr}`,
    );
  return JSON.parse(result.stdout);
}

export function runDocumentationQualification() {
  const matrix = JSON.parse(
    fs.readFileSync(
      path.join(
        ROOT,
        'docs',
        'qualification',
        'documentation-control-plane.json',
      ),
      'utf8',
    ),
  );
  const selector = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, '.xinfa', 'product-documentation-pack.json'),
      'utf8',
    ),
  );
  const atlas = path.join(
    ROOT,
    '.xinfa',
    'baselines',
    'sha256',
    selector.atlasRoot.slice('sha256:'.length),
  );
  const product = productProbe(atlas);
  const consumers = runConsumerQualification();
  const diagnostics = validateQualificationMatrix(matrix);
  if (!product.valid)
    diagnostics.push({
      code: 'product-pack-invalid',
      diagnostics: product.diagnostics,
    });
  if (consumers.verdict !== 'pass')
    diagnostics.push({ code: 'consumer-qualification-failed' });
  if (
    product.atlasRoot !== selector.atlasRoot ||
    product.packRoot !== selector.contextPackRoot
  )
    diagnostics.push({ code: 'product-selector-drift' });
  const proof = {
    matrixRoot: digest(matrix),
    productRoots: {
      atlasRoot: product.atlasRoot,
      packRoot: product.packRoot,
      cutRoot: product.cutRoot,
      manifestRoot: product.manifestRoot,
      receiptRoot: product.receiptRoot,
    },
    consumerRoots: consumers.consumers.map((consumer) => ({
      id: consumer.id,
      ...consumer.roots,
    })),
    authorityConservation: matrix.authorities,
  };
  return {
    schema: 'kungfu.documentation-control-plane-qualification/v1',
    verdict: diagnostics.length ? 'fail' : 'pass',
    qualifying: false,
    matrixStatus: matrix.status,
    product,
    consumers,
    diagnostics,
    proof,
    proofRoot: digest(proof),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const receipt = runDocumentationQualification();
  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUTPUT, `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`${path.relative(ROOT, OUTPUT)} updated\n`);
  } else if (process.argv.includes('--check')) {
    const retained = fs.existsSync(OUTPUT)
      ? JSON.parse(fs.readFileSync(OUTPUT, 'utf8'))
      : null;
    if (
      !retained ||
      retained.verdict !== 'pass' ||
      retained.proofRoot !== receipt.proofRoot ||
      JSON.stringify(retained.proof) !== JSON.stringify(receipt.proof)
    ) {
      process.stderr.write(
        'documentation qualification receipt is stale; run with --write\n',
      );
      process.exit(1);
    }
    process.stdout.write('documentation qualification receipt current\n');
  } else {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  }
  if (receipt.verdict !== 'pass') process.exit(1);
}
