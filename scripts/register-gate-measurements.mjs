#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateDefinitionDigest, gateDigest } from './shifu-gate-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COVERAGE = path.join(
  ROOT,
  'docs/qualification/gates/measurement-coverage.json',
);

function fail(message) {
  throw new Error(`[register-measurements] ${message}`);
}

function sameSet(actual, expected) {
  return (
    actual.length === new Set(actual).size &&
    [...actual].sort().join('\0') === [...expected].sort().join('\0')
  );
}

function main() {
  const inputs = process.argv.slice(2);
  if (!inputs.length) fail('provide one or more Gate receipt paths');
  const registry = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'shifu.gates.json'), 'utf8'),
  );
  const coverage = JSON.parse(fs.readFileSync(COVERAGE, 'utf8'));
  const gates = new Map(registry.gates.map((gate) => [gate.id, gate]));
  const candidates = new Map();

  for (const input of inputs) {
    const receiptPath = path.resolve(input);
    const relative = path.relative(ROOT, receiptPath).split(path.sep).join('/');
    if (
      relative.startsWith('../') ||
      !relative.startsWith('docs/qualification/evidence/')
    )
      fail(`${input} is outside the retained evidence tree`);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (receipt.schema === 'shifu.gate-receipt/v1') {
      if (
        receipt.source?.dirty !== false ||
        !/^[0-9a-f]{40}$/.test(receipt.source.sha || '')
      )
        fail(`${relative} is not bound to a clean source`);
      for (const result of receipt.results || []) {
        if (
          result.attempted !== true ||
          result.status !== 'pass' ||
          result.exitCode !== 0
        )
          continue;
        const gate = gates.get(result.gateId);
        if (!gate || gate.action?.kind === 'handler') continue;
        if (result.definitionDigest !== gateDefinitionDigest(gate))
          fail(`${relative} has a stale definition for ${result.gateId}`);
        const key = `${result.gateId}\0${receipt.source.sha}\0${receipt.registry.digest}`;
        const group = candidates.get(key) || {
          gate,
          sourceSha: receipt.source.sha,
          registryDigest: receipt.registry.digest,
          observations: new Map(),
        };
        group.observations.set(receipt.environment.platform, {
          platform: receipt.environment.platform,
          sourceSha: receipt.source.sha,
          registryDigest: receipt.registry.digest,
          durationMs: result.durationMs,
          receipt: relative,
        });
        candidates.set(key, group);
      }
      continue;
    }
    if (receipt.schema === 'kungfu.gate-controller-receipt/v1') {
      const gate = gates.get(receipt.gateId);
      if (!gate || gate.action?.kind !== 'handler')
        fail(`${relative} is not for a current handler Gate`);
      if (receipt.definitionDigest !== gateDefinitionDigest(gate))
        fail(`${relative} has a stale definition for ${receipt.gateId}`);
      const key = `${receipt.gateId}\0${receipt.source.sha}\0${receipt.registry.digest}`;
      const group = candidates.get(key) || {
        gate,
        sourceSha: receipt.source.sha,
        registryDigest: receipt.registry.digest,
        observations: new Map(),
      };
      group.observations.set(receipt.environment.platform, {
        platform: receipt.environment.platform,
        sourceSha: receipt.source.sha,
        registryDigest: receipt.registry.digest,
        durationMs: receipt.durationMs,
        receipt: relative,
      });
      candidates.set(key, group);
      continue;
    }
    fail(`${relative} has an unsupported receipt schema`);
  }

  const records = new Map(
    coverage.measurements.map((record) => [record.gateId, record]),
  );
  let registered = 0;
  for (const group of candidates.values()) {
    const observations = [...group.observations.values()].sort((left, right) =>
      left.platform.localeCompare(right.platform),
    );
    if (
      !sameSet(
        observations.map((item) => item.platform),
        group.gate.platforms,
      )
    )
      continue;
    records.set(group.gate.id, {
      gateId: group.gate.id,
      definitionDigest: gateDefinitionDigest(group.gate),
      observations,
    });
    registered += 1;
  }
  if (!registered) fail('no complete current Gate measurement sets were found');

  const order = new Map(registry.gates.map((gate, index) => [gate.id, index]));
  coverage.measurements = [...records.values()].sort(
    (left, right) => order.get(left.gateId) - order.get(right.gateId),
  );
  const measured = new Set(
    coverage.measurements.map((record) => record.gateId),
  );
  coverage.baseline.unmeasuredGateIds = coverage.baseline.unmeasuredGateIds
    .filter((gateId) => !measured.has(gateId))
    .sort();
  coverage.baseline.digest = gateDigest(coverage.baseline.unmeasuredGateIds);
  fs.writeFileSync(COVERAGE, `${JSON.stringify(coverage, null, 2)}\n`);
  console.log(
    `[register-measurements] registered ${registered} complete Gate sets; ${coverage.baseline.unmeasuredGateIds.length} baseline Gates remain`,
  );
}

main();
