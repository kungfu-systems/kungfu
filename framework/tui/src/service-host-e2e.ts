// SPDX-License-Identifier: Apache-2.0
// Identity-neutral service-placement dogfood. Runtime placement is accepted
// only from the exact Core host authorization chain.

import {
  type ServiceAuthorization,
  resolveServiceLanding,
} from '@kungfu-tech/api/capability';

const root = (value: string) => `sha256:${value.padEnd(64, value[0] ?? '0')}`;

function authorization(
  runtimeTier: ServiceAuthorization['runtimeTier'],
): ServiceAuthorization {
  return {
    schema: 'kungfu.kfx.host-authorization/v2',
    packageKey: 'dogfood.openclaw',
    packageRoot: root('1'),
    manifestRoot: root('2'),
    ownerProviderRoot: root('3'),
    trustRoot: root('4'),
    runtimeTier,
    admissionGrade: 'kfd-attested',
    placement: runtimeTier === 'isolated' ? 'service-node' : 'gui',
    requiredCapabilities: ['ledger'],
    grantedCapabilities: ['ledger'],
    reportRoot: root('5'),
    admissionPlanRoot: root('6'),
    corePolicyRoot: root('7'),
    requestedPolicyRoot: root('8'),
    policyRoot: root('9'),
    authorizationPlanRoot: root('a'),
    capabilityDeclarationRoot: root('b'),
    capabilityGrantRoot: root('c'),
    warrantRoot: root('d'),
    cutRoot: root('e'),
    revision: 1,
    generationRoot: root('f'),
    executionAllowed: true,
    authorizationRoot: root('0'),
  };
}

const isolated = resolveServiceLanding(authorization('isolated'));
if (
  isolated.tier !== 'sandbox' ||
  isolated.profile.base !== 'restrictive' ||
  isolated.profile.denyNetwork !== true
) {
  throw new Error('identity-neutral isolated placement did not fail closed');
}

const integrated = resolveServiceLanding(authorization('integrated-explicit'));
if (integrated.tier !== 'co-resident') {
  throw new Error('explicit integrated placement was not honored');
}

const replayed = { ...authorization('integrated-explicit'), cutRoot: null };
let refused = false;
try {
  resolveServiceLanding(replayed);
} catch (error) {
  refused = String(error).includes('KF_KFX_HOST_NOT_AUTHORIZED');
}
if (!refused) {
  throw new Error('incomplete exact-root authorization did not fail closed');
}

console.log('kfx identity-neutral service placement: PASS');
