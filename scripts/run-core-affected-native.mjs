// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { writeShifuGateEvidence } from './shifu-gate-evidence.mjs';

const root = process.cwd();
const coreRoot = path.join(root, 'framework', 'core');
const architecturePath = path.join(coreRoot, 'architecture', 'layers.json');
const buildPath = path.join(
  coreRoot,
  'architecture',
  'build-capabilities.json',
);
const baselinePath = path.join(
  coreRoot,
  'architecture',
  'affected-native-baseline.json',
);
const nonNativeCoreRules = [
  { prefix: '.gyp/run-freeze.js', kind: 'core-packaging-source' },
  { prefix: 'src/python/', kind: 'core-python-source' },
  { prefix: 'tests/fixtures/', kind: 'core-test-fixture' },
  { prefix: 'tests/python/', kind: 'core-python-test' },
  {
    prefix: 'tests/qualification/',
    kind: 'core-qualification-harness',
    extensions: ['.js', '.json', '.mjs', '.py'],
  },
];

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

function stableJson(value) {
  return JSON.stringify(ordered(value));
}

function digest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : stableJson(value))
    .digest('hex')}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function unique(items) {
  return [...new Set(items)].sort();
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

function nonNativeCoreRule(relative) {
  return (
    nonNativeCoreRules.find(
      (rule) =>
        relative.startsWith(rule.prefix) &&
        (!rule.extensions || rule.extensions.includes(path.extname(relative))),
    ) || null
  );
}

function targetEvidence(authority) {
  return new Set(
    authority.target_evidence.flatMap((record) => record.targets || []),
  );
}

function validateAuthority(authority, buildAuthority) {
  const problems = [];
  const components = new Map(
    authority.components.map((component) => [component.id, component]),
  );
  const evidence = targetEvidence(authority);
  const internalTargets = new Set(
    authority.internal_targets.map((target) => target.id),
  );
  for (const component of authority.components) {
    for (const dependency of component.dependencies || []) {
      if (!components.has(dependency)) {
        problems.push(`${component.id}: unknown dependency ${dependency}`);
      }
    }
    for (const target of component.current_targets || []) {
      if (!evidence.has(target)) {
        problems.push(
          `${component.id}: target lacks CMake evidence: ${target}`,
        );
      }
    }
    for (const test of component.contract_tests || []) {
      if (!evidence.has(test)) {
        problems.push(
          `${component.id}: contract test lacks CMake evidence: ${test}`,
        );
      }
    }
  }
  for (const target of authority.internal_targets) {
    if (!components.has(target.component)) {
      problems.push(`${target.id}: unknown component ${target.component}`);
    }
    if (!evidence.has(target.id)) {
      problems.push(`${target.id}: internal target lacks CMake evidence`);
    }
    for (const dependency of target.dependencies || []) {
      if (!internalTargets.has(dependency)) {
        problems.push(`${target.id}: unknown target dependency ${dependency}`);
      }
    }
  }
  const architectureComponents = new Set(
    authority.components.map(({ id }) => id),
  );
  const projected = new Set(
    buildAuthority.components.flatMap(
      (component) => component.architecture_components || [],
    ),
  );
  for (const component of architectureComponents) {
    if (
      component !== 'core-native-qualification' &&
      !projected.has(component)
    ) {
      problems.push(`${component}: absent from build capability projection`);
    }
  }
  if (problems.length) throw new Error(problems.join('\n'));
}

function componentOwner(authority, file) {
  const owners = authority.components.filter((component) =>
    owns(component, file),
  );
  if (owners.length !== 1) {
    throw new Error(
      `${file}: expected exactly one architecture component, found ${owners.map(({ id }) => id).join(', ') || 'none'}`,
    );
  }
  return owners[0];
}

function reverseClosure(authority, direct) {
  const result = new Set(direct);
  let changed = true;
  while (changed) {
    changed = false;
    for (const component of authority.components) {
      if (
        !result.has(component.id) &&
        (component.dependencies || []).some((dependency) =>
          result.has(dependency),
        )
      ) {
        result.add(component.id);
        changed = true;
      }
    }
  }
  return result;
}

function publicRule(authority, file) {
  const matches = (authority.public_contracts?.header_rules || []).filter(
    (rule) => owns(rule, file),
  );
  if (matches.length > 1) {
    throw new Error(`${file}: ambiguous public contract impact`);
  }
  return matches[0] || null;
}

function selectProfile(buildAuthority, components, forceFull) {
  if (forceFull) return 'full';
  const required = new Set(
    [...components].filter(
      (component) => component !== 'core-native-qualification',
    ),
  );
  const supported = buildAuthority.profiles.filter(
    (profile) => profile.status === 'supported',
  );
  const candidates = supported.filter((profile) => {
    const projected = new Set(
      buildAuthority.components
        .filter((component) => profile.components.includes(component.id))
        .flatMap((component) => component.architecture_components || []),
    );
    return [...required].every((component) => projected.has(component));
  });
  candidates.sort(
    (left, right) =>
      left.components.length +
        left.providers.length +
        left.bindings.length -
        (right.components.length +
          right.providers.length +
          right.bindings.length) || left.id.localeCompare(right.id),
  );
  if (!candidates.length) {
    throw new Error(
      `no supported Core profile covers ${[...required].join(', ')}`,
    );
  }
  return candidates[0].id;
}

export function planFromChanged(
  changedFiles,
  authority,
  buildAuthority,
  base,
  head,
) {
  validateAuthority(authority, buildAuthority);
  const direct = new Set();
  const broad = new Set();
  const reasons = [];
  const publicRules = new Set();
  let global = false;
  let forceFull = false;
  const globalPaths = [
    'framework/core/architecture/',
    'framework/core/CMakeLists.txt',
    'framework/core/conanfile.py',
    // pyproject.toml is a Core build definition alongside conanfile.py and
    // package.json: it pins the native toolchain (conan, cmake-js, ninja,
    // pybind11-stubgen). Editing any section could change how the addon builds,
    // and this gate cannot read TOML sections, so a change expands globally and
    // re-validates every component rather than failing closed as unclassified.
    'framework/core/pyproject.toml',
    'framework/core/package.json',
    'framework/core/tests/',
    'scripts/run-core-affected-native.mjs',
    '.github/workflows/affected-native-pr.yml',
    'shifu.gates.json',
    'docs/qualification/gates/',
    'package.json',
  ];

  for (const file of changedFiles) {
    if (
      globalPaths.some(
        (candidate) => file === candidate || file.startsWith(candidate),
      )
    ) {
      global = true;
      if (file.startsWith('framework/core/tests/')) forceFull = true;
      reasons.push({ path: file, kind: 'architecture-or-gate-authority' });
      continue;
    }
    if (!file.startsWith('framework/core/')) {
      reasons.push({ path: file, kind: 'outside-core' });
      continue;
    }
    const relative = file.slice('framework/core/'.length);
    if (/\.(md|txt)$/.test(relative)) {
      reasons.push({ path: file, kind: 'core-documentation-only' });
      continue;
    }
    const nonNativeRule = nonNativeCoreRule(relative);
    if (nonNativeRule) {
      reasons.push({ path: file, kind: nonNativeRule.kind });
      continue;
    }
    if (/\/CMakeLists\.txt$/.test(relative)) {
      global = true;
      reasons.push({ path: file, kind: 'composition-or-build-definition' });
      continue;
    }
    if (
      relative.startsWith('src/libkungfu/schemas/') &&
      relative.endsWith('.fbs')
    ) {
      const owner = 'libkungfu-contracts';
      direct.add(owner);
      for (const component of reverseClosure(authority, [owner]))
        broad.add(component);
      reasons.push({
        path: file,
        kind: 'schema-layout-propagation',
        component: owner,
      });
      continue;
    }
    const extension = path.extname(relative);
    if (relative.startsWith('stubs/') && extension === '.pyi') {
      global = true;
      forceFull = true;
      reasons.push({
        path: file,
        kind: 'generated-native-binding-contract',
      });
      continue;
    }
    if (
      relative.startsWith('src/python/') ||
      relative.startsWith('tests/python/')
    ) {
      reasons.push({ path: file, kind: 'python-surface' });
      continue;
    }
    if (!(authority.extensions || []).includes(extension)) {
      throw new Error(`${file}: unclassified Core file impact`);
    }
    const owner = componentOwner(authority, relative);
    direct.add(owner.id);
    const rule = publicRule(authority, relative);
    const header = ['.h', '.hh', '.hpp', '.hxx'].includes(extension);
    if (rule) publicRules.add(rule.id);
    if (header || rule) {
      for (const component of reverseClosure(authority, [owner.id]))
        broad.add(component);
      reasons.push({
        path: file,
        kind: rule ? 'public-contract-propagation' : 'header-propagation',
        component: owner.id,
        publicContract: rule?.id || null,
      });
    } else {
      reasons.push({ path: file, kind: 'implementation', component: owner.id });
    }
    if (
      relative.startsWith('src/bindings/') ||
      relative.startsWith('src/libwasm/')
    ) {
      forceFull = true;
    }
  }

  if (global) {
    for (const component of authority.components) broad.add(component.id);
  }
  const closure = new Set([...direct, ...broad]);
  const internalByComponent = new Map();
  for (const target of authority.internal_targets) {
    if (target.kind === 'INTERFACE') continue;
    const list = internalByComponent.get(target.component) || [];
    list.push(target.id);
    internalByComponent.set(target.component, list);
  }
  const targets = [];
  const tests = [];
  const componentById = new Map(
    authority.components.map((component) => [component.id, component]),
  );
  for (const componentId of closure) {
    const component = componentById.get(componentId);
    targets.push(...(internalByComponent.get(componentId) || []));
    if (['yijinjing-schema', 'yijinjing-kernel'].includes(componentId)) {
      targets.push('yijinjing');
    }
    tests.push(...(component?.contract_tests || []));
  }
  for (const ruleId of publicRules) {
    targets.push(
      `kungfu_public_headers_${ruleId.replace(/[^A-Za-z0-9]+/g, '_')}`,
    );
  }
  if (publicRules.size) {
    targets.push('kungfu_public_contract_compatibility_tests');
    tests.push('kungfu_public_contract_compatibility_tests');
  }
  if (global) {
    targets.push('kungfu', 'yijinjing');
  }
  targets.push(...tests);
  const profile = closure.size
    ? selectProfile(buildAuthority, closure, forceFull)
    : null;
  const plan = {
    schema: 'kungfu.core-affected-native-plan/v1',
    base,
    head,
    authority: {
      layers: digest(fs.readFileSync(architecturePath, 'utf8')),
      buildCapabilities: digest(fs.readFileSync(buildPath, 'utf8')),
    },
    changedPaths: unique(changedFiles),
    directComponents: unique(direct),
    closureComponents: unique(closure),
    targets: unique(targets),
    tests: unique(tests),
    profile,
    platformTier: closure.size ? 'github-hosted-linux-native-pr' : 'none',
    reviewRoutes: unique(closure).map((componentId) => ({
      component: componentId,
      ownerRole: componentById.get(componentId)?.owner,
      backupRole: authority.review_policy.architecture_reviewer_role,
      fallbackAccount: authority.review_policy.fallback_account,
    })),
    reasons: reasons.sort((left, right) => left.path.localeCompare(right.path)),
  };
  return { ...plan, planDigest: digest(plan) };
}

export function planAffectedPaths(changedFiles, base, head) {
  return planFromChanged(
    changedFiles,
    readJson(architecturePath),
    readJson(buildPath),
    base,
    head,
  );
}

function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function parseArgs(argv) {
  const options = {
    base: process.env.GITHUB_BASE_SHA || 'origin/dev/v4/v4.0',
    head: process.env.GITHUB_HEAD_SHA || 'HEAD',
    changedFiles: [],
    json: false,
    execute: false,
    selfTest: false,
    receipt: '',
    verifyReceipt: '',
    planOut: '',
    planInput: process.env.KUNGFU_AFFECTED_NATIVE_PLAN || '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--base') options.base = argv[++index];
    else if (arg === '--head') options.head = argv[++index];
    else if (arg === '--changed-file') options.changedFiles.push(argv[++index]);
    else if (arg === '--receipt') options.receipt = argv[++index];
    else if (arg === '--verify-receipt') options.verifyReceipt = argv[++index];
    else if (arg === '--plan-out') options.planOut = argv[++index];
    else if (arg === '--plan-input') options.planInput = argv[++index];
    else if (arg === '--json') options.json = true;
    else if (arg === '--execute') options.execute = true;
    else if (arg === '--self-test') options.selfTest = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function verifyPlan(plan) {
  if (plan.schema !== 'kungfu.core-affected-native-plan/v1') {
    throw new Error('unsupported affected-native plan schema');
  }
  const { planDigest, ...planWithoutDigest } = plan;
  if (planDigest !== digest(planWithoutDigest)) {
    throw new Error('affected-native plan digest drift');
  }
  const currentHead = git('rev-parse', 'HEAD');
  if (plan.head !== currentHead) {
    throw new Error(
      `affected-native plan source drift: expected ${plan.head}, got ${currentHead}`,
    );
  }
  const currentAuthority = {
    layers: digest(fs.readFileSync(architecturePath, 'utf8')),
    buildCapabilities: digest(fs.readFileSync(buildPath, 'utf8')),
  };
  if (stableJson(plan.authority) !== stableJson(currentAuthority)) {
    throw new Error('affected-native plan authority drift');
  }
  return plan;
}

function writePlan(plan, output) {
  const absolute = path.resolve(root, output);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(plan, null, 2)}\n`);
  return absolute;
}

function runStep(id, command, args, cwd, env, logRoot) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  fs.mkdirSync(logRoot, { recursive: true });
  const log = path.join(logRoot, `${id}.log`);
  fs.writeFileSync(log, output);
  process.stdout.write(output);
  const step = {
    id,
    command: [command, ...args],
    durationMs: Date.now() - started,
    exitCode: result.status ?? 1,
    log: path.relative(root, log).split(path.sep).join('/'),
  };
  if (step.exitCode !== 0) {
    throw Object.assign(new Error(`${id} failed with exit ${step.exitCode}`), {
      step,
    });
  }
  return step;
}

function toolFact(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return (
    (result.stdout || result.stderr || '').split('\n')[0].trim() ||
    'unavailable'
  );
}

function execute(plan, receiptPath) {
  const baseline = readJson(baselinePath);
  const receiptFile =
    receiptPath ||
    path.join(
      'product',
      'qualification',
      'affected-native',
      plan.head.slice(0, 12),
      'receipt.json',
    );
  const absoluteReceipt = path.resolve(root, receiptFile);
  const logRoot = path.join(path.dirname(absoluteReceipt), 'logs');
  const steps = [];
  const env = {
    ...process.env,
    KUNGFU_BUILDCHAIN_SOURCE_BUILD: '1',
    KUNGFU_BUILD_PROFILE: plan.profile || 'journal',
    KUNGFU_BUILD_SKIP_KUNGFU_NODE: 'on',
    KUNGFU_BUILD_SKIP_PYKUNGFU: 'on',
  };
  const started = Date.now();
  let status = 'passed';
  let failure = null;
  try {
    if (plan.targets.length) {
      steps.push(
        runStep(
          'conan-install',
          path.join(root, 'shifu'),
          ['core:affected:configure'],
          root,
          env,
          logRoot,
        ),
      );
      const buildRoot = path.join(coreRoot, 'build', 'affected-native');
      steps.push(
        runStep(
          'cmake-configure',
          'cmake',
          [
            '-S',
            coreRoot,
            '-B',
            buildRoot,
            '-G',
            'Ninja',
            `-DCMAKE_TOOLCHAIN_FILE=${path.join(coreRoot, 'build', 'conan_toolchain.cmake')}`,
            '-DCMAKE_BUILD_TYPE=Release',
            '-DCMAKE_CXX_SCAN_FOR_MODULES=OFF',
            `-DKUNGFU_BUILD_PROFILE=${plan.profile}`,
          ],
          root,
          env,
          logRoot,
        ),
      );
      steps.push(
        runStep(
          'cmake-build',
          'cmake',
          [
            '--build',
            buildRoot,
            '--target',
            ...plan.targets,
            '--parallel',
            String(
              Math.min(os.availableParallelism(), baseline.maxParallelism),
            ),
          ],
          root,
          env,
          logRoot,
        ),
      );
      if (plan.tests.length) {
        const expression = `^(${plan.tests.map((test) => test.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
        steps.push(
          runStep(
            'ctest',
            'ctest',
            ['--test-dir', buildRoot, '-R', expression, '--output-on-failure'],
            root,
            env,
            logRoot,
          ),
        );
      }
    }
  } catch (error) {
    status = 'failed';
    if (error.step) steps.push(error.step);
    failure = error.message;
  }
  const receipt = {
    schema: 'kungfu.core-affected-native-receipt/v1',
    status,
    source: { base: plan.base, head: plan.head },
    plan,
    planDigest: plan.planDigest,
    platform: `${process.platform}-${process.arch}`,
    toolchain: {
      compiler: toolFact(process.env.CXX || 'c++'),
      cmake: toolFact('cmake'),
      ninja: toolFact('ninja'),
    },
    cache: {
      identity: digest({
        head: plan.head,
        profile: plan.profile,
        toolchain: toolFact(process.env.CXX || 'c++'),
        authority: plan.authority,
      }),
      profileDigest: process.env.SHIFU_CACHE_PROFILE_DIGEST || null,
      hit: null,
      reason:
        'The current build tools do not expose trustworthy per-target cache hit facts.',
    },
    durationMs: Date.now() - started,
    budgetMs: baseline.requiredBudgetSeconds * 1000,
    steps,
    failure,
  };
  fs.mkdirSync(path.dirname(absoluteReceipt), { recursive: true });
  fs.writeFileSync(absoluteReceipt, `${JSON.stringify(receipt, null, 2)}\n`);
  writeShifuGateEvidence({
    schema: 'kungfu.core-affected-native-receipt/v1',
    pointers: [{ id: 'core-affected-native-receipt', file: absoluteReceipt }],
    root,
  });
  console.log(
    `[core-affected] receipt=${path.relative(root, absoluteReceipt)}`,
  );
  if (status !== 'passed') process.exitCode = 1;
  return receipt;
}

function verifyReceipt(receipt) {
  if (receipt.schema !== 'kungfu.core-affected-native-receipt/v1') {
    throw new Error('unsupported affected-native receipt schema');
  }
  const { planDigest, ...planWithoutDigest } = receipt.plan;
  if (
    planDigest !== digest(planWithoutDigest) ||
    receipt.planDigest !== planDigest
  ) {
    throw new Error('affected-native receipt plan digest drift');
  }
  if (!['passed', 'failed'].includes(receipt.status)) {
    throw new Error('affected-native receipt status is invalid');
  }
  return true;
}

function selfTest(authority, buildAuthority) {
  let passed = 0;
  const expect = (name, action, pattern = null) => {
    try {
      action();
      if (pattern) throw new Error(`${name}: expected failure`);
      console.log(`  ok: ${name}`);
      passed += 1;
    } catch (error) {
      if (!pattern || !pattern.test(error.message)) throw error;
      console.log(`  ok: ${name}`);
      passed += 1;
    }
  };
  const implementation = [
    'framework/core/src/libkungfu/src/runtime/storage/query_render.cpp',
  ];
  const first = planFromChanged(
    implementation,
    authority,
    buildAuthority,
    'base',
    'head',
  );
  const second = planFromChanged(
    implementation,
    authority,
    buildAuthority,
    'base',
    'head',
  );
  expect('deterministic implementation plan', () => {
    if (stableJson(first) !== stableJson(second)) throw new Error('plan drift');
    if (!first.directComponents.includes('runtime-storage-services'))
      throw new Error('owner missing');
  });
  expect('native contract JSON fixture selects qualification tests', () => {
    const plan = planFromChanged(
      [
        'framework/core/src/libkungfu/tests/fixtures/native_kfx_contract/buildchain-envelope.json',
      ],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (!plan.directComponents.includes('core-native-qualification'))
      throw new Error('qualification owner missing');
    if (!plan.tests.includes('kungfu_native_kfx_contract_tests'))
      throw new Error('native KFX contract test missing');
  });
  expect('cross-language Core qualification expands globally', () => {
    const plan = planFromChanged(
      ['framework/core/tests/python/test_native_kfx_contract.py'],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (plan.closureComponents.length !== authority.components.length)
      throw new Error('cross-language qualification closure incomplete');
    if (plan.profile !== buildAuthority.default_profile)
      throw new Error(
        'cross-language qualification did not select full profile',
      );
  });
  expect(
    'outside-Core change emits a required-check-safe tier-none plan',
    () => {
      const plan = planFromChanged(
        ['docs/MAP.md'],
        authority,
        buildAuthority,
        'base',
        'head',
      );
      if (
        plan.platformTier !== 'none' ||
        plan.profile !== null ||
        plan.targets.length ||
        plan.tests.length
      ) {
        throw new Error('outside-Core plan scheduled native work');
      }
    },
  );
  expect('Python source changes do not invent native work', () => {
    const plan = planFromChanged(
      [
        'framework/core/src/python/kungfu/workspace.py',
        'framework/core/src/python/kungfu/agent/commands.json',
      ],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (
      plan.platformTier !== 'none' ||
      plan.profile !== null ||
      plan.targets.length ||
      plan.tests.length
    ) {
      throw new Error('Python surface scheduled native work');
    }
    const kinds = new Set(plan.reasons.map(({ kind }) => kind));
    if (kinds.size !== 1 || !kinds.has('core-python-source')) {
      throw new Error('Python source classification drifted');
    }
  });
  expect('runtime packaging changes do not invent native work', () => {
    const plan = planFromChanged(
      ['framework/core/.gyp/run-freeze.js'],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (
      plan.platformTier !== 'none' ||
      plan.profile !== null ||
      plan.targets.length ||
      plan.tests.length
    ) {
      throw new Error('runtime packaging scheduled native work');
    }
    if (!plan.reasons.some(({ kind }) => kind === 'core-packaging-source')) {
      throw new Error('runtime packaging classification missing');
    }
  });
  expect('generated native binding stubs force full native coverage', () => {
    const plan = planFromChanged(
      ['framework/core/stubs/pykungfu/runtime.pyi'],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (plan.profile !== 'full') throw new Error('full profile not selected');
    if (plan.closureComponents.length !== authority.components.length)
      throw new Error('native binding contract closure incomplete');
    if (
      !plan.reasons.some(
        ({ kind }) => kind === 'generated-native-binding-contract',
      )
    ) {
      throw new Error('native binding contract classification missing');
    }
  });
  expect(
    'unclassified source fails closed',
    () =>
      planFromChanged(
        ['framework/core/src/libkungfu/src/runtime/unknown.cpp'],
        authority,
        buildAuthority,
        'base',
        'head',
      ),
    /exactly one architecture component/,
  );
  expect('Core test fixtures and qualification harness expand globally', () => {
    const plan = planFromChanged(
      [
        'framework/core/tests/fixtures/peer_lifecycle_probe.py',
        'framework/core/tests/qualification/live-peer-continuity/run.mjs',
      ],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (
      plan.platformTier !== 'github-hosted-linux-native-pr' ||
      plan.profile !== buildAuthority.default_profile ||
      plan.closureComponents.length !== authority.components.length
    ) {
      throw new Error('Core test surface did not expand globally');
    }
  });
  expect('unknown qualification source expands globally', () => {
    const plan = planFromChanged(
      ['framework/core/tests/qualification/example/driver.cpp'],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (
      plan.profile !== buildAuthority.default_profile ||
      plan.closureComponents.length !== authority.components.length
    ) {
      throw new Error('unknown qualification source did not expand globally');
    }
  });
  expect('authority dependency change expands globally', () => {
    const plan = planFromChanged(
      ['framework/core/architecture/layers.json'],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (plan.closureComponents.length !== authority.components.length)
      throw new Error('closure incomplete');
  });
  expect('core build definition change expands globally', () => {
    const plan = planFromChanged(
      ['framework/core/pyproject.toml'],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (plan.closureComponents.length !== authority.components.length)
      throw new Error('pyproject.toml did not expand to the full closure');
    if (
      !plan.reasons.some(
        ({ kind }) => kind === 'architecture-or-gate-authority',
      )
    )
      throw new Error('pyproject.toml not classified as a build authority');
  });
  expect('public header propagates to consumers', () => {
    const plan = planFromChanged(
      ['framework/core/src/libkungfu/include/kungfu/embedding.h'],
      authority,
      buildAuthority,
      'base',
      'head',
    );
    if (plan.closureComponents.length <= plan.directComponents.length)
      throw new Error('no propagation');
    if (!plan.tests.includes('kungfu_public_contract_compatibility_tests'))
      throw new Error('compat test missing');
    if (plan.targets.includes('kungfu_contracts'))
      throw new Error('INTERFACE target scheduled as a build goal');
  });
  expect(
    'target deletion fails closed',
    () => {
      const changed = structuredClone(authority);
      changed.target_evidence = changed.target_evidence.map((record) => ({
        ...record,
        targets: record.targets.filter(
          (target) => target !== 'kungfu_storage_services',
        ),
      }));
      validateAuthority(changed, buildAuthority);
    },
    /lacks CMake evidence/,
  );
  expect(
    'test mapping loss fails closed',
    () => {
      const changed = structuredClone(authority);
      changed.components[0].contract_tests.push('missing_native_contract_test');
      validateAuthority(changed, buildAuthority);
    },
    /contract test lacks CMake evidence/,
  );
  expect(
    'receipt drift fails closed',
    () => {
      const receipt = {
        schema: 'kungfu.core-affected-native-receipt/v1',
        status: 'passed',
        plan: { ...first, planDigest: `sha256:${'0'.repeat(64)}` },
        planDigest: first.planDigest,
      };
      verifyReceipt(receipt);
    },
    /plan digest drift/,
  );
  const sourceBoundPlan = planFromChanged(
    ['docs/README.md'],
    authority,
    buildAuthority,
    git('rev-parse', 'HEAD'),
    git('rev-parse', 'HEAD'),
  );
  expect('source-bound plan verifies before execution', () => {
    verifyPlan(sourceBoundPlan);
  });
  expect(
    'source-bound plan digest drift fails closed',
    () => verifyPlan({ ...sourceBoundPlan, profile: 'full' }),
    /plan digest drift/,
  );
  console.log(`[core-affected] ${passed} negative/determinism fixtures passed`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const authority = readJson(architecturePath);
  const buildAuthority = readJson(buildPath);
  if (options.selfTest) return selfTest(authority, buildAuthority);
  if (options.verifyReceipt) {
    verifyReceipt(readJson(path.resolve(root, options.verifyReceipt)));
    console.log('[core-affected] receipt verified');
    return;
  }
  const plan = options.planInput
    ? verifyPlan(readJson(path.resolve(root, options.planInput)))
    : (() => {
        const base = git('rev-parse', options.base);
        const head = git('rev-parse', options.head);
        const changedFiles = options.changedFiles.length
          ? options.changedFiles
          : git(
              'diff',
              '--name-only',
              '--diff-filter=ACMRTUXB',
              `${base}...${head}`,
            )
              .split('\n')
              .filter(Boolean);
        return planFromChanged(
          changedFiles,
          authority,
          buildAuthority,
          base,
          head,
        );
      })();
  if (options.planOut) writePlan(plan, options.planOut);
  if (options.json) console.log(JSON.stringify(plan, null, 2));
  else {
    console.log(
      `[core-affected] ${plan.base.slice(0, 12)}..${plan.head.slice(0, 12)}`,
    );
    console.log(
      `[core-affected] profile=${plan.profile || 'none'} tier=${plan.platformTier}`,
    );
    console.log(
      `[core-affected] components=${plan.closureComponents.join(', ') || 'none'}`,
    );
    console.log(`[core-affected] targets=${plan.targets.join(', ') || 'none'}`);
    console.log(`[core-affected] tests=${plan.tests.join(', ') || 'none'}`);
  }
  if (options.execute) execute(plan, options.receipt);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(`[core-affected] ${error.message}`);
    process.exitCode = 1;
  }
}
