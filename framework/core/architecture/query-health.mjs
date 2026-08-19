#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const architectureRoot = path.dirname(fileURLToPath(import.meta.url));
const coreRoot = path.resolve(architectureRoot, '..');
const root = path.resolve(coreRoot, '..', '..');
const layersPath = path.join(architectureRoot, 'layers.json');
const buildPath = path.join(architectureRoot, 'build-capabilities.json');
const affectedBaselinePath = path.join(
  architectureRoot,
  'affected-native-baseline.json',
);
const healthBaselinePath = path.join(
  architectureRoot,
  'architecture-health-baseline.json',
);
const indexPath = path.join(architectureRoot, 'ARCHITECTURE_INDEX.md');
const healthPath = path.join(architectureRoot, 'ARCHITECTURE_HEALTH.md');
const reviewRoutesPath = path.join(architectureRoot, 'review-routes.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(ordered(value)))
    .digest('hex')}`;
}

function unique(values) {
  return [...new Set(values)].sort();
}

function owns(rule, file) {
  const included =
    (rule.include_files || []).includes(file) ||
    (rule.include_prefixes || []).some((prefix) => file.startsWith(prefix));
  return (
    included &&
    !(rule.exclude_files || []).includes(file) &&
    !(rule.exclude_prefixes || []).some((prefix) => file.startsWith(prefix))
  );
}

function publicSurface(layers, file) {
  return (layers.public_contracts.header_rules || []).filter((rule) =>
    owns(rule, file),
  );
}

function componentProfiles(componentId, build) {
  const buildComponents = build.components
    .filter((component) =>
      component.architecture_components.includes(componentId),
    )
    .map((component) => component.id);
  return build.profiles
    .filter((profile) =>
      (profile.components || []).some((item) => buildComponents.includes(item)),
    )
    .map((profile) => profile.id)
    .sort();
}

function componentDiagnostic(layers, componentId) {
  return layers.diagnostics.filter(
    (diagnostic) => diagnostic.component === componentId,
  );
}

function componentRecord(layers, build, component, reasons = []) {
  const diagnostics = componentDiagnostic(layers, component.id);
  return {
    component: component.id,
    layer: component.layer,
    responsibility: layers.layers.find((layer) => layer.id === component.layer)
      ?.responsibility,
    owner: component.owner,
    reviewers: [
      layers.review_policy.architecture_reviewer_role,
      layers.review_policy.fallback_account,
    ],
    entryPoints: component.entry_points,
    dependencies: component.dependencies,
    targets: component.current_targets,
    profiles: componentProfiles(component.id, build),
    tests: component.contract_tests,
    publicSurfaces: unique(
      (layers.public_contracts.stable_symbols || [])
        .filter((symbol) => symbol.owner_component === component.id)
        .map((symbol) => symbol.name)
        .concat(
          (layers.public_contracts.schema_layout_contracts || [])
            .filter((contract) => contract.owner_component === component.id)
            .map((contract) => contract.id),
        ),
    ),
    diagnostics: diagnostics.map((diagnostic) => diagnostic.id),
    documents: unique(diagnostics.map((diagnostic) => diagnostic.document)),
    runbooks: unique(diagnostics.map((diagnostic) => diagnostic.runbook)),
    adrs: unique(diagnostics.flatMap((diagnostic) => diagnostic.adrs)),
    products: unique(diagnostics.flatMap((diagnostic) => diagnostic.products)),
    impactReasons: unique(reasons),
  };
}

function parseArgs(argv) {
  const options = {
    selector: '',
    value: '',
    json: false,
    health: false,
    write: false,
    selfTest: false,
  };
  const selectors = new Set([
    '--path',
    '--component',
    '--target',
    '--symbol',
    '--error',
    '--capability',
    '--profile',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (selectors.has(arg)) {
      if (options.selector) throw new Error('select exactly one query axis');
      options.selector = arg.slice(2);
      options.value = argv[++index] || '';
    } else if (arg === '--json') options.json = true;
    else if (arg === '--health') options.health = true;
    else if (arg === '--write-projections') options.write = true;
    else if (arg === '--self-test') options.selfTest = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function query(layers, build, selector, value) {
  const normalized = value.toLowerCase();
  let matches = [];
  if (selector === 'path') {
    const coreFile = value.startsWith('framework/core/')
      ? value.slice('framework/core/'.length)
      : value;
    const owners = layers.components.filter((component) =>
      owns(component, coreFile),
    );
    if (owners.length !== 1)
      throw new Error(
        `${value}: expected one component owner, found ${owners.length}`,
      );
    const surfaces = publicSurface(layers, coreFile);
    matches = [
      componentRecord(layers, build, owners[0], [
        `path:${coreFile}`,
        ...surfaces.map((surface) => `public:${surface.id}:${surface.level}`),
      ]),
    ];
  } else if (selector === 'component') {
    matches = layers.components
      .filter((component) => component.id === value)
      .map((component) =>
        componentRecord(layers, build, component, [`component:${value}`]),
      );
  } else if (selector === 'target') {
    matches = layers.components
      .filter((component) => component.current_targets.includes(value))
      .map((component) =>
        componentRecord(layers, build, component, [`target:${value}`]),
      );
  } else if (selector === 'symbol') {
    const symbols = layers.public_contracts.stable_symbols.filter(
      (symbol) => symbol.name === value,
    );
    matches = symbols.map((symbol) => {
      const component = layers.components.find(
        (candidate) => candidate.id === symbol.owner_component,
      );
      return {
        ...componentRecord(layers, build, component, [
          `stable-symbol:${value}`,
          `abi-versions:${symbol.abi_versions.join(',')}`,
        ]),
        symbol,
      };
    });
  } else if (selector === 'error' || selector === 'capability') {
    const diagnostics = layers.diagnostics.filter((diagnostic) =>
      selector === 'error'
        ? diagnostic.error_tokens.some((token) =>
            normalized.includes(token.toLowerCase()),
          )
        : diagnostic.capabilities.includes(value),
    );
    matches = diagnostics.map((diagnostic) => {
      const component = layers.components.find(
        (candidate) => candidate.id === diagnostic.component,
      );
      return {
        ...componentRecord(layers, build, component, [
          `${selector}:${value}`,
          `diagnostic:${diagnostic.id}`,
        ]),
        matchedDiagnostic: diagnostic,
      };
    });
  } else if (selector === 'profile') {
    const profile = build.profiles.find((candidate) => candidate.id === value);
    if (profile) {
      const buildComponentIds = new Set(profile.components || []);
      const architectureIds = new Set(
        build.components
          .filter((component) => buildComponentIds.has(component.id))
          .flatMap((component) => component.architecture_components),
      );
      matches = layers.components
        .filter((component) => architectureIds.has(component.id))
        .map((component) =>
          componentRecord(layers, build, component, [`profile:${value}`]),
        );
    }
  }
  if (!matches.length)
    throw new Error(`no architecture match for ${selector}:${value}`);
  return {
    schema: 'kungfu.core-architecture-query/v1',
    authorityRoot: digest({ layers, build }),
    query: { selector, value },
    matches,
  };
}

function gitLines(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  return result.stdout.split('\n').filter(Boolean);
}

function matchesAdrRecordPath(adr, file) {
  if (path.posix.dirname(file) !== 'docs/adr') return false;
  return file === `docs/adr/${adr}.md`;
}

function trackedFiles(layers) {
  return unique(
    layers.tracked_roots.flatMap((trackedRoot) =>
      gitLines(['ls-files', `framework/core/${trackedRoot}`]).map((file) =>
        file.slice('framework/core/'.length),
      ),
    ),
  ).filter((file) => /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(file));
}

function cycleCount(components) {
  const graph = new Map(
    components.map((component) => [component.id, component.dependencies]),
  );
  let count = 0;
  const state = new Map();
  function visit(id) {
    if (state.get(id) === 1) {
      count += 1;
      return;
    }
    if (state.get(id) === 2) return;
    state.set(id, 1);
    for (const dependency of graph.get(id) || []) visit(dependency);
    state.set(id, 2);
  }
  for (const id of graph.keys()) visit(id);
  return count;
}

function reverseClosureSize(components, start) {
  const reverse = new Map(components.map((component) => [component.id, []]));
  for (const component of components) {
    for (const dependency of component.dependencies) {
      reverse.get(dependency)?.push(component.id);
    }
  }
  const seen = new Set([start]);
  const pending = [start];
  while (pending.length) {
    for (const consumer of reverse.get(pending.shift()) || []) {
      if (!seen.has(consumer)) {
        seen.add(consumer);
        pending.push(consumer);
      }
    }
  }
  return seen.size;
}

function lineCount(relative) {
  return fs.readFileSync(path.join(coreRoot, relative), 'utf8').split('\n')
    .length;
}

function retainedChurnByComponent(layers, healthBaseline) {
  const retained = healthBaseline?.detail?.churn;
  const componentIds = layers.components
    .map((component) => component.id)
    .sort();
  if (
    !retained ||
    JSON.stringify(Object.keys(retained).sort()) !==
      JSON.stringify(componentIds) ||
    Object.values(retained).some(
      (value) => !Number.isInteger(value) || value < 0,
    ) ||
    Math.max(...Object.values(retained)) !==
      healthBaseline?.values?.maximum_component_churn
  )
    throw new Error(
      'architecture health baseline must retain exact per-component churn',
    );
  return Object.fromEntries(
    Object.entries(retained).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function churnByComponent(layers, healthBaseline) {
  const historyHead = healthBaseline?.sourceSha;
  if (!/^[0-9a-f]{40}$/.test(historyHead || ''))
    throw new Error(
      'architecture health baseline sourceSha must be an exact lowercase Git SHA',
    );
  const retained = retainedChurnByComponent(layers, healthBaseline);
  const available = spawnSync(
    'git',
    ['cat-file', '-e', `${historyHead}^{commit}`],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  if (available.status !== 0) return retained;
  const window = layers.health_policy.churn_window;
  const files = gitLines([
    'log',
    historyHead,
    '--format=',
    '--name-only',
    `--since=${window.since}T00:00:00Z`,
    `--until=${window.until}T23:59:59Z`,
    '--',
    'framework/core',
  ]).map((file) =>
    file.startsWith('framework/core/')
      ? file.slice('framework/core/'.length)
      : file,
  );
  const counts = new Map(
    layers.components.map((component) => [component.id, 0]),
  );
  for (const file of files) {
    const owner = layers.components.find((component) => owns(component, file));
    if (owner) counts.set(owner.id, (counts.get(owner.id) || 0) + 1);
  }
  const observed = Object.fromEntries([...counts.entries()].sort());
  if (JSON.stringify(observed) !== JSON.stringify(retained))
    throw new Error(
      'architecture health baseline churn does not match its exact sourceSha',
    );
  return observed;
}

function health(layers, build, affectedBaseline, healthBaseline) {
  const files = trackedFiles(layers);
  const ownershipCounts = Object.fromEntries(
    layers.components.map((component) => [
      component.id,
      files.filter((file) => owns(component, file)).length,
    ]),
  );
  const responsibility = layers.source_constraints.map((constraint) => ({
    file: constraint.file,
    lines: lineCount(constraint.file),
    budget: constraint.max_lines,
  }));
  const propagation = layers.components.map((component) => ({
    component: component.id,
    consumers: reverseClosureSize(layers.components, component.id),
  }));
  const churn = churnByComponent(layers, healthBaseline);
  const durations = (affectedBaseline.measurements || [])
    .filter((measurement) => measurement.status === 'passed')
    .map((measurement) => measurement.durationMs);
  const values = {
    component_cycles: cycleCount(layers.components),
    maximum_component_fanout: Math.max(
      ...layers.components.map((component) => component.dependencies.length),
    ),
    maximum_public_header_propagation: Math.max(
      ...propagation.map((record) => record.consumers),
    ),
    maximum_responsibility_utilization_percent: Math.max(
      ...responsibility.map((record) =>
        Math.ceil((record.lines * 100) / record.budget),
      ),
    ),
    maximum_component_churn: Math.max(...Object.values(churn)),
    affected_native_duration_ms: durations.length
      ? Math.max(...durations)
      : null,
    binary_size_bytes: null,
    external_dependency_closure: unique(
      build.components.flatMap((component) => component.dependencies),
    ).length,
  };
  return {
    schema: 'kungfu.core-architecture-health/v1',
    authorityRoot: digest({ layers, build }),
    baselineId: layers.health_policy.baseline_id,
    values,
    detail: { ownershipCounts, responsibility, propagation, churn },
  };
}

function healthFindings(
  report,
  layers,
  baseline,
  { blockingOnly = false } = {},
) {
  const findings = [];
  for (const [id, policy] of Object.entries(layers.health_policy.metrics)) {
    if (blockingOnly && !policy.blocking) continue;
    const value = report.values[id];
    const baselineValue = baseline?.values?.[id];
    if (value === null) {
      if (policy.blocking) findings.push(`${id}: missing required measurement`);
      continue;
    }
    if (policy.budget !== null && value > policy.budget)
      findings.push(`${id}: ${value} exceeds budget ${policy.budget}`);
    if (
      baselineValue !== null &&
      baselineValue !== undefined &&
      ['lower', 'zero'].includes(policy.direction) &&
      value > baselineValue
    ) {
      findings.push(`${id}: ${value} regressed from baseline ${baselineValue}`);
    }
  }
  return findings;
}

function reviewRoutes(layers) {
  return {
    schema: 'kungfu.core-review-routes/v1',
    authorityRoot: digest(layers),
    fallbackAccount: layers.review_policy.fallback_account,
    routes: layers.components.map((component) => ({
      component: component.id,
      paths: unique([
        ...(component.include_prefixes || []),
        ...(component.include_files || []),
      ]),
      ownerRole: component.owner,
      backupRole: layers.review_policy.architecture_reviewer_role,
      fallbackAccount: layers.review_policy.fallback_account,
      tests: component.contract_tests,
    })),
  };
}

function renderIndex(layers, build) {
  const rows = layers.components.map((component) => {
    const diagnostics = componentDiagnostic(layers, component.id);
    return `| \`${component.id}\` | \`${component.owner}\` | \`${layers.review_policy.architecture_reviewer_role}\` | ${component.entry_points.map((entry) => `\`${entry}\``).join('<br>')} | ${component.current_targets.map((target) => `\`${target}\``).join('<br>')} | ${
      componentProfiles(component.id, build)
        .map((profile) => `\`${profile}\``)
        .join('<br>') || '—'
    } | ${component.contract_tests.map((test) => `\`${test}\``).join('<br>')} | ${diagnostics.map((item) => `\`${item.id}\``).join('<br>') || '—'} |`;
  });
  return `---\nmetadata_schema: kungfu.document-metadata/v1\ndocument_status: active\nperiod: ongoing\ntheme: kungfu-core-architecture-query\ndoc_type: generated-architecture-index\nsources: [local-files]\nconfidence: high\nsensitivity: public\nevidence_grade: A\nreview_state: self-reviewed\nlast_reviewed: 2026-07-15\n---\n\n# Core Architecture Query Index\n\nGenerated from \`layers.json\` and \`build-capabilities.json\`. Do not edit by hand. The projection contains only checked-in authority facts and does not identify unrecorded human maintainers.\n\n| Component | Owner | Backup reviewer | Entry points | Targets | Profiles | Tests | Diagnostics |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\n## Query\n\n\`./shifu core:architecture --path framework/core/src/libkungfu/src/runtime/storage/service.cpp\`\n\nUse one of \`--path\`, \`--component\`, \`--target\`, \`--symbol\`, \`--error\`, \`--capability\`, or \`--profile\`; append \`--json\` for the stable machine surface.\n`;
}

function renderHealth(report, layers, baseline, observations) {
  const evidenceNote =
    report.values.affected_native_duration_ms === null
      ? 'Binary size and successful affected-native timing remain unknown until retained qualification artifacts exist.'
      : 'Affected-native timing comes from retained qualification evidence; binary size remains release-owned because PR source authority has no stable packaged artifact.';
  const rows = Object.entries(layers.health_policy.metrics).map(
    ([id, policy]) =>
      `| \`${id}\` | ${report.values[id] ?? 'unknown'} | ${baseline?.values?.[id] ?? 'unknown'} | ${policy.budget ?? 'advisory'} | ${policy.blocking ? 'blocking' : `advisory: ${policy.reason}`} |`,
  );
  return `---\nmetadata_schema: kungfu.document-metadata/v1\ndocument_status: active\nperiod: 2026-06-01/2026-07-15\ntheme: kungfu-core-architecture-health\ndoc_type: generated-health-report\nsources: [local-files]\nconfidence: high\nsensitivity: public\nevidence_grade: A\nreview_state: self-reviewed\nlast_reviewed: 2026-07-15\n---\n\n# Core Architecture Health\n\nGenerated from the architecture authority and repository facts. Metrics are structural signals, not individual performance measures. ${evidenceNote}\n\nAuthority root: \`${report.authorityRoot}\`\n\n| Metric | Current | Baseline | Budget | Policy |\n| --- | ---: | ---: | ---: | --- |\n${rows.join('\n')}\n\nObservations:${observations.length ? observations.map((observation) => `\n- ${observation}`).join('') : ' none.'}\n`;
}

function validateAuthority(layers, build) {
  const problems = [];
  const trackedAdrPaths = gitLines(['ls-files', 'docs/adr/*.md']);
  const ids = new Set(layers.components.map((component) => component.id));
  if (layers.components.length < 6 || layers.components.length > 12)
    problems.push('component count is outside the governed 6-12 range');
  for (const component of layers.components) {
    if (!component.owner) problems.push(`${component.id}: missing owner role`);
  }
  for (const diagnostic of layers.diagnostics) {
    if (!ids.has(diagnostic.component))
      problems.push(`${diagnostic.id}: unknown component`);
    for (const file of [diagnostic.document, diagnostic.runbook]) {
      if (!fs.existsSync(path.join(root, file)))
        problems.push(`${diagnostic.id}: missing ${file}`);
    }
    for (const adr of diagnostic.adrs) {
      if (!trackedAdrPaths.some((file) => matchesAdrRecordPath(adr, file)))
        problems.push(`${diagnostic.id}: missing ${adr}`);
    }
  }
  if (!layers.review_policy.architecture_reviewer_role)
    problems.push('missing architecture reviewer role');
  if (!layers.review_policy.fallback_account.startsWith('@'))
    problems.push('fallback account must be a real GitHub account reference');
  const mapped = new Set(
    build.components.flatMap((component) => component.architecture_components),
  );
  for (const component of layers.components) {
    if (component.layer !== 'qualification' && !mapped.has(component.id))
      problems.push(`${component.id}: missing build capability mapping`);
  }
  return problems;
}

function selfTest(layers, build, healthBaseline) {
  const canonicalAdr = 'KF-ADR-019f86da-4f90-7f8a-9bff-e4f7683da35f';
  const adrPathScenarios = [
    [canonicalAdr, `docs/adr/${canonicalAdr}.md`, true],
    [canonicalAdr, `docs/adr/${canonicalAdr}-not-canonical.md`, false],
    [canonicalAdr, `docs/adr/archive/${canonicalAdr}.md`, false],
    [canonicalAdr, `docs/adr/${canonicalAdr}/nested.md`, false],
  ];
  for (const [adr, file, expected] of adrPathScenarios) {
    if (matchesAdrRecordPath(adr, file) !== expected)
      throw new Error(`${adr}:${file} ADR path classification drifted`);
  }
  console.log('  ok: canonical ADR record paths resolve exactly');
  const scenarios = [
    [
      'path',
      'framework/core/src/libkungfu/src/runtime/storage/query_render.cpp',
      'runtime-storage-services',
    ],
    ['symbol', 'kungfu_get_api', 'core-composition-bindings'],
    ['error', 'unsupported api version', 'core-composition-bindings'],
    ['capability', 'live', 'runtime-live-services'],
    ['profile', 'journal', 'yijinjing-schema'],
  ];
  for (const [selector, value, expected] of scenarios) {
    const result = query(layers, build, selector, value);
    if (!result.matches.some((match) => match.component === expected))
      throw new Error(`${selector}:${value} did not locate ${expected}`);
    if (
      result.matches.some(
        (match) =>
          !match.owner || !match.reviewers.length || !match.tests.length,
      )
    ) {
      throw new Error(`${selector}:${value} returned an incomplete route`);
    }
    console.log(`  ok: ${selector}:${value} -> ${expected}`);
  }
  let rejected = false;
  try {
    query(layers, build, 'capability', 'not-a-capability');
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('unknown capability did not fail closed');
  console.log('  ok: unknown capability fails closed');
  const missingOwner = structuredClone(layers);
  missingOwner.components[0].owner = '';
  if (
    !validateAuthority(missingOwner, build).some((item) =>
      item.includes('missing owner'),
    )
  )
    throw new Error('missing owner did not fail closed');
  console.log('  ok: missing owner fails closed');
  const cyclic = structuredClone(layers.components);
  cyclic[0].dependencies = [cyclic.at(-1).id];
  if (cycleCount(cyclic) === 0)
    throw new Error('component cycle was not detected');
  console.log('  ok: component cycle is visible');
  const regression = {
    values: { maximum_component_fanout: 12 },
  };
  const regressionPolicy = structuredClone(layers);
  regressionPolicy.health_policy.metrics = {
    maximum_component_fanout:
      layers.health_policy.metrics.maximum_component_fanout,
  };
  const regressionBaseline = { values: { maximum_component_fanout: 11 } };
  if (!healthFindings(regression, regressionPolicy, regressionBaseline).length)
    throw new Error('health regression did not fail closed');
  console.log('  ok: health regression fails closed');
  regressionPolicy.health_policy.metrics.maximum_component_fanout.blocking = false;
  if (
    healthFindings(regression, regressionPolicy, regressionBaseline, {
      blockingOnly: true,
    }).length
  )
    throw new Error('advisory regression blocked development');
  console.log('  ok: advisory regression stays visible without blocking');
  let implicitHistoryRejected = false;
  try {
    churnByComponent(layers, { ...healthBaseline, sourceSha: 'HEAD' });
  } catch (error) {
    implicitHistoryRejected = error.message.includes('exact lowercase Git SHA');
  }
  if (!implicitHistoryRejected)
    throw new Error('architecture churn accepted an implicit history head');
  const pinnedChurn = churnByComponent(layers, healthBaseline);
  if (
    Math.max(...Object.values(pinnedChurn)) !==
    healthBaseline?.values?.maximum_component_churn
  )
    throw new Error('baseline-pinned architecture churn drifted');
  const incompleteChurn = structuredClone(healthBaseline);
  delete incompleteChurn.detail.churn[layers.components[0].id];
  let incompleteChurnRejected = false;
  try {
    retainedChurnByComponent(layers, incompleteChurn);
  } catch (error) {
    incompleteChurnRejected = error.message.includes('per-component churn');
  }
  if (!incompleteChurnRejected)
    throw new Error(
      'incomplete retained architecture churn did not fail closed',
    );
  console.log(
    '  ok: architecture churn is pinned to the exact baseline history',
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const layers = readJson(layersPath);
  const build = readJson(buildPath);
  const affectedBaseline = readJson(affectedBaselinePath);
  const healthBaseline = fs.existsSync(healthBaselinePath)
    ? readJson(healthBaselinePath)
    : null;
  const problems = validateAuthority(layers, build);
  if (problems.length) throw new Error(problems.join('\n'));
  if (options.selfTest) return selfTest(layers, build, healthBaseline);
  if (options.selector) {
    const result = query(layers, build, options.selector, options.value);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`authority=${result.authorityRoot}`);
      for (const match of result.matches) {
        console.log(`${match.component} [${match.layer}]`);
        console.log(`  responsibility: ${match.responsibility}`);
        console.log(`  owner: ${match.owner}`);
        console.log(`  reviewers: ${match.reviewers.join(', ')}`);
        console.log(`  entry: ${match.entryPoints.join(', ')}`);
        console.log(`  targets: ${match.targets.join(', ')}`);
        console.log(`  profiles: ${match.profiles.join(', ') || 'none'}`);
        console.log(`  tests: ${match.tests.join(', ')}`);
        console.log(`  docs: ${match.documents.join(', ') || 'none'}`);
        console.log(`  runbooks: ${match.runbooks.join(', ') || 'none'}`);
        console.log(`  ADRs: ${match.adrs.join(', ') || 'none'}`);
        console.log(`  products: ${match.products.join(', ') || 'none'}`);
        console.log(`  impact: ${match.impactReasons.join(', ')}`);
      }
    }
    return;
  }
  const report = health(layers, build, affectedBaseline, healthBaseline);
  const baseline = healthBaseline;
  const observations = baseline
    ? healthFindings(report, layers, baseline)
    : ['architecture health baseline is missing'];
  const findings = baseline
    ? healthFindings(report, layers, baseline, { blockingOnly: true })
    : ['architecture health baseline is missing'];
  const projections = new Map([
    [indexPath, renderIndex(layers, build)],
    [healthPath, renderHealth(report, layers, baseline, observations)],
    [reviewRoutesPath, `${JSON.stringify(reviewRoutes(layers), null, 2)}\n`],
  ]);
  if (options.write) {
    for (const [file, content] of projections) fs.writeFileSync(file, content);
    console.log('[core-architecture] projections refreshed');
  } else {
    for (const [file, expected] of projections) {
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== expected)
        findings.push(`${path.relative(root, file)} projection drift`);
    }
  }
  if (options.health || options.json)
    console.log(JSON.stringify({ ...report, observations, findings }, null, 2));
  else
    console.log(
      `[core-architecture] components=${layers.components.length} authority=${report.authorityRoot} findings=${findings.length}`,
    );
  if (findings.length) throw new Error(findings.join('\n'));
}

try {
  main();
} catch (error) {
  console.error(`[core-architecture] ${error.message}`);
  process.exitCode = 1;
}
