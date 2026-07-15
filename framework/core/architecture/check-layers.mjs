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

function posix(value) {
  return value.split(path.sep).join('/');
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
    if (
      !Array.isArray(component.current_targets) ||
      component.current_targets.length === 0
    ) {
      problems.push(`${component.id}: current_targets must not be empty`);
    }
    for (const target of component.current_targets || [])
      usedTargets.add(target);
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
      if (!cmake.includes(token)) {
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
        !sourceLayer.may_depend_on.includes(dependencyComponent.layer)
      ) {
        problems.push(
          `${target.id}: layer ${sourceComponent.layer} may not depend on target ${dependencyId} (${dependencyComponent.layer})`,
        );
      }
    }
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
    '',
    '| Component | Layer | Owner | Files | Current targets | Entry points |',
    '| --- | --- | --- | ---: | --- | --- |',
  );
  const counts = new Map();
  for (const componentId of ownership.values()) {
    counts.set(componentId, (counts.get(componentId) || 0) + 1);
  }
  for (const component of contract.components) {
    lines.push(
      `| \`${component.id}\` | \`${component.layer}\` | \`${component.owner}\` | ${counts.get(component.id) || 0} | ${component.current_targets.map((item) => `\`${item}\``).join('<br>')} | ${component.entry_points.map((item) => `\`${item}\``).join('<br>')} |`,
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
    'a protected layer, or when the map or generated CMake projection drifts.',
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
        `target_link_libraries(${target.id} INTERFACE yijinjing kungfu_compile_contract \${CONAN_LIBS})`,
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
    lines.push(
      ')',
      `add_library_object(${target.id} "\${${variable}}" "\${${options}}" "\${KUNGFU_BUILD_DIR}")`,
    );
    if ((target.dependencies || []).length) {
      lines.push(
        `target_link_libraries(${target.id} PUBLIC ${(target.dependencies || []).join(' ')})`,
      );
    }
    lines.push('');
  }
  lines.push('set(KUNGFU_INTERNAL_OBJECTS');
  for (const target of objectTargets) {
    lines.push(`  $<TARGET_OBJECTS:${target}>`);
  }
  lines.push(')', '');
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
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
if (process.argv.includes('--write-projections')) {
  fs.writeFileSync(mapPath, rendered);
  fs.writeFileSync(targetsCmakePath, renderedTargetsCmake);
  console.log(
    'Updated LAYERS.md and TARGETS.cmake from the architecture authority.',
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
console.log(
  `OK: ${result.ownership.size} first-party C/C++ files have one component owner; the layer map and internal target graph are current.`,
);
