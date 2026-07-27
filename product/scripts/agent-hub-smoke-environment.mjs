// SPDX-License-Identifier: Apache-2.0

import path from 'node:path';

export function installedAgentHubSmokeEnvironment(installRoot, env) {
  const userHome = path.join(installRoot, '.agent-hub-user-home');
  return {
    userHome,
    env: {
      ...env,
      HOME: userHome,
      USERPROFILE: userHome,
      // The installed trunk owns a disposable product cache. Pin it outside
      // HOME so the smoke continues to prove that Agent Hub qualification is
      // stateless with respect to the operator-facing user directory.
      KF_CACHE_HOME: path.join(installRoot, '.agent-hub-cache-home'),
    },
  };
}
