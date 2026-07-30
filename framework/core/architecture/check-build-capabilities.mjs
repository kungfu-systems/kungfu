#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const architectureRoot = path.dirname(fileURLToPath(import.meta.url));
const authorityPath = path.join(architectureRoot, 'build-capabilities.json');
const layersPath = path.join(architectureRoot, 'layers.json');
const cmakePath = path.join(architectureRoot, 'BUILD_PROFILES.cmake');
const docsPath = path.join(architectureRoot, 'BUILD_PROFILES.md');
const manifestPath = path.join(
  architectureRoot,
  'build-capabilities.manifest.json',
);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function ids(items) {
  return new Set((items || []).map((item) => item.id));
}

function variable(id) {
  return id.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function validate(authority, layers) {
  const problems = [];
  if (authority.$schema !== 'kungfu.core-build-capabilities/v1') {
    problems.push(`unsupported schema: ${authority.$schema || '<missing>'}`);
  }
  if (!Number.isInteger(authority.authority_version)) {
    problems.push('authority_version must be an integer');
  }
  if (authority.architecture_authority !== 'layers.json') {
    problems.push('architecture_authority must be layers.json');
  }

  const groups = [
    'components',
    'providers',
    'projections',
    'bindings',
    'dependencies',
    'profiles',
  ];
  const known = {};
  for (const group of groups) {
    known[group] = ids(authority[group]);
    if (known[group].size !== (authority[group] || []).length) {
      problems.push(`${group} contains duplicate ids`);
    }
  }
  const architectureComponents = ids(layers.components);
  const architectureTargets = ids(layers.internal_targets);
  for (const component of authority.components || []) {
    for (const id of component.architecture_components || []) {
      if (!architectureComponents.has(id)) {
        problems.push(`${component.id}: unknown architecture component ${id}`);
      }
    }
    for (const id of component.requires || []) {
      if (!known.components.has(id))
        problems.push(`${component.id}: unknown required component ${id}`);
    }
    for (const id of component.dependencies || []) {
      if (!known.dependencies.has(id))
        problems.push(`${component.id}: unknown dependency ${id}`);
    }
  }
  const mappedArchitectureComponents = new Set(
    (authority.components || []).flatMap(
      (component) => component.architecture_components || [],
    ),
  );
  for (const component of layers.components || []) {
    if (
      component.layer !== 'qualification' &&
      !mappedArchitectureComponents.has(component.id)
    ) {
      problems.push(
        `architecture component is absent from build profile authority: ${component.id}`,
      );
    }
  }
  for (const group of ['providers', 'projections', 'bindings']) {
    for (const item of authority[group] || []) {
      for (const id of item.requires_components || []) {
        if (!known.components.has(id))
          problems.push(`${item.id}: unknown required component ${id}`);
      }
      for (const id of item.dependencies || []) {
        if (!known.dependencies.has(id))
          problems.push(`${item.id}: unknown dependency ${id}`);
      }
    }
  }
  const projectionResponsibilities = new Set(
    (authority.projections || []).map((item) => item.responsibility),
  );
  for (const responsibility of [
    'projection',
    'state-cache',
    'query-acceleration',
  ]) {
    if (!projectionResponsibilities.has(responsibility)) {
      problems.push(
        `projections miss required responsibility ${responsibility}`,
      );
    }
  }

  const profileById = new Map(
    (authority.profiles || []).map((item) => [item.id, item]),
  );
  const supported = new Set(['planned', 'supported']);
  for (const profile of authority.profiles || []) {
    if (!supported.has(profile.status))
      problems.push(`${profile.id}: unsupported status ${profile.status}`);
    for (const [field, group] of [
      ['components', 'components'],
      ['providers', 'providers'],
      ['projections', 'projections'],
      ['bindings', 'bindings'],
    ]) {
      for (const id of profile[field] || []) {
        if (!known[group].has(id))
          problems.push(`${profile.id}: unknown ${field} entry ${id}`);
      }
    }
    for (const id of [
      ...(profile.requires || []),
      ...(profile.conflicts || []),
    ]) {
      if (!known.profiles.has(id))
        problems.push(`${profile.id}: unknown profile relation ${id}`);
      if (id === profile.id)
        problems.push(
          `${profile.id}: profile relation cannot reference itself`,
        );
    }
    for (const group of ['providers', 'projections', 'bindings']) {
      for (const id of profile[group] || []) {
        const item = (authority[group] || []).find((entry) => entry.id === id);
        for (const component of item?.requires_components || []) {
          if (!(profile.components || []).includes(component)) {
            problems.push(
              `${profile.id}: ${id} requires missing component ${component}`,
            );
          }
        }
      }
    }
    for (const componentId of profile.components || []) {
      const component = (authority.components || []).find(
        (entry) => entry.id === componentId,
      );
      for (const required of component?.requires || []) {
        if (!(profile.components || []).includes(required)) {
          problems.push(
            `${profile.id}: ${componentId} requires missing component ${required}`,
          );
        }
      }
    }
  }
  const defaultProfile = profileById.get(authority.default_profile);
  if (!defaultProfile)
    problems.push(`unknown default_profile ${authority.default_profile}`);
  else if (defaultProfile.status !== 'supported')
    problems.push('default_profile must be supported');

  for (const [target, dependencies] of Object.entries(
    authority.target_dependencies || {},
  )) {
    if (!architectureTargets.has(target))
      problems.push(`target_dependencies: unknown target ${target}`);
    for (const dependency of dependencies) {
      if (!known.dependencies.has(dependency))
        problems.push(`${target}: unknown dependency ${dependency}`);
    }
  }
  for (const target of architectureTargets) {
    if (!(target in (authority.target_dependencies || {}))) {
      problems.push(`target_dependencies: missing target ${target}`);
    }
  }

  const fields = authority.build_identity?.fields || [];
  if (authority.build_identity?.schema !== 'kungfu.core-build-identity/v1') {
    problems.push('unsupported build identity schema');
  }
  for (const required of [
    'profile',
    'components',
    'providers',
    'projections',
    'bindings',
    'dependency_roots',
    'live_capability',
    'build_root',
    'source_revision',
  ]) {
    if (!fields.includes(required))
      problems.push(`build identity misses ${required}`);
  }
  return problems;
}

function dependencyRoots(authority, profile) {
  const roots = new Set();
  for (const [group, componentField] of [
    ['components', 'components'],
    ['providers', 'providers'],
    ['projections', 'projections'],
    ['bindings', 'bindings'],
  ]) {
    for (const id of profile[componentField] || []) {
      const item = authority[group].find((entry) => entry.id === id);
      for (const dependency of item?.dependencies || []) roots.add(dependency);
    }
  }
  return [...roots].sort();
}

function renderCmake(authority) {
  const knownProfiles = authority.profiles.map((item) => item.id);
  const supportedProfiles = authority.profiles
    .filter((item) => item.status === 'supported')
    .map((item) => item.id);
  const dependencyById = new Map(
    authority.dependencies.map((item) => [item.id, item]),
  );
  const targetDependencyIds = new Set(
    Object.values(authority.target_dependencies).flat(),
  );
  const lines = [
    '# Generated from architecture/build-capabilities.json by check-build-capabilities.mjs.',
    '# Do not edit this projection directly.',
    '',
    `set(KUNGFU_KNOWN_BUILD_PROFILES "${knownProfiles.join(';')}")`,
    `set(KUNGFU_SUPPORTED_BUILD_PROFILES "${supportedProfiles.join(';')}")`,
    `set(KUNGFU_BUILD_PROFILE "${authority.default_profile}" CACHE STRING "Kungfu supported Core build profile")`,
    'set_property(CACHE KUNGFU_BUILD_PROFILE PROPERTY STRINGS ${KUNGFU_SUPPORTED_BUILD_PROFILES})',
    'if(NOT KUNGFU_BUILD_PROFILE IN_LIST KUNGFU_KNOWN_BUILD_PROFILES)',
    '  message(FATAL_ERROR "unknown Kungfu build profile: ${KUNGFU_BUILD_PROFILE}; known=${KUNGFU_KNOWN_BUILD_PROFILES}")',
    'endif()',
    'if(NOT KUNGFU_BUILD_PROFILE IN_LIST KUNGFU_SUPPORTED_BUILD_PROFILES)',
    '  message(FATAL_ERROR "Kungfu build profile ${KUNGFU_BUILD_PROFILE} is planned but not yet qualified; supported=${KUNGFU_SUPPORTED_BUILD_PROFILES}")',
    'endif()',
    '',
  ];
  for (const profile of authority.profiles) {
    const condition = `KUNGFU_BUILD_PROFILE STREQUAL "${profile.id}"`;
    lines.push(
      `${profile === authority.profiles[0] ? 'if' : 'elseif'}(${condition})`,
    );
    for (const field of [
      'components',
      'providers',
      'projections',
      'bindings',
    ]) {
      lines.push(
        `  set(KUNGFU_BUILD_${field.toUpperCase()} "${(profile[field] || []).join(';')}")`,
      );
    }
    const roots = dependencyRoots(authority, profile);
    const linkTargets = roots
      .filter((id) => targetDependencyIds.has(id))
      .map((id) => dependencyById.get(id)?.cmake_target)
      .filter(Boolean);
    lines.push(`  set(KUNGFU_BUILD_DEPENDENCY_ROOTS "${roots.join(';')}")`);
    lines.push(
      `  set(KUNGFU_BUILD_LINK_DEPENDENCIES "${linkTargets.join(';')}")`,
    );
    for (const [target, dependencies] of Object.entries(
      authority.target_dependencies,
    )) {
      const targets = dependencies
        .filter((id) => roots.includes(id))
        .map((id) => dependencyById.get(id)?.cmake_target)
        .filter(Boolean);
      lines.push(
        `  set(KUNGFU_TARGET_${variable(target)}_DEPENDENCIES "${targets.join(';')}")`,
      );
    }
  }
  lines.push('endif()', '');
  return `${lines.join('\n')}\n`;
}

function renderDocs(authority) {
  const lines = [
    '---',
    'metadata_schema: kungfu.document-metadata/v1',
    'document_status: active',
    'period: ongoing',
    'theme: kungfu-core-build-profiles',
    'doc_type: architecture-map',
    'sources: [local-files]',
    'confidence: high',
    'sensitivity: public',
    'evidence_grade: B',
    'review_state: self-reviewed',
    'last_reviewed: 2026-07-15',
    '---',
    '',
    '# Core Build Profiles',
    '',
    'This file is a checked projection of [`build-capabilities.json`](build-capabilities.json).',
    'The authority references component ownership from [`layers.json`](layers.json); it does not define a second layer graph.',
    '',
    `Default profile: \`${authority.default_profile}\`. Planned profiles fail closed until their qualification work is complete.`,
    '',
    '| Profile | Status | Components | Providers | Projections | Bindings | Dependency roots |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const profile of authority.profiles) {
    const cell = (items) =>
      items.map((item) => `\`${item}\``).join('<br>') || '—';
    lines.push(
      `| \`${profile.id}\` | ${profile.status} | ${cell(profile.components)} | ${cell(profile.providers)} | ${cell(profile.projections)} | ${cell(profile.bindings)} | ${cell(dependencyRoots(authority, profile))} |`,
    );
  }
  lines.push(
    '',
    '## Select and build a profile',
    '',
    'The environment variable is the single participant-facing selector consumed by Shifu, Conan and CMake:',
    '',
    '```sh',
    'KUNGFU_BUILD_PROFILE=embedded-minimal ./shifu rebuild:core',
    'KUNGFU_BUILD_PROFILE=embedded-sqlite ./shifu rebuild:core',
    'KUNGFU_BUILD_PROFILE=full ./shifu rebuild:core',
    '```',
    '',
    'Use `./shifu core:architecture --profile embedded-sqlite` to inspect the resolved domain, target, owner and test closure. A `planned` profile such as `server` fails before dependency resolution; do not use it as a hidden partial build.',
    '',
    'Maintainers validate the authority and its checked projections with `./shifu core:build-capabilities:check`; after an intentional authority edit, refresh them with `./shifu core:build-capabilities:write`.',
    '',
    '## Build identity',
    '',
    `Schema: \`${authority.build_identity.schema}\`.`,
    '',
    authority.build_identity.fields.map((field) => `- \`${field}\``).join('\n'),
    '',
    '## Gate',
    '',
    '```sh',
    './shifu check:source',
    '```',
    '',
    'The source gate rejects unknown references, incomplete component closure, a planned default, target dependency drift, projection drift, or a build identity that omits required roots.',
    '',
  );
  return lines.join('\n');
}

function renderManifest(authority) {
  const canonical = JSON.stringify(authority);
  return `${JSON.stringify(
    {
      schema: 'kungfu.core-build-capability-manifest/v1',
      authority_version: authority.authority_version,
      authority_sha256: `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`,
      default_profile: authority.default_profile,
      profiles: authority.profiles.map((profile) => ({
        ...profile,
        dependency_roots: dependencyRoots(authority, profile),
      })),
      build_identity: authority.build_identity,
    },
    null,
    2,
  )}\n`;
}

function selfTest() {
  const authority = readJson(authorityPath);
  const layers = readJson(layersPath);
  const expect = (label, mutation, pattern) => {
    const candidate = structuredClone(authority);
    mutation(candidate);
    const problems = validate(candidate, layers);
    const passed = problems.some((problem) => problem.includes(pattern));
    console.log(`  ${passed ? 'ok' : 'MISS'}: ${label}`);
    if (!passed)
      throw new Error(`self-test missed ${label}: ${problems.join('; ')}`);
  };
  expect(
    'unknown profile component fails',
    (value) => value.profiles[0].components.push('missing'),
    'unknown components entry',
  );
  expect(
    'incomplete component closure fails',
    (value) => {
      value.profiles[1].components = ['composition'];
    },
    'requires missing component',
  );
  expect(
    'planned default fails closed',
    (value) => {
      value.default_profile = 'journal';
      value.profiles.find((profile) => profile.id === 'journal').status =
        'planned';
    },
    'default_profile must be supported',
  );
  expect(
    'unknown target dependency fails',
    (value) => value.target_dependencies.kungfu_contracts.push('missing'),
    'unknown dependency',
  );
  expect(
    'unmapped architecture component fails',
    (value) => {
      for (const component of value.components) {
        component.architecture_components = (
          component.architecture_components || []
        ).filter((id) => id !== 'runtime-storage-services');
      }
    },
    'architecture component is absent from build profile authority',
  );
  console.log('[core-build-capabilities] negative fixtures passed');
}

const authority = readJson(authorityPath);
const layers = readJson(layersPath);
const problems = validate(authority, layers);
if (problems.length) {
  for (const problem of problems)
    console.error(`[core-build-capabilities] ${problem}`);
  process.exit(1);
}
const cmake = renderCmake(authority);
const docs = renderDocs(authority);
const manifest = renderManifest(authority);
if (process.argv.includes('--write')) {
  fs.writeFileSync(cmakePath, cmake);
  fs.writeFileSync(docsPath, docs);
  fs.writeFileSync(manifestPath, manifest);
  console.log('[core-build-capabilities] projections updated');
} else {
  for (const [file, expected] of [
    [cmakePath, cmake],
    [docsPath, docs],
    [manifestPath, manifest],
  ]) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== expected) {
      console.error(
        `[core-build-capabilities] projection drift: ${path.basename(file)}; run ./shifu core:build-capabilities:write`,
      );
      process.exit(1);
    }
  }
}
if (process.argv.includes('--self-test')) selfTest();
console.log(
  `[core-build-capabilities] ${authority.profiles.length} profiles; default=${authority.default_profile}; supported=${authority.profiles
    .filter((item) => item.status === 'supported')
    .map((item) => item.id)
    .join(',')}`,
);
