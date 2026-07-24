#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';

import {
  ADR_MAP_PATH,
  AGENT_INDEX_PATH,
  BUNDLE_PATH,
  REPO_ROOT,
  SCHEMA_PATH,
  assertRelativeSourcePath,
  fileRoot,
  internalContentRoot,
  readJson,
} from './lib.mjs';

function check(condition, message, failures) {
  if (!condition) failures.push(message);
}

function main() {
  const failures = [];
  for (const file of [
    SCHEMA_PATH,
    BUNDLE_PATH,
    AGENT_INDEX_PATH,
    ADR_MAP_PATH,
  ]) {
    check(
      fs.existsSync(file),
      `missing ${path.relative(REPO_ROOT, file)}`,
      failures,
    );
  }
  if (failures.length) throw new Error(failures.join('; '));
  const schema = readJson(SCHEMA_PATH);
  const bundle = readJson(BUNDLE_PATH);
  const agentIndex = readJson(AGENT_INDEX_PATH);
  const adrMap = readJson(ADR_MAP_PATH);
  check(
    bundle.contract === 'kungfu.site-bundle/v1',
    'bundle contract drifted',
    failures,
  );
  check(bundle.schemaVersion === 1, 'bundle schema version drifted', failures);
  check(
    bundle.package?.name === '@kungfu-tech/site',
    'package identity drifted',
    failures,
  );
  check(
    schema.properties?.contract?.const === bundle.contract,
    'schema and bundle contract drifted',
    failures,
  );
  check(
    internalContentRoot(bundle) === bundle.contentRoot,
    'bundle content root mismatch',
    failures,
  );
  check(
    fileRoot(ADR_MAP_PATH) === bundle.adrMap?.contentRoot,
    'ADR map digest mismatch',
    failures,
  );
  check(
    adrMap.schema === bundle.adrMap?.contract,
    'ADR map contract mismatch',
    failures,
  );
  check(
    adrMap.summary?.records === bundle.adrMap?.summary?.records,
    'ADR map summary mismatch',
    failures,
  );
  check(
    agentIndex.bundleContentRoot === bundle.contentRoot &&
      agentIndex.sourceRoot === bundle.sourceRoot,
    'agent index is not bound to the exact bundle',
    failures,
  );
  check(
    agentIndex.readingOrder?.length === bundle.surfaces?.length,
    'agent reading order does not cover every surface',
    failures,
  );
  const sourceIds = new Set(bundle.sources?.map((entry) => entry.id));
  for (const source of bundle.sources || []) {
    const absolute = assertRelativeSourcePath(source.path);
    check(
      fileRoot(absolute) === source.contentRoot,
      `source digest drifted: ${source.path}`,
      failures,
    );
    check(
      source.url ===
        `${bundle.source.repository}/blob/${bundle.source.revision}/${source.path}`,
      `source URL drifted: ${source.path}`,
      failures,
    );
  }
  const surfaceIds = new Set();
  const routes = new Set();
  for (const surface of bundle.surfaces || []) {
    check(
      !surfaceIds.has(surface.id),
      `duplicate surface id ${surface.id}`,
      failures,
    );
    check(
      !routes.has(surface.route),
      `duplicate surface route ${surface.route}`,
      failures,
    );
    surfaceIds.add(surface.id);
    routes.add(surface.route);
    check(
      surface.knownLimits?.length > 0,
      `${surface.id} has no known limits`,
      failures,
    );
    check(
      surface.sourceIds?.length > 0,
      `${surface.id} has no source bindings`,
      failures,
    );
    for (const sourceId of surface.sourceIds || []) {
      check(
        sourceIds.has(sourceId),
        `${surface.id} has unknown source ${sourceId}`,
        failures,
      );
    }
  }
  for (const id of [
    'overview',
    'format',
    'primitives',
    'runtime',
    'abi',
    'sdk',
    'extensions',
    'products',
    'qualification',
    'decisions',
    'horizons',
  ]) {
    check(
      surfaceIds.has(id),
      `required product surface missing: ${id}`,
      failures,
    );
  }
  check(
    bundle.surfaces.find((entry) => entry.id === 'format')?.maturity ===
      'pre-normative',
    '.kungfu portable format must remain pre-normative',
    failures,
  );
  check(
    bundle.surfaces.find((entry) => entry.id === 'primitives')?.maturity ===
      'qualified-shadow',
    'primitive runtime must remain qualified-shadow',
    failures,
  );
  check(
    bundle.nonClaims?.some((entry) => entry.includes('Spec 0.1')),
    'Spec 0.1 non-claim is missing',
    failures,
  );
  check(
    bundle.nonClaims?.some((entry) => entry.includes('navigation only')),
    'ADR navigation authority boundary is missing',
    failures,
  );
  if (failures.length) {
    throw new Error(
      `site bundle verification failed:\n- ${failures.join('\n- ')}`,
    );
  }
  console.log(
    `[site:verify] passing; surfaces=${bundle.surfaces.length}; sources=${bundle.sources.length}; ADRs=${adrMap.summary.records}`,
  );
}

main();
