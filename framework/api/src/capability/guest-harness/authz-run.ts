// SPDX-License-Identifier: Apache-2.0

import {
  type ServiceAuthorization,
  resolveServiceLanding,
} from '../service-authz.js';

const root = (char: string) => `sha256:${char.repeat(64)}`;

function authorization(
  runtimeTier: ServiceAuthorization['runtimeTier'],
  grantedCapabilities: string[] = [],
): ServiceAuthorization {
  return {
    schema: 'kungfu.kfx.host-authorization/v2',
    packageKey: 'fixture.service',
    packageRoot: root('1'),
    manifestRoot: root('2'),
    ownerProviderRoot: root('3'),
    trustRoot: root('4'),
    runtimeTier,
    admissionGrade: 'kfd-attested',
    placement: 'service-node',
    requiredCapabilities: [],
    grantedCapabilities,
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
const integrated = resolveServiceLanding(authorization('integrated-explicit'));
const networked = resolveServiceLanding(authorization('isolated', ['network']));
if (
  isolated.tier !== 'sandbox' ||
  isolated.profile.denyNetwork !== true ||
  networked.tier !== 'sandbox' ||
  networked.profile.denyNetwork !== false ||
  networked.networkConsent !== true ||
  integrated.tier !== 'co-resident'
) {
  throw new Error('identity-neutral service authorization harness failed');
}
console.log('kfx service authorization exact-root harness: PASS');
