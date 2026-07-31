// SPDX-License-Identifier: Apache-2.0

export function shouldOpenAgentWorkLab(
  startupSurface: string,
  availableKfxCount: number,
): boolean {
  return startupSurface === 'agent-work-lab' || availableKfxCount === 0;
}

export function unavailableKfxMessage(discoveredKfxCount: number): string {
  return discoveredKfxCount === 0
    ? 'no extensions found on the extension path'
    : `${discoveredKfxCount} extensions discovered, but none admitted for GUI execution`;
}

const DEFERRED_HOST_AUTHORIZATION =
  'KF_KFX_HOST_NOT_AUTHORIZED: exact Core host authorization required';

export function actionableKfxFailures<T extends { error: string }>(
  failures: T[],
  hostDescriptorAvailable: boolean,
): T[] {
  if (hostDescriptorAvailable) return failures;
  return failures.filter(
    (failure) => failure.error !== DEFERRED_HOST_AUTHORIZATION,
  );
}
