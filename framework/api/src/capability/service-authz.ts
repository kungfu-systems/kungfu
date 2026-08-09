// SPDX-License-Identifier: Apache-2.0

import type { KfxHostContribution } from './kfx-host.js';
import type { SandboxProfile } from './sandbox-launcher.js';

export type ServiceAuthorization = KfxHostContribution['authorization'];

export type ServiceLanding =
  | { tier: 'co-resident' }
  | { tier: 'sandbox'; profile: SandboxProfile; networkConsent: boolean };

function rooted(value: string | null): value is string {
  return value?.startsWith('sha256:') === true;
}

// Runtime placement is a projection of the exact Core authorization. Package
// identity, install origin and host-local settings are deliberately absent.
export function resolveServiceLanding(
  authorization: ServiceAuthorization,
): ServiceLanding {
  const complete =
    authorization.schema === 'kungfu.kfx.host-authorization/v2' &&
    authorization.executionAllowed === true &&
    rooted(authorization.authorizationRoot) &&
    rooted(authorization.packageRoot) &&
    rooted(authorization.manifestRoot) &&
    rooted(authorization.ownerProviderRoot) &&
    rooted(authorization.trustRoot) &&
    rooted(authorization.corePolicyRoot) &&
    rooted(authorization.requestedPolicyRoot) &&
    rooted(authorization.policyRoot) &&
    rooted(authorization.authorizationPlanRoot) &&
    rooted(authorization.capabilityDeclarationRoot) &&
    rooted(authorization.capabilityGrantRoot) &&
    rooted(authorization.warrantRoot) &&
    rooted(authorization.cutRoot) &&
    authorization.requiredCapabilities.every((capability) =>
      authorization.grantedCapabilities.includes(capability),
    );
  if (!complete || authorization.runtimeTier === 'metadata-only') {
    throw new Error(
      'KF_KFX_HOST_NOT_AUTHORIZED: exact Core authorization required',
    );
  }
  if (authorization.runtimeTier === 'integrated-explicit') {
    return { tier: 'co-resident' };
  }
  return {
    tier: 'sandbox',
    profile: {
      base: 'restrictive',
      denyNetwork: !authorization.grantedCapabilities.includes('network'),
      denyWrite: !authorization.grantedCapabilities.includes('storage'),
    },
    networkConsent: authorization.grantedCapabilities.includes('network'),
  };
}
