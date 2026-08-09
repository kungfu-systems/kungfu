#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
export const KFD4_QUALIFICATION_PATH =
  'docs/qualification/evidence/kfd-4-perspective/d73cab0d69/report.json';
const EXPECTED_BINDINGS = [
  'framework/core/src/python/kungfu/rewind/perspective.py',
  'framework/core/tests/python/test_kfd4_perspective.py',
];
const EXPECTED_NEGATIVES = [
  'causal-inversion',
  'flattened-observer',
  'missing-evidence',
  'undeclared-fact-cut',
  'undeclared-replay-loss',
  'unknown-policy-version',
];
const EXPECTED_PRESERVATION = [
  'accepted-fact-cut',
  'causal-order',
  'consequences',
  'evidence-boundary',
  'known-gaps',
  'natural-objects',
  'observer',
];

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function semanticRoot(value) {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function fileRoot(filePath) {
  return `sha256:${createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function without(value, keys) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  );
}

function requireThat(condition, message) {
  if (!condition) throw new Error(`KFD-4 qualification: ${message}`);
}

function exactStrings(actual, expected, label) {
  requireThat(Array.isArray(actual), `${label} must be an array`);
  requireThat(
    [...actual].sort().join('\n') === [...expected].sort().join('\n'),
    `${label} drifted`,
  );
}

function validateSource(report, root) {
  const source = report.source || {};
  requireThat(
    source.repository === 'kungfu-systems/kungfu',
    'source repository drifted',
  );
  requireThat(
    /^[0-9a-f]{40}$/u.test(source.implementationRevision || ''),
    'implementation revision must be a full Git SHA',
  );
  const bindings = source.bindings || [];
  exactStrings(
    bindings.map((entry) => entry.path),
    EXPECTED_BINDINGS,
    'source bindings',
  );
  for (const binding of bindings) {
    const resolved = path.resolve(root, binding.path);
    requireThat(
      resolved.startsWith(`${root}${path.sep}`) && fs.existsSync(resolved),
      `source binding is missing or escapes the checkout: ${binding.path}`,
    );
    requireThat(
      binding.sha256 === fileRoot(resolved),
      `source binding root drifted: ${binding.path}`,
    );
  }
  requireThat(
    source.deliveryBinding?.mode === 'content-addressed-retained-provenance',
    'implementation delivery binding mode drifted',
  );
  requireThat(
    source.deliveryBinding.root ===
      semanticRoot(without(source, ['deliveryBinding'])),
    'implementation delivery binding root drifted',
  );
}

function validateNative(native) {
  requireThat(
    native?.authority === 'yijinjing-journal',
    'native authority drifted',
  );
  requireThat(
    native.sourceRegistryRebuild?.ok === true,
    'native rebuild did not pass',
  );
  requireThat(
    native.sourceRegistryFsck?.ok === true &&
      native.sourceRegistryFsck?.status === 'ok' &&
      native.sourceRegistryFsck?.projectionStatus === 'ok',
    'native source registry fsck did not pass',
  );
  requireThat(
    native.sourceRegistryFsck.root ===
      semanticRoot(without(native.sourceRegistryFsck, ['root'])),
    'native source registry fsck root drifted',
  );
  requireThat(
    native.build?.git?.pristine === true &&
      /^[0-9a-f]{40}$/u.test(native.build?.git?.revision || ''),
    'native build must retain one pristine full-SHA source',
  );
  const admissions = native.factAdmissions || [];
  requireThat(
    admissions.length === 3,
    'native qualification must admit three facts',
  );
  exactStrings(
    admissions.map((entry) => entry.observationId),
    ['fact-a1', 'fact-a2', 'fact-b1'],
    'native fact admissions',
  );
  for (const admission of admissions) {
    requireThat(
      admission.outcome === 'admitted',
      'native fact admission failed',
    );
    requireThat(
      admission.receiptRoot ===
        semanticRoot(without(admission, ['receiptRoot'])),
      `native fact receipt drifted: ${admission.observationId}`,
    );
  }
}

function validateProjection(projection) {
  const perspective = projection?.perspective || {};
  requireThat(
    perspective.contract === 'kfd-4-observer-perspective' &&
      perspective.standard === 'kfd-4',
    'observer perspective contract drifted',
  );
  requireThat(
    perspective.verification?.result === 'pass' &&
      projection.fsck?.status === 'passed',
    `projection did not pass: ${perspective.id || '<unknown>'}`,
  );
  requireThat(
    projection.viewRoot ===
      semanticRoot(without(projection, ['viewRoot', 'fsck'])),
    `projection view root drifted: ${perspective.id || '<unknown>'}`,
  );
  requireThat(
    projection.fsck.root === semanticRoot(without(projection.fsck, ['root'])),
    `projection fsck root drifted: ${perspective.id || '<unknown>'}`,
  );
  const facts = projection.facts || [];
  exactStrings(
    facts.map((fact) => fact.id),
    ['fact-a1', 'fact-a2', 'fact-b1'],
    'projection fact set',
  );
  const positions = Object.fromEntries(
    (projection.order || []).map((factId, index) => [factId, index]),
  );
  requireThat(
    positions['fact-b1'] < positions['fact-a2'],
    'projection inverted the declared causal edge',
  );
  requireThat(
    new Set((projection.acceptedCuts || []).map((cut) => cut.sourceId)).size ===
      2,
    'projection must retain two accepted source cuts',
  );
}

function validateReplay(replay, expectedMode, expectedViews) {
  requireThat(
    replay?.document?.mode === expectedMode,
    `${expectedMode} mode drifted`,
  );
  requireThat(
    replay.document?.verification?.result === 'pass' &&
      replay.fsck?.status === 'passed',
    `${expectedMode} replay did not pass`,
  );
  requireThat(
    replay.fsck.root === semanticRoot(without(replay.fsck, ['root'])),
    `${expectedMode} replay fsck root drifted`,
  );
  requireThat(
    replay.document.sourceViews?.length === expectedViews,
    `${expectedMode} replay view count drifted`,
  );
  exactStrings(
    replay.document.reconstruction?.preservedElements,
    EXPECTED_PRESERVATION,
    `${expectedMode} preserved elements`,
  );
  requireThat(
    replay.document.reconstruction?.declaredLoss?.length > 0,
    `${expectedMode} replay lost its declared-loss boundary`,
  );
}

export function validateKfd4PerspectiveQualification(
  report,
  { root = ROOT } = {},
) {
  requireThat(
    report?.schema === 'kungfu.kfd-4-perspective-qualification/v1' &&
      report.standard === 'kfd-4' &&
      report.candidateOnly === true,
    'report identity or candidate boundary drifted',
  );
  requireThat(
    JSON.stringify(report.verdict) ===
      JSON.stringify({
        qualifying: false,
        releaseQualification: 'not-qualified',
        selfCertified: false,
        shippedSupport: false,
        status: 'passed',
      }),
    'verdict must remain passed but non-qualifying, non-self-certified, and non-shipped',
  );
  validateSource(report, root);
  validateNative(report.native);
  requireThat(
    report.perspectives?.length === 2,
    'exactly two perspectives are required',
  );
  report.perspectives.forEach(validateProjection);
  const observers = report.perspectives.map(
    (projection) => projection.perspective.observer.id,
  );
  requireThat(
    new Set(observers).size === 2,
    'observer identities were flattened',
  );
  requireThat(
    report.perspectives[0].viewRoot !== report.perspectives[1].viewRoot &&
      report.perspectives[0].order.join(',') !==
        report.perspectives[1].order.join(','),
    'observer-relative projections must retain distinct concurrent order',
  );
  validateReplay(
    report.perspectivePreservingReplay,
    'perspective-preserving',
    1,
  );
  validateReplay(report.contrastiveReplay, 'contrastive', 2);
  exactStrings(
    report.contrastiveReplay.document.sourceViews.map((view) => view.observer),
    observers,
    'contrastive replay observers',
  );
  exactStrings(
    (report.negativeCases || []).map((entry) => entry.id),
    EXPECTED_NEGATIVES,
    'negative cases',
  );
  for (const negative of report.negativeCases) {
    requireThat(
      negative.expected === 'failed' &&
        negative.observed === 'failed' &&
        negative.issueCodes?.length > 0,
      `negative case did not fail closed: ${negative.id}`,
    );
  }
  requireThat(
    report.qualificationRoot ===
      semanticRoot(without(report, ['qualificationRoot'])),
    'qualification root drifted',
  );
  return {
    ok: true,
    standard: 'kfd-4',
    qualificationRoot: report.qualificationRoot,
    implementationRevision: report.source.implementationRevision,
    nativeRevision: report.native.build.git.revision,
    perspectiveCount: report.perspectives.length,
    negativeCaseCount: report.negativeCases.length,
    qualifying: false,
    selfCertified: false,
    shippedSupport: false,
  };
}

export function loadKfd4PerspectiveQualification({ root = ROOT } = {}) {
  const reportPath = path.join(root, KFD4_QUALIFICATION_PATH);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  return {
    path: reportPath,
    report,
    validation: validateKfd4PerspectiveQualification(report, { root }),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = loadKfd4PerspectiveQualification();
    process.stdout.write(`${JSON.stringify(result.validation, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
