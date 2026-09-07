#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { restoreKfdPrebuiltLayerArtifact } from '@kungfu-tech/product-kungfu/release/kfd-candidate-evidence';
import { runShifuWithCache } from './run-shifu-lifecycle.mjs';
import { writeShifuGateEvidence } from './shifu-gate-evidence.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const REPORT_ROOT = path.join(ROOT, 'product', 'release', 'qualification');

export function layerArtifactStages(
  layer,
  { usePrebuiltArtifacts = false } = {},
) {
  const definitions = {
    format: [
      ['pack:spec'],
      [
        'layers:qualify:format',
        '--',
        '--report',
        'product/release/qualification/layer-format-report.json',
      ],
    ],
    sdk: [
      ['pack:sdk'],
      [
        'layers:qualify:sdk',
        '--',
        '--report',
        'product/release/qualification/layer-sdk-report.json',
      ],
    ],
    surfaces: [
      ['pack:npm-release-inventory'],
      [
        'layers:qualify:surfaces',
        '--',
        '--report',
        'product/release/qualification/layer-surface-report.json',
      ],
    ],
  };
  if (!definitions[layer])
    throw new Error(`unknown layer artifact Gate '${layer}'`);
  return usePrebuiltArtifacts
    ? definitions[layer].slice(1)
    : definitions[layer];
}

function reportFile(layer) {
  const name = layer === 'surfaces' ? 'surface' : layer;
  return path.join(REPORT_ROOT, `layer-${name}-report.json`);
}

export function runLayerArtifactGate(
  layer,
  {
    run = runShifuWithCache,
    env = process.env,
    restore = restoreKfdPrebuiltLayerArtifact,
  } = {},
) {
  const usePrebuiltArtifacts =
    env.KUNGFU_VERIFY_PREBUILT_RELEASE_ARTIFACTS === '1';
  if (usePrebuiltArtifacts) restore({ root: ROOT, layer });
  for (const args of layerArtifactStages(layer, { usePrebuiltArtifacts })) {
    const status = run(args, { env });
    if (status !== 0) return status;
  }
  writeShifuGateEvidence({
    schema: 'kungfu.layer-qualification.gate-evidence/v1',
    pointers: [
      { id: `${layer}-qualification-report`, file: reportFile(layer) },
    ],
    root: ROOT,
    evidenceFile: env.SHIFU_GATE_EVIDENCE_FILE,
  });
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    console.error(
      'usage: node scripts/run-layer-artifact-gate.mjs <format|sdk|surfaces>',
    );
    return 2;
  }
  return runLayerArtifactGate(argv[0]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main());
