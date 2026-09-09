// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  canonicalJson,
  fileRoot,
  loadFixture,
  rooted,
  semanticRoot,
} from '../contract.mjs';
import {
  authoritativeBuildCoreRoute,
  compileCoreProductionSubgraph,
  createCoreProductionSubgraphRequest,
  observeCoreProductionBindings,
} from '../core-subgraph/index.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const CONTRACT_PATH = 'docs/shifu/native-build-lowering-contract.json';
const FIXTURE_PATH =
  'docs/shifu/examples/production-graph/native-build-lowering/journal-bazel.fixture.json';
const TOOLCHAIN_CONTRACT_PATH = 'toolchain.contract.json';
const CAPABILITIES_PATH = 'framework/core/architecture/build-capabilities.json';
const LAYERS_PATH = 'framework/core/architecture/layers.json';
const BUILD_PROFILES_PATH = 'framework/core/architecture/BUILD_PROFILES.cmake';
const TARGETS_PATH = 'framework/core/architecture/TARGETS.cmake';
const CORE_CMAKE_PATH = 'framework/core/CMakeLists.txt';
const TARGET_CMAKE_PATH = 'framework/core/src/libyijinjing/CMakeLists.txt';
const TARGET_PACKAGE = 'framework/core/src/libyijinjing';
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REQUIRED_CMAKE_TOKENS = Object.freeze([
  'file(GLOB_RECURSE YIJINJING_SOURCE_FILES ${PROJECT_SOURCE_DIR}/src/*.cpp)',
  'add_library(yijinjing STATIC ${YIJINJING_SOURCE_FILES})',
  'target_compile_features(yijinjing PUBLIC cxx_std_20)',
  'target_compile_definitions(yijinjing PRIVATE HAVE_USLEEP=1 SPDLOG_NO_NAME SPDLOG_NO_ATOMIC_LEVELS)',
  'set_target_properties(yijinjing PROPERTIES POSITION_INDEPENDENT_CODE ON)',
]);
const FORBIDDEN_BAZEL_NAMES = Object.freeze([
  'BUILD',
  'BUILD.bazel',
  'MODULE.bazel',
  'WORKSPACE',
  'WORKSPACE.bazel',
]);

export class NativeBuildLoweringError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'NativeBuildLoweringError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new NativeBuildLoweringError(code, message);
}

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
  }).trim();
}

function trackedFiles(root, ...pathspecs) {
  const output = execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
    cwd: root,
    encoding: 'utf8',
  });
  return output.split('\0').filter(Boolean).sort();
}

function visibleRepositoryFiles(root) {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8' },
  );
  return output.split('\0').filter(Boolean).sort();
}

function ownsPath(component, coreRelative) {
  const included =
    (component.include_files || []).includes(coreRelative) ||
    (component.include_prefixes || []).some((prefix) =>
      coreRelative.startsWith(prefix),
    );
  const excluded =
    (component.exclude_files || []).includes(coreRelative) ||
    (component.exclude_prefixes || []).some((prefix) =>
      coreRelative.startsWith(prefix),
    );
  return included && !excluded;
}

function rootedFiles(root, paths) {
  return paths.map((relative) => ({
    path: relative,
    root: fileRoot(path.join(root, relative)),
  }));
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value || {}).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    fail('unknown-or-missing-field', `${label} fields drifted`);
  }
}

function verifyRooted(value, field) {
  if (!ROOT_PATTERN.test(value?.[field] || '')) {
    fail('invalid-root', `${field} is not a sha256 root`);
  }
  const body = structuredClone(value);
  const retained = body[field];
  delete body[field];
  if (semanticRoot(body) !== retained) {
    fail('root-mismatch', `${field} does not bind its document`);
  }
}

function selectedJournalAuthority(root) {
  const toolchain = loadFixture(root, TOOLCHAIN_CONTRACT_PATH);
  const capabilities = loadFixture(root, CAPABILITIES_PATH);
  const layers = loadFixture(root, LAYERS_PATH);
  const profile = capabilities.profiles.find(({ id }) => id === 'journal');
  const component = capabilities.components.find(
    ({ id }) => id === 'journal-core',
  );
  if (!profile || profile.status !== 'supported' || !component) {
    fail('profile-authority-mismatch', 'journal authority is unavailable');
  }
  if (
    canonicalJson(profile.components) !== canonicalJson(['journal-core']) ||
    canonicalJson(profile.bindings) !== canonicalJson(['cxx'])
  ) {
    fail('profile-authority-mismatch', 'journal closure drifted');
  }
  const architectureComponents = component.architecture_components
    .map((id) => layers.components.find((entry) => entry.id === id))
    .filter(Boolean);
  if (
    architectureComponents.length !== component.architecture_components.length
  ) {
    fail(
      'component-authority-mismatch',
      'journal architecture component is missing',
    );
  }
  const dependencies = component.dependencies
    .map((id) => capabilities.dependencies.find((entry) => entry.id === id))
    .filter(Boolean)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (dependencies.length !== component.dependencies.length) {
    fail('dependency-authority-mismatch', 'journal dependency is missing');
  }
  const projectCppStandard = toolchain.policy?.project_cpp_standard;
  const publicYijinjingCppStandard =
    toolchain.policy?.public_yijinjing_cpp_standard;
  if (
    !Number.isInteger(projectCppStandard) ||
    !Number.isInteger(publicYijinjingCppStandard)
  ) {
    fail('toolchain-authority-mismatch', 'C++ standard policy is unavailable');
  }
  return {
    toolchain,
    projectCppStandard,
    publicYijinjingCppStandard,
    capabilities,
    layers,
    profile,
    component,
    architectureComponents,
    dependencies,
  };
}

function observeTargetClosure(root, authority) {
  const tracked = trackedFiles(
    root,
    `${TARGET_PACKAGE}/include`,
    `${TARGET_PACKAGE}/src`,
  );
  const owned = tracked.filter((relative) => {
    const coreRelative = relative.replace(/^framework\/core\//u, '');
    return authority.architectureComponents.some((component) =>
      ownsPath(component, coreRelative),
    );
  });
  const sources = rootedFiles(
    root,
    owned.filter((relative) => relative.endsWith('.cpp')),
  );
  const headers = rootedFiles(
    root,
    owned.filter((relative) => /\.(?:h|hh|hpp|hxx)$/u.test(relative)),
  );
  if (sources.length === 0 || headers.length === 0) {
    fail('source-set-empty', 'journal target closure is empty');
  }
  const unownedSources = tracked
    .filter((relative) => relative.endsWith('.cpp'))
    .filter(
      (relative) => !sources.some(({ path: source }) => source === relative),
    );
  if (unownedSources.length > 0) {
    fail(
      'source-ownership-gap',
      `tracked source is outside canonical ownership: ${unownedSources.join(', ')}`,
    );
  }
  const cmake = fs.readFileSync(path.join(root, TARGET_CMAKE_PATH), 'utf8');
  for (const token of REQUIRED_CMAKE_TOKENS) {
    if (!cmake.includes(token)) {
      fail('executor-contract-drift', `missing CMake token: ${token}`);
    }
  }
  return {
    sources,
    headers,
    sourceSetRoot: semanticRoot(sources),
    headerSetRoot: semanticRoot(headers),
    targetContractRoot: fileRoot(path.join(root, TARGET_CMAKE_PATH)),
  };
}

function nativeAuthorityFiles(root, contract) {
  return contract.authorityInventory
    .flatMap(({ paths }) => paths)
    .sort()
    .map((relative) => ({
      path: relative,
      root: fileRoot(path.join(root, relative)),
    }));
}

function verifyDerivedReadback(root, authority) {
  const profiles = fs.readFileSync(
    path.join(root, BUILD_PROFILES_PATH),
    'utf8',
  );
  const dependencies = authority.dependencies.map(({ id }) => id).join(';');
  const expected = [
    'if(KUNGFU_BUILD_PROFILE STREQUAL "journal")',
    'set(KUNGFU_BUILD_COMPONENTS "journal-core")',
    'set(KUNGFU_BUILD_BINDINGS "cxx")',
    `set(KUNGFU_BUILD_DEPENDENCY_ROOTS "${dependencies}")`,
  ];
  for (const token of expected) {
    if (!profiles.includes(token)) {
      fail('derived-profile-drift', `BUILD_PROFILES.cmake omitted ${token}`);
    }
  }
  const targets = fs.readFileSync(path.join(root, TARGETS_PATH), 'utf8');
  if (!targets.startsWith('# Generated from architecture/layers.json')) {
    fail('derived-target-drift', 'TARGETS.cmake lost its derived marker');
  }
  const coreCmake = fs.readFileSync(path.join(root, CORE_CMAKE_PATH), 'utf8');
  if (
    !coreCmake.includes(
      'include(${PROJECT_SOURCE_DIR}/architecture/BUILD_PROFILES.cmake)',
    ) ||
    !coreCmake.includes('add_subdirectory(src/libyijinjing)')
  ) {
    fail(
      'executor-contract-drift',
      'Core CMake route no longer consumes the derived profile',
    );
  }
  const compilerCmake = fs.readFileSync(
    path.join(root, 'framework/core/.cmake/compiler.cmake'),
    'utf8',
  );
  const toolchainCmake = fs.readFileSync(
    path.join(root, 'framework/core/.cmake/toolchain-contract.cmake'),
    'utf8',
  );
  if (
    !compilerCmake.includes(
      `set(CMAKE_CXX_STANDARD ${authority.projectCppStandard})`,
    ) ||
    !compilerCmake.includes(
      `target_compile_features(kungfu_compile_contract INTERFACE cxx_std_${authority.projectCppStandard})`,
    ) ||
    !toolchainCmake.includes(
      'kungfu_contract_get(KUNGFU_PROJECT_CXX_STANDARD policy project_cpp_standard)',
    ) ||
    !toolchainCmake.includes(
      'kungfu_contract_get(KUNGFU_PUBLIC_YIJINJING_CXX_STANDARD policy public_yijinjing_cpp_standard)',
    )
  ) {
    fail(
      'toolchain-authority-mismatch',
      'Core CMake route no longer consumes the canonical C++ standard policy',
    );
  }
}

export async function compileNativeBuildIr(fixture, { root = ROOT } = {}) {
  exactKeys(
    fixture,
    [
      'backend',
      'expectedPrerequisites',
      'expectedVerdict',
      'node',
      'profile',
      'schema',
      'xinfaSelectionRoot',
      'xinfaVerificationRoot',
    ],
    'fixture',
  );
  if (
    fixture.schema !== 'shifu.native-build-lowering-fixture/v0' ||
    fixture.profile !== 'journal' ||
    fixture.node !== 'native-build' ||
    fixture.backend !== 'bazel'
  ) {
    fail('unsupported-fixture', 'fixture is outside the bounded exploration');
  }
  const contract = loadFixture(root, CONTRACT_PATH);
  const observed = observeCoreProductionBindings(root);
  const request = createCoreProductionSubgraphRequest(
    {
      xinfaSelectionRoot: fixture.xinfaSelectionRoot,
      xinfaVerificationRoot: fixture.xinfaVerificationRoot,
    },
    { root, observed },
  );
  const compiled = await compileCoreProductionSubgraph(request, {
    root,
    observed,
  });
  const nativeNode = compiled.subgraph.nodes.find(
    ({ id }) => id === 'native-build',
  );
  if (!nativeNode) fail('node-missing', 'native-build node is absent');
  const authority = selectedJournalAuthority(root);
  const target = observeTargetClosure(root, authority);
  verifyDerivedReadback(root, authority);
  const authorityFiles = nativeAuthorityFiles(root, contract);
  return rooted(
    {
      schema: 'shifu.native-build-ir/v0',
      source: compiled.subgraph.source,
      productionSubgraph: {
        contractRoot: compiled.subgraph.contractRoot,
        subgraphRoot: compiled.subgraph.subgraphRoot,
        planRoot: compiled.plan.planRoot,
        nodeRoot: semanticRoot(nativeNode),
      },
      authorityBindings: {
        buildProfile: compiled.subgraph.bindings.buildProfile,
        buildCapabilitiesRoot: compiled.subgraph.bindings.buildCapabilitiesRoot,
        layersRoot: compiled.subgraph.bindings.layersRoot,
        projectAuthorityRoot: compiled.subgraph.bindings.projectAuthorityRoot,
        existingToolchainRoot: compiled.subgraph.bindings.toolchainRoot,
        nativeBuildAuthorityRoot: semanticRoot(authorityFiles),
      },
      target: {
        id: 'yijinjing',
        kind: 'static-library',
        language: 'cxx',
        package: TARGET_PACKAGE,
        components: authority.component.architecture_components.slice().sort(),
        sources: target.sources,
        headers: target.headers,
        sourceSetRoot: target.sourceSetRoot,
        headerSetRoot: target.headerSetRoot,
        dependencies: authority.dependencies.map((dependency) => ({
          id: dependency.id,
          kind: dependency.kind,
          reference: dependency.reference,
          cmakeTarget: dependency.cmake_target,
        })),
        compileRequirements: {
          languageStandard: `c++${authority.projectCppStandard}`,
          targetMinimumFeature: `cxx_std_${authority.publicYijinjingCppStandard}`,
          positionIndependentCode: true,
          definitions: [
            'HAVE_USLEEP=1',
            'SPDLOG_NO_NAME',
            'SPDLOG_NO_ATOMIC_LEVELS',
          ],
          targetContractRoot: target.targetContractRoot,
        },
      },
      output: {
        id: nativeNode.outputs[0].id,
        declarationRoot: nativeNode.outputs[0].root,
        observedArtifactContentClaimed: false,
      },
      authorityBoundary: {
        backendNeutral: true,
        projectionOnly: true,
        executable: false,
        executionAuthority: false,
        currentBuildCoreRoute: authoritativeBuildCoreRoute(root),
      },
    },
    'irRoot',
  );
}

export function lowerNativeBuildIr(ir, { root = ROOT } = {}) {
  verifyRooted(ir, 'irRoot');
  const contract = loadFixture(root, CONTRACT_PATH);
  const observed = observeCoreProductionBindings(root);
  const nativeBuildAuthorityRoot = semanticRoot(
    nativeAuthorityFiles(root, contract),
  );
  if (
    ir.source.revision !== observed.source.revision ||
    ir.source.tree !== observed.source.tree ||
    ir.authorityBindings.buildCapabilitiesRoot !==
      observed.buildCapabilitiesRoot ||
    ir.authorityBindings.layersRoot !== observed.layersRoot ||
    ir.authorityBindings.projectAuthorityRoot !==
      observed.projectAuthorityRoot ||
    ir.authorityBindings.existingToolchainRoot !== observed.toolchainRoot ||
    ir.authorityBindings.nativeBuildAuthorityRoot !== nativeBuildAuthorityRoot
  ) {
    fail('authority-drift', 'IR no longer matches the observed authority cut');
  }
  const prerequisites = contract.prerequisites
    .map((item) => ({ ...item }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return rooted(
    {
      schema: 'shifu.native-build-bazel-projection/v0',
      provider: {
        id: contract.provider.id,
        mode: 'data-only-fixture',
        executable: false,
      },
      irRoot: ir.irRoot,
      target: {
        package: ir.target.package,
        name: ir.target.id,
        ruleClass: 'cc_library',
        srcs: ir.target.sources.map(({ path: relative }) =>
          path.posix.relative(ir.target.package, relative),
        ),
        hdrs: ir.target.headers.map(({ path: relative }) =>
          path.posix.relative(ir.target.package, relative),
        ),
        dependencyIdentities: ir.target.dependencies,
        dependencyLabels: null,
        platformConstraints: null,
        toolchainConstraints: null,
        artifactStageProvider: null,
      },
      prerequisites,
      authorityBoundary: {
        generatedProjection: true,
        authoritativeBuildGraph: false,
        executable: false,
        buildFilesWritten: false,
        backendInvoked: false,
        nodesExecuted: false,
        buildCoreRouteChanged: false,
      },
    },
    'projectionRoot',
  );
}

function forbiddenBazelFiles(root) {
  return visibleRepositoryFiles(root).filter((relative) => {
    const base = path.posix.basename(relative);
    return FORBIDDEN_BAZEL_NAMES.includes(base) || relative.endsWith('.bzl');
  });
}

export async function checkNativeBuildLoweringContract({ root = ROOT } = {}) {
  const contract = loadFixture(root, CONTRACT_PATH);
  const fixture = loadFixture(root, FIXTURE_PATH);
  const firstIr = await compileNativeBuildIr(fixture, { root });
  const secondIr = await compileNativeBuildIr(structuredClone(fixture), {
    root,
  });
  if (canonicalJson(firstIr) !== canonicalJson(secondIr)) {
    fail(
      'nondeterministic-ir',
      'identical authority cuts produced different IR',
    );
  }
  const firstProjection = lowerNativeBuildIr(firstIr, { root });
  const secondProjection = lowerNativeBuildIr(secondIr, { root });
  if (canonicalJson(firstProjection) !== canonicalJson(secondProjection)) {
    fail(
      'nondeterministic-projection',
      'identical IR produced different projection',
    );
  }
  const prerequisiteIds = firstProjection.prerequisites.map(({ id }) => id);
  if (
    contract.verdict !== fixture.expectedVerdict ||
    canonicalJson(prerequisiteIds) !==
      canonicalJson(fixture.expectedPrerequisites)
  ) {
    fail('verdict-drift', 'fixture verdict or prerequisite set drifted');
  }
  const bazelFiles = forbiddenBazelFiles(root);
  if (bazelFiles.length > 0) {
    fail(
      'second-authority-detected',
      `Bazel authority files exist: ${bazelFiles.join(', ')}`,
    );
  }
  const route = authoritativeBuildCoreRoute(root);
  return rooted(
    {
      schema: 'shifu.native-build-lowering-receipt/v0',
      status: 'qualified-exploration',
      verdict: contract.verdict,
      sourceRevision: git(root, 'rev-parse', 'HEAD'),
      sourceTree: git(root, 'rev-parse', 'HEAD^{tree}'),
      contractRoot: semanticRoot(contract),
      fixtureRoot: fileRoot(path.join(root, FIXTURE_PATH)),
      authorityInventoryRoot: semanticRoot(contract.authorityInventory),
      irRoot: firstIr.irRoot,
      projectionRoot: firstProjection.projectionRoot,
      reverseReadback: {
        profileMatches: true,
        dependencySetMatches: true,
        sourceOwnershipMatches: true,
        derivedProfilesMatch: true,
        currentBuildCoreRouteRoot: route.routeRoot,
      },
      prerequisites: prerequisiteIds,
      determinism: {
        irStable: true,
        projectionStable: true,
      },
      forbiddenEffects: {
        bazelInstallationPerformed: false,
        bazelDownloadPerformed: false,
        bazelInvoked: false,
        nativeBuildExecuted: false,
        buildFilesWritten: false,
        nodesExecuted: false,
        buildCoreRouteChanged: false,
      },
    },
    'receiptRoot',
  );
}

export { CONTRACT_PATH, FIXTURE_PATH };

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  checkNativeBuildLoweringContract()
    .then((receipt) => console.log(JSON.stringify(receipt, null, 2)))
    .catch((error) => {
      console.error(error?.stack || String(error));
      process.exitCode = 1;
    });
}
