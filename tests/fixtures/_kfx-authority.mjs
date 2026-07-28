// SPDX-License-Identifier: Apache-2.0
//
// Qualification-only KFX authority fixtures. These values exercise Core's
// exact-root admission and recovery contracts; they are not Product authority
// and must never be used outside tests or release qualification probes.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const APPROVAL_ROOT = `sha256:${'a'.repeat(64)}`;
const HIGH_CONSEQUENCE_CAPABILITIES = new Set([
  'agentRuntime',
  'kfxControl',
  'process',
  'storage',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function qualificationRoot(label, packageRoot) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        schema: 'kungfu.kfx-qualification-root/v1',
        label,
        packageRoot,
      }),
    )
    .digest('hex')}`;
}

export function qualificationAuthority(
  repoDir,
  packageRoot,
  declaredCapabilities,
) {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.join(
        repoDir,
        'framework',
        'core',
        'src',
        'libkungfu',
        'tests',
        'fixtures',
        'native_kfx_contract',
        'buildchain-2.13.0-alpha.0-envelope.json',
      ),
      'utf8',
    ),
  );
  const projection = fixture.projection;
  const attestation = clone(projection.attestation);
  const trustInputs = clone(projection.trustInputs);
  attestation.bindings.packageRoot = packageRoot;
  trustInputs.packageRoot = packageRoot;
  const capabilities = [...declaredCapabilities];
  const policy = clone(fixture.admission.policy);
  policy.allowedCapabilities = [
    ...new Set([...policy.allowedCapabilities, ...capabilities]),
  ].sort();
  policy.autoOperations = ['install', 'update', 'enable', 'activate', 'qualify'];
  return {
    purpose: fixture.admission.purpose,
    policy,
    assessmentTime: fixture.assessmentTime,
    authorizationTime: fixture.assessmentTime,
    attestation,
    trustInputs,
    kfdAssessment: clone(projection.kfdAssessment),
    requestedCapabilities: capabilities,
    approvalRoots: capabilities.some((capability) =>
      HIGH_CONSEQUENCE_CAPABILITIES.has(capability),
    )
      ? [APPROVAL_ROOT]
      : [],
  };
}

export function removalAuthority(packageRoot, status, nonce) {
  const authorizationTime = 1000 + Number(status.revision);
  return {
    authorizationTime,
    approvalRoots: [APPROVAL_ROOT],
    recoveryWarrant: {
      schema: 'kungfu.kfx-recovery-warrant/v1',
      issuerClass: 'workspace-owner',
      operation: 'remove',
      packageRoot,
      expectedCutRoot: status.cutRoot,
      expectedRevision: status.revision,
      approvalRoots: [APPROVAL_ROOT],
      issuedAt: authorizationTime - 1,
      expiresAt: authorizationTime + 100,
      nonce,
    },
  };
}

export function qualificationHostDescriptor(packageKey, packageRoot, runtime) {
  const root = (label) => qualificationRoot(label, packageRoot);
  const cutRoot = root('cut');
  const generationRoot = root('generation');
  const authorizationRoot = root(`adapter-${runtime}-authorization`);
  const authorization = {
    schema: 'kungfu.kfx.host-authorization/v2',
    packageKey,
    packageRoot,
    manifestRoot: root('manifest'),
    ownerProviderRoot: root('owner-provider'),
    trustRoot: root('trust'),
    runtimeTier: 'integrated-explicit',
    admissionGrade: 'kfd-attested',
    placement: 'co-resident',
    requiredCapabilities: [],
    grantedCapabilities: [],
    reportRoot: root('report'),
    admissionPlanRoot: root('admission-plan'),
    corePolicyRoot: root('core-policy'),
    requestedPolicyRoot: root('requested-policy'),
    policyRoot: root('policy'),
    authorizationPlanRoot: root('authorization-plan'),
    capabilityDeclarationRoot: root('capability-declaration'),
    capabilityGrantRoot: root('capability-grant'),
    warrantRoot: root('warrant'),
    cutRoot,
    revision: 1,
    generationRoot,
    executionAllowed: true,
    authorizationRoot,
    host: `adapter-${runtime}`,
  };
  const registryRoot = root('registry');
  const graphRoot = root('graph');
  return {
    schema: 'kungfu.kfx.experience-flow-host/v3',
    descriptorRoot: root('descriptor'),
    registryRoot,
    graphRoot,
    planRoot: root('plan'),
    receiptDependencyRoot: root('receipt-dependency'),
    cutRoot,
    revision: 1,
    generation: {
      schema: 'kungfu.kfx.host-generation/v2',
      registryRoot,
      graphRoot,
      cutRoot,
      revision: 1,
    },
    generationRoot,
    admission: {
      schema: 'kungfu.kfx.host-admission/v2',
      state: 'admitted',
      exactRootRequired: true,
      registryRoot,
      graphRoot,
      planRoot: root('plan'),
      cutRoot,
      revision: 1,
      generationRoot,
      contributionRoots: [],
      facetRoots: [],
      capabilityRoots: [],
      authorizationRoots: [],
      runtimeAuthorizationRoots: [authorizationRoot],
    },
    runtimeAuthorizations: [authorization],
    contributions: [],
  };
}
