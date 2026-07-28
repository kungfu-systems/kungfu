import assert from 'node:assert/strict';
import test from 'node:test';
import {
  projectGuiKfxControl,
  projectGuiKfxExperienceFlow,
} from '../../gui/src/main/kfx-host.ts';
import {
  projectTuiKfxControl,
  projectTuiKfxExperienceFlow,
} from '../../tui/src/kfx-host.ts';
import {
  type KfxControlStatus,
  type KfxExperienceFlowDescriptor,
  authorizeKfxHostLaunch,
  projectKfxControlSuiteHost,
  projectKfxExperienceFlowHost,
} from '../src/capability/kfx-host.ts';

const descriptor: KfxExperienceFlowDescriptor = {
  schema: 'kungfu.kfx.experience-flow-host/v3',
  descriptorRoot: `sha256:${'1'.repeat(64)}`,
  registryRoot: `sha256:${'0'.repeat(64)}`,
  graphRoot: `sha256:${'2'.repeat(64)}`,
  planRoot: `sha256:${'3'.repeat(64)}`,
  receiptDependencyRoot: `sha256:${'4'.repeat(64)}`,
  cutRoot: `sha256:${'5'.repeat(64)}`,
  revision: 7,
  generation: {
    schema: 'kungfu.kfx.host-generation/v2',
    registryRoot: `sha256:${'0'.repeat(64)}`,
    graphRoot: `sha256:${'2'.repeat(64)}`,
    cutRoot: `sha256:${'5'.repeat(64)}`,
    revision: 7,
  },
  generationRoot: `sha256:${'6'.repeat(64)}`,
  admission: {
    schema: 'kungfu.kfx.host-admission/v2',
    state: 'admitted',
    exactRootRequired: true,
    registryRoot: `sha256:${'0'.repeat(64)}`,
    graphRoot: `sha256:${'2'.repeat(64)}`,
    planRoot: `sha256:${'3'.repeat(64)}`,
    cutRoot: `sha256:${'5'.repeat(64)}`,
    revision: 7,
    generationRoot: `sha256:${'6'.repeat(64)}`,
    contributionRoots: [`sha256:${'7'.repeat(64)}`],
    facetRoots: [`sha256:${'8'.repeat(64)}`],
    capabilityRoots: [`sha256:${'9'.repeat(64)}`],
    authorizationRoots: [`sha256:${'a'.repeat(64)}`],
    runtimeAuthorizationRoots: [`sha256:${'d'.repeat(64)}`],
  },
  runtimeAuthorizations: [
    {
      schema: 'kungfu.kfx.host-authorization/v2',
      packageKey: 'workbench',
      packageRoot: `sha256:${'e'.repeat(64)}`,
      manifestRoot: `sha256:${'f'.repeat(64)}`,
      ownerProviderRoot: `sha256:${'b'.repeat(64)}`,
      trustRoot: `sha256:${'c'.repeat(64)}`,
      runtimeTier: 'isolated',
      admissionGrade: 'kfd-attested',
      productSystem: false,
      placement: 'sandboxed-ipc',
      requiredCapabilities: ['domain'],
      grantedCapabilities: ['domain'],
      reportRoot: `sha256:${'1'.repeat(64)}`,
      admissionPlanRoot: `sha256:${'2'.repeat(64)}`,
      corePolicyRoot: `sha256:${'3'.repeat(64)}`,
      requestedPolicyRoot: `sha256:${'4'.repeat(64)}`,
      policyRoot: `sha256:${'5'.repeat(64)}`,
      authorizationPlanRoot: `sha256:${'6'.repeat(64)}`,
      capabilityDeclarationRoot: `sha256:${'7'.repeat(64)}`,
      capabilityGrantRoot: `sha256:${'8'.repeat(64)}`,
      warrantRoot: `sha256:${'9'.repeat(64)}`,
      cutRoot: `sha256:${'5'.repeat(64)}`,
      revision: 7,
      generationRoot: `sha256:${'6'.repeat(64)}`,
      executionAllowed: true,
      authorizationRoot: `sha256:${'d'.repeat(64)}`,
      host: 'gui',
    },
  ],
  contributions: [
    {
      contributionId: 'workbench',
      contributionRoot: `sha256:${'7'.repeat(64)}`,
      ownerProviderRoot: `sha256:${'b'.repeat(64)}`,
      ownerTrustRoot: `sha256:${'c'.repeat(64)}`,
      capabilityRoot: `sha256:${'9'.repeat(64)}`,
      facetRoot: `sha256:${'8'.repeat(64)}`,
      capabilities: ['domain'],
      authorization: {
        schema: 'kungfu.kfx.host-authorization/v2',
        packageKey: 'workbench',
        packageRoot: `sha256:${'e'.repeat(64)}`,
        manifestRoot: `sha256:${'f'.repeat(64)}`,
        ownerProviderRoot: `sha256:${'b'.repeat(64)}`,
        trustRoot: `sha256:${'c'.repeat(64)}`,
        runtimeTier: 'isolated',
        admissionGrade: 'kfd-attested',
        productSystem: false,
        placement: 'sandboxed-ipc',
        requiredCapabilities: ['domain'],
        grantedCapabilities: ['domain'],
        reportRoot: `sha256:${'1'.repeat(64)}`,
        admissionPlanRoot: `sha256:${'2'.repeat(64)}`,
        corePolicyRoot: `sha256:${'3'.repeat(64)}`,
        requestedPolicyRoot: `sha256:${'4'.repeat(64)}`,
        policyRoot: `sha256:${'5'.repeat(64)}`,
        authorizationPlanRoot: `sha256:${'6'.repeat(64)}`,
        capabilityDeclarationRoot: `sha256:${'7'.repeat(64)}`,
        capabilityGrantRoot: `sha256:${'8'.repeat(64)}`,
        warrantRoot: `sha256:${'9'.repeat(64)}`,
        cutRoot: `sha256:${'5'.repeat(64)}`,
        revision: 7,
        generationRoot: `sha256:${'6'.repeat(64)}`,
        executionAllowed: true,
        authorizationRoot: `sha256:${'a'.repeat(64)}`,
      },
      state: 'active',
      presentation: { optional: true, hosts: ['gui', 'cli'] },
    },
  ],
};

test('GUI, TUI, CLI, and Agent adapters retain the same Core identities', () => {
  const projections = [
    projectGuiKfxExperienceFlow(descriptor),
    projectTuiKfxExperienceFlow(descriptor),
    projectKfxExperienceFlowHost(descriptor, 'cli'),
    projectKfxExperienceFlowHost(descriptor, 'agent'),
  ];
  for (const projection of projections) {
    assert.equal(projection.descriptorRoot, descriptor.descriptorRoot);
    assert.equal(projection.graphRoot, descriptor.graphRoot);
    assert.equal(projection.planRoot, descriptor.planRoot);
    assert.equal(
      projection.receiptDependencyRoot,
      descriptor.receiptDependencyRoot,
    );
    assert.equal(projection.cutRoot, descriptor.cutRoot);
    assert.equal(projection.revision, descriptor.revision);
    assert.equal(projection.generationRoot, descriptor.generationRoot);
    assert.equal(projection.admissionState, 'admitted');
    assert.equal(projection.contributions[0]?.semanticState, 'active');
  }
  assert.equal(projections[0]?.contributions[0]?.presentationState, 'active');
  assert.equal(projections[1]?.contributions[0]?.presentationState, 'dormant');
  assert.equal(projections[1]?.contributions[0]?.executionEligible, false);
  assert.equal(
    projections[1]?.diagnostics[0]?.code,
    'KF_KFX_PRESENTATION_DORMANT',
  );
});

test('runtime launch requires the exact grant, generation, and authorization root', () => {
  const authorization = authorizeKfxHostLaunch(
    descriptor,
    'workbench',
    'gui',
    `sha256:${'d'.repeat(64)}`,
  );
  assert.equal(authorization.capabilityGrantRoot, `sha256:${'8'.repeat(64)}`);

  const stale: KfxExperienceFlowDescriptor = structuredClone(descriptor);
  const staleAuthorization = stale.runtimeAuthorizations[0];
  assert.ok(staleAuthorization);
  staleAuthorization.generationRoot = `sha256:${'0'.repeat(64)}`;
  assert.throws(
    () =>
      authorizeKfxHostLaunch(
        stale,
        'workbench',
        'gui',
        `sha256:${'d'.repeat(64)}`,
      ),
    /authorization does not match/,
  );
});

test('preview and mismatched admissions fail closed before host execution', () => {
  const preview: KfxExperienceFlowDescriptor = structuredClone(descriptor);
  preview.cutRoot = null;
  preview.generation.cutRoot = null;
  preview.admission.cutRoot = null;
  preview.admission.state = 'preview-only';
  const previewAuthorization = preview.runtimeAuthorizations[0];
  assert.ok(previewAuthorization);
  previewAuthorization.cutRoot = null;
  previewAuthorization.executionAllowed = false;
  const previewContribution = preview.contributions[0];
  assert.ok(previewContribution);
  previewContribution.authorization.cutRoot = null;
  const projected = projectKfxExperienceFlowHost(preview, 'gui');
  assert.equal(projected.admissionState, 'preview-only');
  assert.equal(projected.contributions[0]?.executionEligible, false);
  assert.equal(projected.diagnostics[0]?.code, 'KF_KFX_HOST_NOT_ADMITTED');

  const mismatched: KfxExperienceFlowDescriptor = structuredClone(descriptor);
  mismatched.admission.capabilityRoots[0] = `sha256:${'f'.repeat(64)}`;
  assert.throws(
    () => projectKfxExperienceFlowHost(mismatched, 'gui'),
    /contribution admission identity does not match/,
  );
});

test('GUI, TUI, CLI, and Agent retain one Control Suite status root', () => {
  const status: KfxControlStatus = {
    schema: 'kungfu.kfx.control-suite-status/v1',
    controllerId: 'kungfu-kfx-control-suite',
    statusRoot: `sha256:${'d'.repeat(64)}`,
    cutRoot: `sha256:${'e'.repeat(64)}`,
    revision: 3,
    mode: 'active',
    executionAllowed: true,
    active: {
      packageRoot: `sha256:${'1'.repeat(64)}`,
      manifestRoot: `sha256:${'2'.repeat(64)}`,
      version: '4.0.0-alpha.2',
    },
    lastKnownGood: {
      packageRoot: `sha256:${'3'.repeat(64)}`,
      manifestRoot: `sha256:${'4'.repeat(64)}`,
      version: '4.0.0-alpha.1',
      sourcePath: '/retained/kfx-manager',
    },
    diagnostics: [],
  };
  const projections = [
    projectGuiKfxControl(status),
    projectTuiKfxControl(status),
    projectKfxControlSuiteHost(status, 'cli'),
    projectKfxControlSuiteHost(status, 'agent'),
  ];
  assert.deepEqual(
    projections.map((projection) => projection.statusRoot),
    Array(4).fill(status.statusRoot),
  );
  assert.deepEqual(
    projections.map((projection) => projection.revision),
    Array(4).fill(status.revision),
  );
  assert.ok(projections.every((projection) => projection.executionAllowed));
});
