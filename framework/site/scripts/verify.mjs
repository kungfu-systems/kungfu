#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

import {
  ADR_MAP_PATH,
  AGENT_INDEX_PATH,
  BUNDLE_PATH,
  DIST_ROOT,
  FORMAT_MANIFEST_PATH,
  FORMAT_ROOT,
  FORMAT_ROUTE_ARTIFACTS,
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

function verifySiteSources(bundle, failures) {
  const sourceIds = new Set(bundle.sources?.map((entry) => entry.id));
  for (const sourceId of bundle.siteExperienceDefaults?.kfd3?.sourceIds || []) {
    check(
      sourceIds.has(sourceId),
      `site experience KFD-3 source is missing: ${sourceId}`,
      failures,
    );
  }
  for (const source of bundle.sources || []) {
    const absolute = assertRelativeSourcePath(source.path);
    const packaged = path.resolve(DIST_ROOT, source.packagePath || '');
    check(
      fileRoot(absolute) === source.contentRoot,
      `source digest drifted: ${source.path}`,
      failures,
    );
    check(
      packaged.startsWith(`${DIST_ROOT}${path.sep}`) && fs.existsSync(packaged),
      `packaged source is missing: ${source.path}`,
      failures,
    );
    if (fs.existsSync(packaged)) {
      check(
        fileRoot(packaged) === source.contentRoot &&
          fs.statSync(packaged).size === source.byteLength,
        `packaged source bytes drifted: ${source.path}`,
        failures,
      );
    }
    check(
      source.url ===
        `${bundle.source.repository}/blob/${bundle.source.revision}/${source.path}`,
      `source URL drifted: ${source.path}`,
      failures,
    );
  }
  return sourceIds;
}

function verifySiteSurfaces(bundle, sourceIds, failures) {
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
  return surfaceIds;
}

function verifySiteCollections(bundle, failures) {
  return verifySiteSurfaces(
    bundle,
    verifySiteSources(bundle, failures),
    failures,
  );
}

function main() {
  const failures = [];
  for (const file of [
    SCHEMA_PATH,
    BUNDLE_PATH,
    AGENT_INDEX_PATH,
    ADR_MAP_PATH,
    FORMAT_MANIFEST_PATH,
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
  const formatManifest = readJson(FORMAT_MANIFEST_PATH);
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: false,
  });
  const validate = ajv.compile(schema);
  check(
    validate(bundle),
    `bundle schema mismatch: ${ajv.errorsText(validate.errors, { separator: '; ' })}`,
    failures,
  );
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
  check(
    agentIndex.siteExperienceDefaults?.brand?.signature === 'Kungfu UNGFU™' &&
      agentIndex.siteExperienceDefaults?.firstScreen?.humanFirst === true &&
      agentIndex.siteExperienceDefaults?.progressiveDisclosure
        ?.technicalDefault === 'collapsed' &&
      agentIndex.siteExperienceDefaults?.navigation?.machineEntriesInPrimary ===
        false &&
      agentIndex.siteExperienceDefaults?.kfd3?.standard === 'KFD-3',
    'agent index reader experience defaults drifted',
    failures,
  );
  check(
    bundle.siteExperienceDefaults?.brand?.productName === 'Kungfu' &&
      bundle.siteExperienceDefaults?.brand?.boundary?.includes(
        'not a second product or runtime',
      ) &&
      bundle.siteExperienceDefaults?.kfd3?.machineEntry === 'agentIndex',
    'site experience brand or KFD-3 boundary drifted',
    failures,
  );
  check(
    bundle.formatAuthority?.pickup?.manifestRoot ===
      fileRoot(FORMAT_MANIFEST_PATH),
    'format manifest byte root mismatch',
    failures,
  );
  check(
    bundle.formatAuthority?.package?.name === formatManifest.package?.name &&
      bundle.formatAuthority?.package?.version ===
        formatManifest.package?.version,
    'format package pickup coordinate drifted',
    failures,
  );
  check(
    bundle.formatAuthority?.formatNamespace ===
      formatManifest.format_namespace &&
      bundle.formatAuthority?.specVersion === formatManifest.spec_version &&
      bundle.formatAuthority?.status === formatManifest.normative?.status &&
      bundle.formatAuthority?.normativeRoot ===
        formatManifest.normative?.root &&
      bundle.formatAuthority?.rootProtocol ===
        formatManifest.normative?.root_protocol &&
      bundle.formatAuthority?.reproducibility ===
        formatManifest.normative?.reproducibility,
    'format authority state is not an exact Spec manifest projection',
    failures,
  );
  check(
    formatManifest.normative?.status === 'pre-release',
    'site must fail closed until a deliberate stable-format projection exists',
    failures,
  );
  check(
    JSON.stringify(bundle.formatAuthority?.nonClaims) ===
      JSON.stringify(formatManifest.normative?.non_claims),
    'format non-claims drifted from the Spec manifest',
    failures,
  );
  const journeyDescriptor = bundle.formatAuthority?.readerJourney;
  const manifestJourney = formatManifest.reader_journey;
  const journeyPath = path.resolve(DIST_ROOT, journeyDescriptor?.path || '');
  check(
    journeyDescriptor?.contentRoot === manifestJourney?.content_root &&
      journeyDescriptor?.byteLength === manifestJourney?.byte_length &&
      journeyDescriptor?.schema === manifestJourney?.schema,
    'format reader journey descriptor drifted from the Spec manifest',
    failures,
  );
  check(
    journeyPath.startsWith(`${FORMAT_ROOT}${path.sep}`) &&
      fs.existsSync(journeyPath),
    'format reader journey is not package-local',
    failures,
  );
  if (fs.existsSync(journeyPath)) {
    check(
      fileRoot(journeyPath) === journeyDescriptor?.contentRoot,
      'format reader journey root mismatch',
      failures,
    );
    check(
      fs.statSync(journeyPath).size === journeyDescriptor?.byteLength,
      'format reader journey byte length mismatch',
      failures,
    );
    const journey = readJson(journeyPath);
    const projectedGuideIds = new Set(
      journeyDescriptor?.guides?.map((guide) => guide.id),
    );
    check(
      projectedGuideIds.size === journey.guides?.length,
      'format reader journey guide coverage drifted',
      failures,
    );
    for (const guide of journey.guides || []) {
      const projected = journeyDescriptor?.guides?.find(
        (entry) => entry.id === guide.id,
      );
      const guidePath = path.resolve(DIST_ROOT, projected?.path || '');
      check(
        projected?.contentRoot === guide.content_root &&
          projected?.byteLength === guide.byte_length &&
          projected?.path === `format/${guide.path}`,
        `format reader guide descriptor drifted: ${guide.id}`,
        failures,
      );
      check(
        guidePath.startsWith(`${FORMAT_ROOT}${path.sep}`) &&
          fs.existsSync(guidePath),
        `format reader guide is not package-local: ${guide.id}`,
        failures,
      );
      if (fs.existsSync(guidePath)) {
        check(
          fileRoot(guidePath) === projected?.contentRoot,
          `format reader guide root mismatch: ${guide.id}`,
          failures,
        );
      }
    }
  }
  for (const [artifactId, descriptor] of Object.entries(
    formatManifest.artifacts || {},
  )) {
    const projected = path.resolve(FORMAT_ROOT, descriptor.path);
    check(
      projected.startsWith(`${FORMAT_ROOT}${path.sep}`) &&
        fs.existsSync(projected),
      `projected Spec artifact is missing: ${artifactId}`,
      failures,
    );
    if (fs.existsSync(projected)) {
      check(
        fileRoot(projected) === descriptor.artifact_root,
        `projected Spec artifact root mismatch: ${artifactId}`,
        failures,
      );
      check(
        fs.statSync(projected).size === descriptor.byte_length,
        `projected Spec artifact byte length mismatch: ${artifactId}`,
        failures,
      );
    }
  }
  for (const [routeId, artifactId] of Object.entries(FORMAT_ROUTE_ARTIFACTS)) {
    const route = bundle.formatAuthority?.routes?.[routeId];
    const descriptor = formatManifest.artifacts?.[artifactId];
    const projected = path.resolve(DIST_ROOT, route?.path || '');
    check(
      route?.artifactRoot === descriptor?.artifact_root &&
        route?.byteLength === descriptor?.byte_length &&
        route?.schema === descriptor?.schema &&
        route?.status === descriptor?.status,
      `format route descriptor drifted: ${routeId}`,
      failures,
    );
    check(
      projected.startsWith(`${FORMAT_ROOT}${path.sep}`) &&
        fs.existsSync(projected),
      `format route is not package-local: ${routeId}`,
      failures,
    );
  }
  check(
    JSON.stringify(agentIndex.formatAuthority) ===
      JSON.stringify({
        package: bundle.formatAuthority.package,
        pickup: bundle.formatAuthority.pickup,
        formatNamespace: bundle.formatAuthority.formatNamespace,
        specVersion: bundle.formatAuthority.specVersion,
        status: bundle.formatAuthority.status,
        normativeRoot: bundle.formatAuthority.normativeRoot,
        conformance: bundle.formatAuthority.conformance,
        readerJourney: bundle.formatAuthority.readerJourney,
        docsUrl: bundle.formatAuthority.docsUrl,
        routes: bundle.formatAuthority.routes,
        nonClaims: bundle.formatAuthority.nonClaims,
      }),
    'agent index format authority projection drifted',
    failures,
  );
  const surfaceIds = verifySiteCollections(bundle, failures);
  const formatSurface = bundle.surfaces.find((entry) => entry.id === 'format');
  check(
    formatSurface?.maturity === 'staged' &&
      formatSurface?.claimClass === 'current-contract',
    '.kungfu site surface must truthfully project the pre-release authority',
    failures,
  );
  check(
    bundle.surfaces.find((entry) => entry.id === 'primitives')?.maturity ===
      'qualified-shadow',
    'primitive runtime must remain qualified-shadow',
    failures,
  );
  check(
    bundle.nonClaims?.some(
      (entry) => entry.includes('Spec 0.1') && entry.includes('non-normative'),
    ),
    'historical Spec 0.1 non-claim is missing',
    failures,
  );
  check(
    !JSON.stringify(bundle).includes('pre-normative') &&
      !JSON.stringify(agentIndex).includes('pre-normative'),
    'stale pre-normative site assertion survived projection',
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
    `[site:verify] passing; surfaces=${bundle.surfaces.length}; sources=${bundle.sources.length}; ADRs=${adrMap.summary.records}; format=${bundle.formatAuthority.specVersion}@${bundle.formatAuthority.normativeRoot}`,
  );
}

main();
