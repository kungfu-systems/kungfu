// SPDX-License-Identifier: Apache-2.0
// @ts-check

const ROOTS = Object.freeze({
  cargo: `sha256:${'01'.repeat(32)}`,
  pnpm: `sha256:${'02'.repeat(32)}`,
  gyp: `sha256:${'03'.repeat(32)}`,
  uv: `sha256:${'04'.repeat(32)}`,
  conan: `sha256:${'05'.repeat(32)}`,
  cmake: `sha256:${'06'.repeat(32)}`,
  wheel: `sha256:${'07'.repeat(32)}`,
  freezer: `sha256:${'08'.repeat(32)}`,
  kfx: `sha256:${'09'.repeat(32)}`,
  tui: `sha256:${'0a'.repeat(32)}`,
  gui: `sha256:${'0b'.repeat(32)}`,
  product: `sha256:${'0c'.repeat(32)}`,
  buildchain: `sha256:${'0d'.repeat(32)}`,
});

const layer = (id) => ({ authority: 'layers', id });
const capability = (id) => ({ authority: 'build-capabilities', id });

function node(id, task, authorityRefs, dependencies, toolchain) {
  return {
    id,
    authorityRefs,
    dependencies,
    executor: {
      entrypoint: './shifu',
      task,
      executionOwnedBy: 'external-orchestrator',
      invokedByVerifier: false,
    },
    inputs: [
      {
        id: `${toolchain}-toolchain`,
        kind: 'toolchain',
        root: ROOTS[toolchain],
      },
    ],
    outputs: [{ id: `${id}-artifact`, kind: 'artifact', root: null }],
    events: ['planned', 'started', 'succeeded', 'failed', 'cancelled'],
    exit: {
      successCodes: [0],
      timeoutSeconds: 3600,
      failureIsNonQualifying: true,
      cancellationIsNonQualifying: true,
    },
    failure: {
      owner: 'external-orchestrator',
      retainedEvidence: [`${id}-log`],
    },
    recovery: {
      strategy: 'replan',
      nextAction: 'Retain evidence and compile a new source-bound graph.',
    },
    nextAction: 'Return the rooted artifact to the external orchestrator.',
  };
}

export const POLYGLOT_SOURCE = Object.freeze({
  repository: 'https://github.com/kungfu-origin/kungfu.git',
  revision: '1111111111111111111111111111111111111111',
  tree: '2222222222222222222222222222222222222222',
});

export const POLYGLOT_COMPILE_REQUEST = Object.freeze({
  schema: 'shifu.production-graph-compile-request/v0',
  graphId: 'kungfu-polyglot-production',
  source: POLYGLOT_SOURCE,
  authorityReferences: {
    layers:
      'sha256:54f44d87db79ab8ade2fb4331587f746a955749209689253f0dad0c2e4ac9cf8',
    buildCapabilities:
      'sha256:229d283aa048b71197393335772f8243ab9e36a0ecaae7d8f3c9b2b11e9ad157',
  },
  semanticImpact: {
    selectionRoot: `sha256:${'cc'.repeat(32)}`,
  },
  xinfaVerification: {
    owner: 'xinfa',
    status: 'verified',
    sourceRevision: POLYGLOT_SOURCE.revision,
    selectionRoot: `sha256:${'cc'.repeat(32)}`,
    verificationRoot: `sha256:${'dd'.repeat(32)}`,
  },
  intent: {
    mode: 'describe-only',
    summary:
      'Describe the exact Kungfu polyglot production path without executing it.',
    requestedOutputs: ['buildchain-handoff-artifact'],
    sideEffects: false,
  },
  nodes: [
    node(
      'cargo-build',
      'xinfa:build',
      [layer('core-composition-bindings'), capability('journal-core')],
      [],
      'cargo',
    ),
    node(
      'pnpm-build',
      'build',
      [layer('core-composition-bindings'), capability('full')],
      [],
      'pnpm',
    ),
    node(
      'gyp-build',
      'build:core',
      [layer('core-composition-bindings'), capability('node')],
      ['pnpm-build'],
      'gyp',
    ),
    node(
      'uv-build',
      'freeze',
      [layer('core-composition-bindings'), capability('python')],
      [],
      'uv',
    ),
    node(
      'conan-configure',
      'core:affected:configure',
      [
        layer('core-native-qualification'),
        capability('full'),
        capability('file-storage'),
        capability('sqlite-projection'),
        capability('cxx'),
        capability('fmt'),
      ],
      [],
      'conan',
    ),
    node(
      'cmake-build',
      'core:affected',
      [
        layer('core-native-qualification'),
        layer('kungfu_composition'),
        capability('kungfu_composition'),
      ],
      ['conan-configure'],
      'cmake',
    ),
    node(
      'wheel-package',
      'pack:core-platform',
      [layer('core-composition-bindings'), capability('python')],
      ['uv-build', 'cmake-build'],
      'wheel',
    ),
    node(
      'freezer-package',
      'freeze',
      [layer('core-composition-bindings'), capability('python')],
      ['wheel-package'],
      'freezer',
    ),
    node(
      'kfx-build',
      'build:extensions',
      [layer('runtime-extension-services'), capability('full')],
      ['cargo-build', 'cmake-build'],
      'kfx',
    ),
    node(
      'tui-build',
      'build:cli',
      [layer('core-composition-bindings'), capability('full')],
      ['gyp-build'],
      'tui',
    ),
    node(
      'gui-build',
      'build:app',
      [layer('core-composition-bindings'), capability('electron')],
      ['gyp-build'],
      'gui',
    ),
    node(
      'product-assembly',
      'product',
      [layer('core-composition-bindings'), capability('full')],
      ['freezer-package', 'gui-build', 'kfx-build', 'tui-build'],
      'product',
    ),
    node(
      'buildchain-handoff',
      'release:qualify:core-platform',
      [layer('core-native-qualification'), capability('full')],
      ['product-assembly'],
      'buildchain',
    ),
  ],
  nextAction:
    'Hand the rooted plan to the external orchestrator for separate admission.',
});
