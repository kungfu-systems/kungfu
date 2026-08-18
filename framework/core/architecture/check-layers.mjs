#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const architectureRoot = path.dirname(fileURLToPath(import.meta.url));
const coreRoot = path.resolve(architectureRoot, '..');
const contractPath = path.join(architectureRoot, 'layers.json');
const mapPath = path.join(architectureRoot, 'LAYERS.md');
const targetsCmakePath = path.join(architectureRoot, 'TARGETS.cmake');
const publicContractsCmakePath = path.join(
  architectureRoot,
  'PUBLIC_CONTRACTS.cmake',
);
const buildCapabilitiesPath = path.join(
  architectureRoot,
  'build-capabilities.json',
);

function findCycles(items) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const visited = new Set();
  const active = new Set();
  const stack = [];
  const cycles = [];
  const visit = (id) => {
    if (active.has(id)) {
      const start = stack.indexOf(id);
      cycles.push([...stack.slice(start), id].join(' -> '));
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    active.add(id);
    stack.push(id);
    for (const dependency of byId.get(id)?.dependencies || []) {
      if (byId.has(dependency)) visit(dependency);
    }
    stack.pop();
    active.delete(id);
  };
  for (const id of [...byId.keys()].sort()) visit(id);
  return cycles;
}

function posix(value) {
  return value.split(path.sep).join('/');
}

function cmakeVariable(value) {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function walk(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function owns(component, file) {
  const included =
    (component.include_files || []).includes(file) ||
    (component.include_prefixes || []).some((prefix) =>
      file.startsWith(prefix),
    );
  if (!included) return false;
  if ((component.exclude_files || []).includes(file)) return false;
  return !(component.exclude_prefixes || []).some((prefix) =>
    file.startsWith(prefix),
  );
}

function targetOwns(target, file, componentId) {
  if (target.component !== componentId) return false;
  const includeFiles = target.include_files || [];
  const includePrefixes = target.include_prefixes || [];
  const hasSelector = includeFiles.length > 0 || includePrefixes.length > 0;
  if (
    hasSelector &&
    !includeFiles.includes(file) &&
    !includePrefixes.some((prefix) => file.startsWith(prefix))
  ) {
    return false;
  }
  if ((target.exclude_files || []).includes(file)) return false;
  return !(target.exclude_prefixes || []).some((prefix) =>
    file.startsWith(prefix),
  );
}

function ruleOwns(rule, file) {
  const included =
    (rule.include_files || []).includes(file) ||
    (rule.include_prefixes || []).some((prefix) => file.startsWith(prefix));
  if (!included) return false;
  if ((rule.exclude_files || []).includes(file)) return false;
  return !(rule.exclude_prefixes || []).some((prefix) =>
    file.startsWith(prefix),
  );
}

function trackedFiles(root, contract) {
  const extensions = new Set(contract.extensions);
  const files = new Set();
  for (const relRoot of contract.tracked_roots) {
    const absoluteRoot = path.join(root, relRoot);
    for (const file of walk(absoluteRoot)) {
      if (extensions.has(path.extname(file))) {
        files.add(posix(path.relative(root, file)));
      }
    }
  }
  return [...files].sort();
}

function validate(root, contract) {
  const problems = [];
  if (contract.$schema !== 'kungfu.core-architecture/v1') {
    problems.push(`unsupported schema: ${contract.$schema || '<missing>'}`);
  }

  const layerById = new Map();
  for (const layer of contract.layers || []) {
    if (layerById.has(layer.id)) problems.push(`duplicate layer: ${layer.id}`);
    layerById.set(layer.id, layer);
  }
  const componentById = new Map();
  const usedTargets = new Set();
  for (const component of contract.components || []) {
    if (componentById.has(component.id)) {
      problems.push(`duplicate component: ${component.id}`);
    }
    componentById.set(component.id, component);
    if (!layerById.has(component.layer)) {
      problems.push(`${component.id}: unknown layer ${component.layer}`);
    }
    for (const field of ['owner', 'entry_points', 'contract_tests']) {
      const value = component[field];
      if (!value || (Array.isArray(value) && value.length === 0)) {
        problems.push(`${component.id}: ${field} must not be empty`);
      }
    }
    if (
      !Array.isArray(component.current_targets) ||
      component.current_targets.length === 0
    ) {
      problems.push(`${component.id}: current_targets must not be empty`);
    }
    for (const target of component.current_targets || [])
      usedTargets.add(target);
  }
  const productionComponentCount = (contract.components || []).filter(
    (component) => component.layer !== 'qualification',
  ).length;
  const componentBudget = contract.component_budget || {};
  if (
    !Number.isInteger(componentBudget.min) ||
    !Number.isInteger(componentBudget.max) ||
    productionComponentCount < componentBudget.min ||
    productionComponentCount > componentBudget.max
  ) {
    problems.push(
      `production component count ${productionComponentCount} is outside budget ${componentBudget.min ?? '<missing>'}-${componentBudget.max ?? '<missing>'}`,
    );
  }
  for (const cycle of findCycles(contract.components || [])) {
    problems.push(`component dependency cycle: ${cycle}`);
  }

  const internalTargetById = new Map();
  for (const target of contract.internal_targets || []) {
    if (internalTargetById.has(target.id)) {
      problems.push(`duplicate internal target: ${target.id}`);
    }
    internalTargetById.set(target.id, target);
    if (!componentById.has(target.component)) {
      problems.push(`${target.id}: unknown component ${target.component}`);
    }
    if (!['INTERFACE', 'OBJECT'].includes(target.kind)) {
      problems.push(`${target.id}: unsupported target kind ${target.kind}`);
    }
  }

  const evidencedTargets = new Set();
  for (const entry of contract.target_evidence || []) {
    const evidencePath = path.join(root, entry.file);
    if (!fs.existsSync(evidencePath)) {
      problems.push(`missing target evidence file: ${entry.file}`);
      continue;
    }
    const cmake = fs.readFileSync(evidencePath, 'utf8');
    for (const target of entry.targets || []) {
      if (evidencedTargets.has(target)) {
        problems.push(`duplicate target evidence: ${target}`);
      }
      evidencedTargets.add(target);
      const token = entry.tokens?.[target] || target;
      const generatedProjection =
        path.resolve(evidencePath) === path.resolve(targetsCmakePath);
      if (!generatedProjection && !cmake.includes(token)) {
        problems.push(`${target}: token ${token} is absent from ${entry.file}`);
      }
    }
  }
  for (const target of usedTargets) {
    if (!evidencedTargets.has(target))
      problems.push(`target lacks CMake evidence: ${target}`);
  }
  for (const target of evidencedTargets) {
    if (!usedTargets.has(target))
      problems.push(`stale unused target evidence: ${target}`);
  }
  for (const component of contract.components || []) {
    for (const target of component.contract_tests || []) {
      if (!evidencedTargets.has(target)) {
        problems.push(
          `${component.id}: contract test lacks CMake evidence: ${target}`,
        );
      }
    }
  }

  if (contract.target_projection) {
    const consumerPath = path.join(root, contract.target_projection.consumer);
    if (!fs.existsSync(consumerPath)) {
      problems.push(
        `missing target projection consumer: ${contract.target_projection.consumer}`,
      );
    } else {
      const consumer = fs.readFileSync(consumerPath, 'utf8');
      for (const field of ['include_token', 'facade_token']) {
        const token = contract.target_projection[field];
        if (!token || !consumer.includes(token)) {
          problems.push(
            `${contract.target_projection.consumer}: missing ${field} ${token || '<missing>'}`,
          );
        }
      }
    }
  }

  const excluded = new Set(
    (contract.excluded_files || []).map((entry) => entry.path),
  );
  const ownership = new Map();
  for (const file of trackedFiles(root, contract)) {
    if (excluded.has(file)) continue;
    const owners = (contract.components || []).filter((component) =>
      owns(component, file),
    );
    if (owners.length === 0) problems.push(`unclassified file: ${file}`);
    if (owners.length > 1) {
      problems.push(
        `multiply owned file: ${file} -> ${owners.map((item) => item.id).join(', ')}`,
      );
    }
    if (owners.length === 1) ownership.set(file, owners[0].id);
  }

  for (const entry of contract.excluded_files || []) {
    if (!fs.existsSync(path.join(root, entry.path))) {
      problems.push(`stale excluded file: ${entry.path}`);
    }
    if (!entry.reason)
      problems.push(`excluded file lacks reason: ${entry.path}`);
  }

  for (const constraint of contract.source_constraints || []) {
    const sourcePath = path.join(root, constraint.file);
    if (!fs.existsSync(sourcePath)) {
      problems.push(
        `source constraint points to missing file: ${constraint.file}`,
      );
      continue;
    }
    if (!ownership.has(constraint.file)) {
      problems.push(
        `source constraint points to unowned file: ${constraint.file}`,
      );
    }
    const source = fs.readFileSync(sourcePath, 'utf8');
    const lineCount = source.split('\n').length;
    if (constraint.max_lines && lineCount > constraint.max_lines) {
      problems.push(
        `${constraint.file}: ${lineCount} lines exceeds architecture budget ${constraint.max_lines}`,
      );
    }
    for (const token of constraint.required_text || []) {
      if (!source.includes(token)) {
        problems.push(
          `${constraint.file}: missing required responsibility token ${token}`,
        );
      }
    }
    for (const token of constraint.forbidden_text || []) {
      if (source.includes(token)) {
        problems.push(
          `${constraint.file}: forbidden responsibility token ${token}`,
        );
      }
    }
  }

  for (const component of contract.components || []) {
    const sourceLayer = layerById.get(component.layer);
    for (const dependencyId of component.dependencies || []) {
      const dependency = componentById.get(dependencyId);
      if (!dependency) {
        problems.push(`${component.id}: unknown dependency ${dependencyId}`);
        continue;
      }
      if (!sourceLayer.may_depend_on.includes(dependency.layer)) {
        problems.push(
          `${component.id}: layer ${component.layer} may not depend on ${dependency.layer} (${dependencyId})`,
        );
      }
    }
    for (const entryPoint of component.entry_points || []) {
      if (ownership.get(entryPoint) !== component.id) {
        problems.push(
          `${component.id}: entry point is missing or owned elsewhere: ${entryPoint}`,
        );
      }
    }
  }

  for (const target of contract.internal_targets || []) {
    const sourceComponent = componentById.get(target.component);
    if (!sourceComponent) continue;
    const sourceLayer = layerById.get(sourceComponent.layer);
    for (const dependencyId of target.dependencies || []) {
      const dependency = internalTargetById.get(dependencyId);
      if (!dependency) {
        problems.push(
          `${target.id}: unknown target dependency ${dependencyId}`,
        );
        continue;
      }
      const dependencyComponent = componentById.get(dependency.component);
      if (
        dependencyComponent &&
        dependencyComponent.id !== sourceComponent.id &&
        !(sourceComponent.dependencies || []).includes(dependencyComponent.id)
      ) {
        problems.push(
          `${target.id}: target dependency ${dependencyId} is not declared by component ${sourceComponent.id}`,
        );
      }
      if (
        dependencyComponent &&
        !sourceLayer.may_depend_on.includes(dependencyComponent.layer)
      ) {
        problems.push(
          `${target.id}: layer ${sourceComponent.layer} may not depend on target ${dependencyId} (${dependencyComponent.layer})`,
        );
      }
    }
  }
  for (const cycle of findCycles(contract.internal_targets || [])) {
    problems.push(`internal target dependency cycle: ${cycle}`);
  }

  const internalTargetRoots = contract.internal_target_roots || [];
  const internalTargetSourceCounts = new Map(
    (contract.internal_targets || []).map((target) => [target.id, 0]),
  );
  for (const [file, componentId] of ownership) {
    if (!internalTargetRoots.some((prefix) => file.startsWith(prefix)))
      continue;
    if (!['.c', '.cc', '.cpp', '.cxx'].includes(path.extname(file))) continue;
    const targets = (contract.internal_targets || []).filter((target) =>
      targetOwns(target, file, componentId),
    );
    if (targets.length === 0) {
      problems.push(`source lacks internal target: ${file}`);
    }
    if (targets.length > 1) {
      problems.push(
        `source has multiple internal targets: ${file} -> ${targets.map((target) => target.id).join(', ')}`,
      );
    }
    if (targets.length === 1) {
      internalTargetSourceCounts.set(
        targets[0].id,
        (internalTargetSourceCounts.get(targets[0].id) || 0) + 1,
      );
    }
  }
  for (const target of contract.internal_targets || []) {
    const count = internalTargetSourceCounts.get(target.id) || 0;
    if (target.kind === 'INTERFACE' && count !== 0) {
      problems.push(`${target.id}: INTERFACE target owns ${count} sources`);
    }
    if (target.kind === 'OBJECT' && count === 0) {
      problems.push(`${target.id}: OBJECT target owns no sources`);
    }
  }

  const includePattern = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/;
  const headerIndex = new Map();
  for (const file of ownership.keys()) {
    const marker = '/include/';
    const index = file.indexOf(marker);
    if (index >= 0) headerIndex.set(file.slice(index + marker.length), file);
  }
  const usedExceptions = new Set();
  const dependencyExceptions = contract.dependency_exceptions || [];
  for (const [file, componentId] of ownership) {
    const component = componentById.get(componentId);
    const layer = layerById.get(component.layer);
    const prefixes = layer.forbidden_include_prefixes || [];
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      const match = line.match(includePattern);
      if (!match) return;
      const forbidden = prefixes.find((prefix) => match[1].startsWith(prefix));
      if (forbidden) {
        problems.push(
          `${file}:${index + 1}: ${component.layer} forbids include ${match[1]}`,
        );
      }
      const localCandidate = posix(
        path.normalize(path.join(path.dirname(file), match[1])),
      );
      const targetFile =
        headerIndex.get(match[1]) ||
        (ownership.has(localCandidate) ? localCandidate : undefined);
      if (!targetFile) return;
      const targetComponentId = ownership.get(targetFile);
      const targetComponent = componentById.get(targetComponentId);
      if (
        targetComponentId !== componentId &&
        !(component.dependencies || []).includes(targetComponentId)
      ) {
        problems.push(
          `${file}:${index + 1}: ${componentId} has undeclared dependency on ${targetComponentId} via ${match[1]}`,
        );
      }
      if (layer.may_depend_on.includes(targetComponent.layer)) return;
      const exceptionIndex = dependencyExceptions.findIndex(
        (entry) =>
          entry.from_component === componentId &&
          entry.to_component === targetComponentId &&
          entry.include === match[1],
      );
      if (exceptionIndex >= 0) {
        usedExceptions.add(exceptionIndex);
        return;
      }
      problems.push(
        `${file}:${index + 1}: ${componentId} (${component.layer}) may not include ${match[1]} from ${targetComponentId} (${targetComponent.layer})`,
      );
    });
  }
  dependencyExceptions.forEach((entry, index) => {
    if (!entry.reason || !entry.follow_up_goal) {
      problems.push(
        `dependency exception ${index} lacks reason or follow_up_goal`,
      );
    }
    if (!usedExceptions.has(index)) {
      problems.push(
        `stale dependency exception: ${entry.from_component} -> ${entry.to_component} via ${entry.include}`,
      );
    }
  });
  for (const item of contract.navigation || []) {
    if (!componentById.has(item.component)) {
      problems.push(`navigation row has unknown component: ${item.component}`);
    } else if (ownership.get(item.entry_point) !== item.component) {
      problems.push(
        `navigation row points outside ${item.component}: ${item.entry_point}`,
      );
    }
  }

  const publicContracts = contract.public_contracts;
  if (publicContracts) {
    const buildAuthority = JSON.parse(
      fs.readFileSync(buildCapabilitiesPath, 'utf8'),
    );
    const supportedProfiles = new Set(
      buildAuthority.profiles
        .filter((profile) => profile.status === 'supported')
        .map((profile) => profile.id),
    );
    const levelIds = new Set();
    for (const level of publicContracts.levels || []) {
      if (levelIds.has(level.id))
        problems.push(`duplicate public contract level: ${level.id}`);
      levelIds.add(level.id);
      if (!level.policy)
        problems.push(`public contract level ${level.id} lacks policy`);
    }
    for (const required of [
      'stable',
      'experimental',
      'internal',
      'source-embedding-only',
    ]) {
      if (!levelIds.has(required))
        problems.push(`missing public contract level: ${required}`);
    }

    const publicHeaders = [...ownership.keys()].filter(
      (file) =>
        (file.startsWith('src/libkungfu/include/') ||
          file.startsWith('src/libyijinjing/include/')) &&
        ['.h', '.hh', '.hpp', '.hxx'].includes(path.extname(file)),
    );
    const headerRuleIds = new Set();
    for (const rule of publicContracts.header_rules || []) {
      if (headerRuleIds.has(rule.id))
        problems.push(`duplicate public header rule: ${rule.id}`);
      headerRuleIds.add(rule.id);
      if (!levelIds.has(rule.level))
        problems.push(
          `${rule.id}: unknown public contract level ${rule.level}`,
        );
      if (!supportedProfiles.has(rule.minimum_profile)) {
        problems.push(
          `${rule.id}: minimum profile is not supported: ${rule.minimum_profile}`,
        );
      }
      if (!(rule.consumers || []).length || !rule.compatibility_policy) {
        problems.push(
          `${rule.id}: consumers and compatibility policy required`,
        );
      }
    }
    for (const header of publicHeaders) {
      const rules = (publicContracts.header_rules || []).filter((rule) =>
        ruleOwns(rule, header),
      );
      if (rules.length === 0)
        problems.push(`unclassified public header: ${header}`);
      if (rules.length > 1) {
        problems.push(
          `multiply classified public header: ${header} -> ${rules.map((rule) => rule.id).join(', ')}`,
        );
      }
    }
    for (const rule of publicContracts.header_rules || []) {
      if (!publicHeaders.some((header) => ruleOwns(rule, header))) {
        problems.push(`public header rule matches no headers: ${rule.id}`);
      }
    }

    const symbolNames = new Set();
    for (const symbol of publicContracts.stable_symbols || []) {
      if (symbolNames.has(symbol.name))
        problems.push(`duplicate stable symbol: ${symbol.name}`);
      symbolNames.add(symbol.name);
      const header = path.join(root, symbol.header || '');
      const implementation = path.join(root, symbol.implementation || '');
      if (
        !fs.existsSync(header) ||
        !fs.readFileSync(header, 'utf8').includes(symbol.name)
      ) {
        problems.push(`${symbol.name}: stable symbol missing from header`);
      }
      if (
        !fs.existsSync(implementation) ||
        !fs.readFileSync(implementation, 'utf8').includes(symbol.name)
      ) {
        problems.push(
          `${symbol.name}: stable symbol missing from implementation`,
        );
      }
      if (!componentById.has(symbol.owner_component))
        problems.push(
          `${symbol.name}: unknown owner ${symbol.owner_component}`,
        );
      if (!supportedProfiles.has(symbol.minimum_profile))
        problems.push(`${symbol.name}: unsupported minimum profile`);
      if (
        !(symbol.abi_versions || []).length ||
        !(symbol.consumers || []).length ||
        !symbol.removal_policy
      ) {
        problems.push(`${symbol.name}: incomplete stable symbol policy`);
      }
    }

    for (const layout of publicContracts.schema_layout_contracts || []) {
      if (!levelIds.has(layout.level))
        problems.push(
          `${layout.id}: unknown schema/layout level ${layout.level}`,
        );
      if (!componentById.has(layout.owner_component))
        problems.push(`${layout.id}: unknown owner ${layout.owner_component}`);
      if (!supportedProfiles.has(layout.minimum_profile))
        problems.push(`${layout.id}: unsupported minimum profile`);
      const authorities = [...(layout.authority_files || [])];
      for (const prefix of layout.authority_prefixes || []) {
        const extensionSet = new Set(layout.authority_extensions || []);
        for (const file of walk(path.join(root, prefix))) {
          if (extensionSet.has(path.extname(file))) {
            authorities.push(posix(path.relative(root, file)));
          }
        }
      }
      if (!authorities.length)
        problems.push(`${layout.id}: no schema/layout authority files`);
      for (const file of authorities) {
        if (!fs.existsSync(path.join(root, file)))
          problems.push(`${layout.id}: missing authority file ${file}`);
      }
      if (
        layout.retained_fixture &&
        !fs.existsSync(path.join(root, layout.retained_fixture))
      ) {
        problems.push(
          `${layout.id}: missing retained fixture ${layout.retained_fixture}`,
        );
      }
      if (!(layout.consumers || []).length || !layout.compatibility_policy) {
        problems.push(`${layout.id}: incomplete schema/layout policy`);
      }
    }

    const requiredBindings = new Set(['node', 'python', 'electron', 'wasm']);
    for (const binding of publicContracts.binding_surfaces || []) {
      requiredBindings.delete(binding.id);
      if (!levelIds.has(binding.level))
        problems.push(`${binding.id}: unknown binding level ${binding.level}`);
      if (!fs.existsSync(path.join(root, binding.evidence || '')))
        problems.push(
          `${binding.id}: missing binding evidence ${binding.evidence}`,
        );
      if (!supportedProfiles.has(binding.minimum_profile))
        problems.push(`${binding.id}: unsupported binding minimum profile`);
      if (
        binding.contract !== 'libkungfu-in-process-contracts' ||
        JSON.stringify(binding.semantic_axes) !==
          JSON.stringify(['version', 'capability', 'error'])
      ) {
        problems.push(`${binding.id}: binding parity semantics drifted`);
      }
    }
    for (const binding of requiredBindings) {
      problems.push(`missing binding parity surface: ${binding}`);
    }

    const deprecationAuthority = publicContracts.deprecation_authority;
    for (const field of ['contract', 'registry']) {
      const relative = deprecationAuthority?.[field];
      if (!relative || !fs.existsSync(path.join(root, relative))) {
        problems.push(
          `common deprecation ${field} is missing: ${relative || '<missing>'}`,
        );
      }
    }
    if (
      deprecationAuthority?.registry &&
      fs.existsSync(path.join(root, deprecationAuthority.registry))
    ) {
      const registry = JSON.parse(
        fs.readFileSync(path.join(root, deprecationAuthority.registry), 'utf8'),
      );
      const byId = new Map(
        (registry.entries || []).map((entry) => [entry.id, entry]),
      );
      for (const id of deprecationAuthority.contributions || []) {
        const entry = byId.get(id);
        if (!entry) {
          problems.push(`missing common deprecation contribution: ${id}`);
        } else if (
          entry.contributedFrom?.authority !==
          'framework/core/architecture/layers.json'
        ) {
          problems.push(
            `${id}: common deprecation contribution lost Core authority provenance`,
          );
        }
      }
      if (!(deprecationAuthority.contributions || []).length) {
        problems.push('Core deprecation contributions must not be empty');
      }
    }
  }

  return { problems, ownership };
}

function renderMap(contract, ownership) {
  const lines = [
    '---',
    'metadata_schema: kungfu.document-metadata/v1',
    'document_status: active',
    'period: ongoing',
    'theme: kungfu-core-architecture',
    'doc_type: architecture-map',
    'sources: [local-files]',
    'confidence: high',
    'sensitivity: public',
    'evidence_grade: B',
    'review_state: self-reviewed',
    'last_reviewed: 2026-07-15',
    '---',
    '',
    '# Core Layer Map',
    '',
    'This map is a checked projection of [`layers.json`](layers.json). Edit the',
    'contract first, then update this projection; `check-layers.mjs` rejects drift.',
    '',
    'Dependency direction is downward: composition and bindings may consume adapters',
    'and services; the journal kernel may consume only schema/value contracts.',
    '',
    '## Layers',
    '',
    '| Order | Layer | Responsibility | May depend on |',
    '| ---: | --- | --- | --- |',
  ];
  for (const layer of [...contract.layers].sort((a, b) => a.order - b.order)) {
    lines.push(
      `| ${layer.order} | \`${layer.id}\` | ${layer.responsibility} | ${layer.may_depend_on.map((item) => `\`${item}\``).join(', ')} |`,
    );
  }
  lines.push(
    '',
    '## Components',
    '',
    'Current targets describe the checked build graph. Internal component targets',
    'remain private implementation details behind the public `kungfu` facade.',
    `The production graph is budgeted to ${contract.component_budget.min}-${contract.component_budget.max} bounded components.`,
    '',
    '| Component | Layer | Owner | Files | Current targets | Contract tests | Entry points |',
    '| --- | --- | --- | ---: | --- | --- | --- |',
  );
  const counts = new Map();
  for (const componentId of ownership.values()) {
    counts.set(componentId, (counts.get(componentId) || 0) + 1);
  }
  for (const component of contract.components) {
    lines.push(
      `| \`${component.id}\` | \`${component.layer}\` | \`${component.owner}\` | ${counts.get(component.id) || 0} | ${component.current_targets.map((item) => `\`${item}\``).join('<br>')} | ${component.contract_tests.map((item) => `\`${item}\``).join('<br>')} | ${component.entry_points.map((item) => `\`${item}\``).join('<br>')} |`,
    );
  }
  lines.push(
    '',
    '## Internal target graph',
    '',
    'The public `kungfu` target remains the compatibility facade. These internal',
    'targets express compile ownership and are generated into `TARGETS.cmake`',
    'from the same authority as this map.',
    '',
    '| Target | Kind | Component | Depends on | Sources |',
    '| --- | --- | --- | --- | ---: |',
  );
  for (const target of contract.internal_targets || []) {
    const sourceCount = [...ownership].filter(
      ([file, componentId]) =>
        ['.c', '.cc', '.cpp', '.cxx'].includes(path.extname(file)) &&
        targetOwns(target, file, componentId),
    ).length;
    lines.push(
      `| \`${target.id}\` | \`${target.kind}\` | \`${target.component}\` | ${(target.dependencies || []).map((item) => `\`${item}\``).join('<br>') || '—'} | ${sourceCount} |`,
    );
  }
  if ((contract.source_constraints || []).length) {
    lines.push(
      '',
      '## Responsibility seams',
      '',
      'These checked source budgets keep storage responsibilities from collapsing',
      'back into the compatibility facade.',
      '',
      '| Responsibility | Source | Line budget |',
      '| --- | --- | ---: |',
    );
    for (const constraint of contract.source_constraints) {
      lines.push(
        `| ${constraint.responsibility || 'Checked source boundary'} | \`${constraint.file}\` | ${constraint.max_lines || '—'} |`,
      );
    }
  }
  if (contract.public_contracts) {
    lines.push(
      '',
      '## Public contracts',
      '',
      'The rows below are expanded and checked from the same authority. Stable',
      'means versioned compatibility; experimental C++ does not freeze STL or',
      'toolchain ABI; source-embedding-only does not promise a shared library.',
      '',
      '| Rule | Level | Minimum profile | Headers | Consumers |',
      '| --- | --- | --- | ---: | --- |',
    );
    const publicHeaders = [...ownership.keys()].filter(
      (file) =>
        (file.startsWith('src/libkungfu/include/') ||
          file.startsWith('src/libyijinjing/include/')) &&
        ['.h', '.hh', '.hpp', '.hxx'].includes(path.extname(file)),
    );
    for (const rule of contract.public_contracts.header_rules || []) {
      const count = publicHeaders.filter((header) =>
        ruleOwns(rule, header),
      ).length;
      lines.push(
        `| \`${rule.id}\` | \`${rule.level}\` | \`${rule.minimum_profile}\` | ${count} | ${rule.consumers.join('<br>')} |`,
      );
    }
    lines.push(
      '',
      '### Stable link-visible symbols',
      '',
      '| Symbol | Owner | ABI versions | Minimum profile |',
      '| --- | --- | --- | --- |',
    );
    for (const symbol of contract.public_contracts.stable_symbols || []) {
      lines.push(
        `| \`${symbol.name}\` | \`${symbol.owner_component}\` | ${symbol.abi_versions.map((version) => `v${version}`).join(', ')} | \`${symbol.minimum_profile}\` |`,
      );
    }
    lines.push(
      '',
      '### Schema, layout and binding parity',
      '',
      '| Contract | Level | Owner / shared semantic authority | Minimum profile |',
      '| --- | --- | --- | --- |',
    );
    for (const layout of contract.public_contracts.schema_layout_contracts ||
      []) {
      lines.push(
        `| \`${layout.id}\` | \`${layout.level}\` | \`${layout.owner_component}\` | \`${layout.minimum_profile}\` |`,
      );
    }
    for (const binding of contract.public_contracts.binding_surfaces || []) {
      lines.push(
        `| binding:\`${binding.id}\` | \`${binding.level}\` | \`${binding.contract}\` | \`${binding.minimum_profile}\` |`,
      );
    }
    lines.push(
      '',
      '### Deprecation authority',
      '',
      'Core contributes governed surfaces to the repository-wide lifecycle',
      'authority; this architecture contract does not own a second ledger.',
      '',
      '| Contract | Registry | Contributed entries |',
      '| --- | --- | --- |',
    );
    const authority = contract.public_contracts.deprecation_authority;
    lines.push(
      `| \`${authority.contract}\` | \`${authority.registry}\` | ${(authority.contributions || []).map((item) => `\`${item}\``).join('<br>')} |`,
    );
  }
  lines.push(
    '',
    '## Navigation',
    '',
    '| Question | Start here |',
    '| --- | --- |',
  );
  for (const item of contract.navigation) {
    lines.push(
      `| ${item.question} | \`${item.component}\` → \`${item.entry_point}\` |`,
    );
  }
  lines.push(
    '',
    '## Gate',
    '',
    '```sh',
    './shifu check:source',
    '```',
    '',
    'The source gate fails when a tracked C/C++ file has zero or multiple owners,',
    'when a current target loses its CMake evidence, when a resolved internal',
    'include is undeclared, when a declared dependency or resolved include reverses',
    'the layer contract, when an internal source has zero or multiple build targets,',
    'when a target edge reverses the layer contract, when a forbidden include enters',
    'a protected layer, when a checked responsibility token or source-size budget',
    'drifts, or when the map or generated CMake projection drifts.',
    '',
  );
  return lines.join('\n');
}

function renderTargetsCmake(contract, ownership) {
  const lines = [
    '# Generated from architecture/layers.json by check-layers.mjs.',
    '# Do not edit this projection directly.',
    '',
  ];
  const objectTargets = [];
  for (const target of contract.internal_targets || []) {
    if (target.kind === 'INTERFACE') {
      lines.push(
        `add_library(${target.id} INTERFACE)`,
        `target_include_directories(${target.id} INTERFACE \${PROJECT_SOURCE_DIR}/include \${KUNGFU_GENERATED_INCLUDE_DIR})`,
        `target_include_directories(${target.id} SYSTEM INTERFACE \${LIBKUNGFU_SQLITE_ORM_INCLUDE})`,
        `target_link_libraries(${target.id} INTERFACE yijinjing kungfu_compile_contract \${KUNGFU_TARGET_${cmakeVariable(target.id)}_DEPENDENCIES})`,
        '',
      );
      continue;
    }
    objectTargets.push(target.id);
    const variable = `${target.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_SOURCE_FILES`;
    const sources = [...ownership]
      .filter(
        ([file, componentId]) =>
          ['.c', '.cc', '.cpp', '.cxx'].includes(path.extname(file)) &&
          targetOwns(target, file, componentId),
      )
      .map(([file]) => file.replace(/^src\/libkungfu\//, ''))
      .sort();
    const options =
      target.compile_options === 'optimize-off'
        ? 'COMPILER_OPTIMIZE_OFF_OPTIONS'
        : 'COMPILER_OPTIMIZE_ON_OPTIONS';
    lines.push(`set(${variable}`);
    for (const source of sources) {
      lines.push(`  "\${PROJECT_SOURCE_DIR}/${source}"`);
    }
    lines.push(')');
    for (const conditional of target.conditional_sources || []) {
      lines.push(
        `if(NOT "${conditional.dependency}" IN_LIST KUNGFU_BUILD_DEPENDENCY_ROOTS)`,
        `  list(REMOVE_ITEM ${variable}`,
      );
      for (const file of conditional.files || []) {
        lines.push(
          `    "\${PROJECT_SOURCE_DIR}/${file.replace(/^src\/libkungfu\//, '')}"`,
        );
      }
      lines.push('  )', 'endif()');
    }
    lines.push(
      `add_library_object(${target.id} "\${${variable}}" "\${${options}}" "\${KUNGFU_BUILD_DIR}")`,
    );
    if ((target.dependencies || []).length) {
      lines.push(
        `target_link_libraries(${target.id} PUBLIC ${(target.dependencies || []).join(' ')})`,
      );
    }
    lines.push(
      `target_link_libraries(${target.id} PUBLIC \${KUNGFU_TARGET_${cmakeVariable(target.id)}_DEPENDENCIES})`,
    );
    lines.push('');
  }
  lines.push('set(KUNGFU_INTERNAL_OBJECTS');
  for (const target of objectTargets) {
    lines.push(`  $<TARGET_OBJECTS:${target}>`);
  }
  lines.push(')', '');
  return lines.join('\n');
}

function renderPublicContractsCmake(contract, ownership) {
  const buildAuthority = JSON.parse(
    fs.readFileSync(buildCapabilitiesPath, 'utf8'),
  );
  const profiles = new Map(
    buildAuthority.profiles.map((profile) => [profile.id, profile]),
  );
  const supported = buildAuthority.profiles.filter(
    (profile) => profile.status === 'supported',
  );
  const eligibleProfiles = (minimumProfile) => {
    const required = new Set(profiles.get(minimumProfile)?.components || []);
    return supported
      .filter((profile) =>
        [...required].every((component) =>
          profile.components.includes(component),
        ),
      )
      .map((profile) => profile.id);
  };
  const publicHeaders = [...ownership.keys()].filter(
    (file) =>
      (file.startsWith('src/libkungfu/include/') ||
        file.startsWith('src/libyijinjing/include/')) &&
      ['.h', '.hh', '.hpp', '.hxx'].includes(path.extname(file)),
  );
  const lines = [
    '# Generated from architecture/layers.json by check-layers.mjs.',
    '# Do not edit this projection directly.',
    '',
    'if(KUNGFU_WITH_CORE_TESTS)',
    '  set(KUNGFU_PUBLIC_HEADER_GENERATED_DIR "${CMAKE_CURRENT_BINARY_DIR}/public-contract-headers")',
    '  file(MAKE_DIRECTORY "${KUNGFU_PUBLIC_HEADER_GENERATED_DIR}")',
  ];
  for (const rule of contract.public_contracts?.header_rules || []) {
    const target = `kungfu_public_headers_${rule.id.replace(/[^A-Za-z0-9]+/g, '_')}`;
    const sourceVariable = `${target.toUpperCase()}_SOURCES`;
    const eligible = eligibleProfiles(rule.minimum_profile);
    lines.push(
      `  if(KUNGFU_BUILD_PROFILE IN_LIST KUNGFU_PUBLIC_${cmakeVariable(rule.id)}_PROFILES)`,
    );
    lines.splice(
      lines.length - 1,
      0,
      `  set(KUNGFU_PUBLIC_${cmakeVariable(rule.id)}_PROFILES "${eligible.join(';')}")`,
    );
    const sources = [];
    const headers = publicHeaders
      .filter((header) => ruleOwns(rule, header))
      .sort();
    headers.forEach((header, index) => {
      const includeMarker = '/include/';
      const includeName = header.slice(
        header.indexOf(includeMarker) + includeMarker.length,
      );
      const language = rule.level === 'stable' ? 'c' : 'cpp';
      const source = `\${KUNGFU_PUBLIC_HEADER_GENERATED_DIR}/${rule.id}-${index}.${language}`;
      lines.push(`    file(WRITE "${source}" "#include <${includeName}>\\n")`);
      sources.push(`"${source}"`);
    });
    lines.push(`    set(${sourceVariable} ${sources.join(' ')})`);
    lines.push(
      `    add_library(${target} OBJECT \${${sourceVariable}})`,
      `    target_link_libraries(${target} PRIVATE ${
        rule.id.startsWith('libyijinjing')
          ? 'yijinjing'
          : rule.level === 'stable'
            ? '${KUNGFU_PUBLIC_ABI_TARGET}'
            : '${LIBKUNGFU_NAME}'
      })`,
    );
    if (rule.level !== 'stable') {
      lines.push(`    target_compile_features(${target} PRIVATE cxx_std_20)`);
    }
    lines.push('  endif()');
  }
  lines.push('endif()', '');
  return lines.join('\n');
}

function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-core-layers-'));
  const write = (rel, text) => {
    const target = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  const base = {
    $schema: 'kungfu.core-architecture/v1',
    tracked_roots: ['src/'],
    extensions: ['.h', '.cpp'],
    excluded_files: [],
    component_budget: { min: 2, max: 2 },
    target_evidence: [{ file: 'CMakeLists.txt', targets: ['low', 'high'] }],
    internal_target_roots: ['src/'],
    layers: [
      {
        id: 'low',
        order: 0,
        responsibility: 'low',
        may_depend_on: ['low'],
        forbidden_include_prefixes: ['high/'],
      },
      {
        id: 'high',
        order: 1,
        responsibility: 'high',
        may_depend_on: ['high', 'low'],
        forbidden_include_prefixes: [],
      },
    ],
    components: [
      {
        id: 'low-core',
        layer: 'low',
        owner: 'low',
        include_prefixes: ['src/low/'],
        include_files: [],
        exclude_prefixes: [],
        exclude_files: [],
        dependencies: [],
        current_targets: ['low'],
        entry_points: ['src/low/include/low/value.h'],
        contract_tests: ['low'],
      },
      {
        id: 'high-app',
        layer: 'high',
        owner: 'high',
        include_prefixes: ['src/high/'],
        include_files: [],
        exclude_prefixes: [],
        exclude_files: [],
        dependencies: ['low-core'],
        current_targets: ['high'],
        entry_points: ['src/high/app.cpp'],
        contract_tests: ['high'],
      },
    ],
    internal_targets: [
      {
        id: 'low',
        component: 'low-core',
        kind: 'INTERFACE',
        dependencies: [],
      },
      {
        id: 'high',
        component: 'high-app',
        kind: 'OBJECT',
        dependencies: ['low'],
      },
    ],
    source_constraints: [
      {
        file: 'src/high/app.cpp',
        responsibility: 'high application seam',
        max_lines: 2,
        required_text: ['#include <low/value.h>'],
        forbidden_text: ['low::forbidden'],
      },
    ],
    navigation: [],
  };
  const expect = (label, condition) => {
    console.log(`  ${condition ? 'ok' : 'MISS'}: ${label}`);
    if (!condition) throw new Error(`self-test missed: ${label}`);
  };
  try {
    write('CMakeLists.txt', 'add_library(low)\nadd_library(high)\n');
    write('src/low/include/low/value.h', '#pragma once\n');
    write('src/high/app.cpp', '#include <low/value.h>\n');
    write('src/high/include/high/service.h', '#pragma once\n');
    expect('clean contract passes', validate(tmp, base).problems.length === 0);

    const missingTarget = structuredClone(base);
    missingTarget.target_evidence[0].targets = ['low'];
    expect(
      'target without CMake evidence fails',
      validate(tmp, missingTarget).problems.some((item) =>
        item.includes('target lacks CMake evidence'),
      ),
    );

    write('src/orphan.cpp', 'int orphan = 0;\n');
    expect(
      'unclassified source fails',
      validate(tmp, base).problems.some((item) =>
        item.includes('unclassified file'),
      ),
    );
    fs.rmSync(path.join(tmp, 'src/orphan.cpp'));

    const duplicate = structuredClone(base);
    duplicate.components[1].include_prefixes.push('src/low/');
    expect(
      'multiple ownership fails',
      validate(tmp, duplicate).problems.some((item) =>
        item.includes('multiply owned file'),
      ),
    );

    const overBudget = structuredClone(base);
    overBudget.component_budget.max = 1;
    expect(
      'component budget overflow fails',
      validate(tmp, overBudget).problems.some((item) =>
        item.includes('outside budget'),
      ),
    );

    write('src/low/include/low/value.h', '#include <high/service.h>\n');
    expect(
      'forbidden reverse include fails',
      validate(tmp, base).problems.some((item) =>
        item.includes('forbids include'),
      ),
    );

    const resolvedReverse = structuredClone(base);
    resolvedReverse.layers[0].forbidden_include_prefixes = [];
    expect(
      'resolved internal reverse include fails',
      validate(tmp, resolvedReverse).problems.some((item) =>
        item.includes('may not include'),
      ),
    );
    write('src/low/include/low/value.h', '#pragma once\n');

    const undeclared = structuredClone(base);
    undeclared.components[1].dependencies = [];
    expect(
      'undeclared resolved dependency fails',
      validate(tmp, undeclared).problems.some((item) =>
        item.includes('undeclared dependency'),
      ),
    );

    const reversed = structuredClone(base);
    reversed.components[0].dependencies = ['high-app'];
    expect(
      'declared reverse dependency fails',
      validate(tmp, reversed).problems.some((item) =>
        item.includes('may not depend'),
      ),
    );

    const reversedTarget = structuredClone(base);
    reversedTarget.internal_targets[0].dependencies = ['high'];
    expect(
      'reverse target dependency fails',
      validate(tmp, reversedTarget).problems.some((item) =>
        item.includes('may not depend on target'),
      ),
    );

    const componentCycle = structuredClone(base);
    componentCycle.components[0].dependencies = ['high-app'];
    expect(
      'component dependency cycle fails',
      validate(tmp, componentCycle).problems.some((item) =>
        item.includes('component dependency cycle'),
      ),
    );

    const targetCycle = structuredClone(base);
    targetCycle.internal_targets[0].dependencies = ['high'];
    expect(
      'internal target dependency cycle fails',
      validate(tmp, targetCycle).problems.some((item) =>
        item.includes('internal target dependency cycle'),
      ),
    );

    const undeclaredTargetComponent = structuredClone(base);
    undeclaredTargetComponent.components[1].dependencies = [];
    expect(
      'target edge outside component graph fails',
      validate(tmp, undeclaredTargetComponent).problems.some((item) =>
        item.includes('is not declared by component'),
      ),
    );

    const missingContractTest = structuredClone(base);
    missingContractTest.components[1].contract_tests = ['missing-test'];
    expect(
      'contract test without CMake evidence fails',
      validate(tmp, missingContractTest).problems.some((item) =>
        item.includes('contract test lacks CMake evidence'),
      ),
    );

    const missingSourceTarget = structuredClone(base);
    missingSourceTarget.internal_targets[1].include_files = [
      'src/high/not-app.cpp',
    ];
    expect(
      'source without internal target fails',
      validate(tmp, missingSourceTarget).problems.some((item) =>
        item.includes('source lacks internal target'),
      ),
    );

    const duplicateSourceTarget = structuredClone(base);
    duplicateSourceTarget.internal_targets.push({
      id: 'high-copy',
      component: 'high-app',
      kind: 'OBJECT',
      dependencies: ['low'],
    });
    expect(
      'source with multiple internal targets fails',
      validate(tmp, duplicateSourceTarget).problems.some((item) =>
        item.includes('source has multiple internal targets'),
      ),
    );

    const missingResponsibility = structuredClone(base);
    missingResponsibility.source_constraints[0].required_text = [
      'missing-responsibility-token',
    ];
    expect(
      'missing responsibility token fails',
      validate(tmp, missingResponsibility).problems.some((item) =>
        item.includes('missing required responsibility token'),
      ),
    );

    const collapsedResponsibility = structuredClone(base);
    collapsedResponsibility.source_constraints[0].forbidden_text = [
      '#include <low/value.h>',
    ];
    expect(
      'forbidden responsibility token fails',
      validate(tmp, collapsedResponsibility).problems.some((item) =>
        item.includes('forbidden responsibility token'),
      ),
    );

    const oversizedResponsibility = structuredClone(base);
    oversizedResponsibility.source_constraints[0].max_lines = 1;
    expect(
      'source responsibility budget fails',
      validate(tmp, oversizedResponsibility).problems.some((item) =>
        item.includes('exceeds architecture budget'),
      ),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const production = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  expect(
    'clean public contract inventory passes',
    validate(coreRoot, production).problems.length === 0,
  );
  const missingPublicHeader = structuredClone(production);
  missingPublicHeader.public_contracts.header_rules[0].include_files.shift();
  expect(
    'unclassified public header fails',
    validate(coreRoot, missingPublicHeader).problems.some((item) =>
      item.includes('unclassified public header'),
    ),
  );
  const duplicatePublicHeader = structuredClone(production);
  duplicatePublicHeader.public_contracts.header_rules[1].exclude_files = [];
  expect(
    'multiply classified public header fails',
    validate(coreRoot, duplicatePublicHeader).problems.some((item) =>
      item.includes('multiply classified public header'),
    ),
  );
  const missingStableSymbol = structuredClone(production);
  missingStableSymbol.public_contracts.stable_symbols[0].name =
    'missing_stable_bootstrap';
  expect(
    'stable symbol drift fails',
    validate(coreRoot, missingStableSymbol).problems.some((item) =>
      item.includes('stable symbol missing'),
    ),
  );
  const bindingParityDrift = structuredClone(production);
  bindingParityDrift.public_contracts.binding_surfaces[0].semantic_axes = [
    'version',
    'error',
  ];
  expect(
    'binding parity drift fails',
    validate(coreRoot, bindingParityDrift).problems.some((item) =>
      item.includes('binding parity semantics drifted'),
    ),
  );
  const missingRetainedFixture = structuredClone(production);
  missingRetainedFixture.public_contracts.schema_layout_contracts[0].retained_fixture =
    'src/libyijinjing/tests/fixtures/missing.json';
  expect(
    'missing retained layout fixture fails',
    validate(coreRoot, missingRetainedFixture).problems.some((item) =>
      item.includes('missing retained fixture'),
    ),
  );
  const incompleteDeprecation = structuredClone(production);
  incompleteDeprecation.public_contracts.deprecation_authority.registry =
    '../deprecation/missing-registry.json';
  expect(
    'missing common deprecation authority fails',
    validate(coreRoot, incompleteDeprecation).problems.some((item) =>
      item.includes('common deprecation registry is missing'),
    ),
  );
  console.log(
    'OK: core architecture negative fixtures fail for the intended reasons.',
  );
}

if (process.argv.includes('--self-test')) {
  selfTest();
  process.exit(0);
}

const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const result = validate(coreRoot, contract);
if (result.problems.length) {
  console.error(result.problems.join('\n'));
  process.exit(1);
}
const rendered = renderMap(contract, result.ownership);
const renderedTargetsCmake = renderTargetsCmake(contract, result.ownership);
const renderedPublicContractsCmake = renderPublicContractsCmake(
  contract,
  result.ownership,
);
if (process.argv.includes('--write-projections')) {
  fs.writeFileSync(mapPath, rendered);
  fs.writeFileSync(targetsCmakePath, renderedTargetsCmake);
  fs.writeFileSync(publicContractsCmakePath, renderedPublicContractsCmake);
  console.log(
    'Updated LAYERS.md, TARGETS.cmake and PUBLIC_CONTRACTS.cmake from the architecture authority.',
  );
  process.exit(0);
}
if (process.argv.includes('--print-map')) {
  process.stdout.write(rendered);
  process.exit(0);
}
if (process.argv.includes('--print-targets')) {
  process.stdout.write(renderedTargetsCmake);
  process.exit(0);
}
if (process.argv.includes('--print-public-contracts')) {
  process.stdout.write(renderedPublicContractsCmake);
  process.exit(0);
}
if (!fs.existsSync(mapPath) || fs.readFileSync(mapPath, 'utf8') !== rendered) {
  console.error(
    'framework/core/architecture/LAYERS.md is stale; regenerate it from layers.json.',
  );
  process.exit(1);
}
if (
  !fs.existsSync(targetsCmakePath) ||
  fs.readFileSync(targetsCmakePath, 'utf8') !== renderedTargetsCmake
) {
  console.error(
    'framework/core/architecture/TARGETS.cmake is stale; regenerate it from layers.json.',
  );
  process.exit(1);
}
if (
  !fs.existsSync(publicContractsCmakePath) ||
  fs.readFileSync(publicContractsCmakePath, 'utf8') !==
    renderedPublicContractsCmake
) {
  console.error(
    'framework/core/architecture/PUBLIC_CONTRACTS.cmake is stale; regenerate it from layers.json.',
  );
  process.exit(1);
}
console.log(
  `OK: ${result.ownership.size} first-party C/C++ files have one component owner; public contracts, the layer map and internal target graph are current.`,
);
