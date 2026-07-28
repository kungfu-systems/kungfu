// SPDX-License-Identifier: Apache-2.0

import {
  type KfxExperienceFlowDescriptor,
  authorizeKfxHostLaunch,
} from '@kungfu-tech/api/capability';

export type SessionWindowLaunchAuthorization = {
  descriptor: KfxExperienceFlowDescriptor;
  packageKey: string;
  authorizationRoot: string;
};

// A session window deliberately enables Node integration because it hosts the
// terminal relay client. That privilege is available only when the exact Core
// descriptor grants the terminal KFX an integrated GUI placement.
export function authorizeSessionWindowLaunch(
  launch: SessionWindowLaunchAuthorization,
): SessionWindowLaunchAuthorization {
  const authorization = authorizeKfxHostLaunch(
    launch.descriptor,
    launch.packageKey,
    'gui',
    launch.authorizationRoot,
  );
  if (
    authorization.runtimeTier !== 'integrated-explicit' ||
    !authorization.requiredCapabilities.includes('terminal') ||
    !authorization.grantedCapabilities.includes('terminal')
  ) {
    throw new Error(
      'KF_KFX_HOST_NOT_AUTHORIZED: session window requires an exact integrated terminal grant',
    );
  }
  return launch;
}
