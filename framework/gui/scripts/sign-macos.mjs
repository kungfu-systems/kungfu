// SPDX-License-Identifier: Apache-2.0

import { signAsync } from '@electron/osx-sign';

const CERTIFICATE_HASH = /^[A-F0-9]{40}$/i;

export function resolveMacSigningIdentity(options, env = process.env) {
  const configured = env.CSC_NAME?.trim();
  return configured && CERTIFICATE_HASH.test(configured)
    ? configured
    : options.identity;
}

export async function sign(options) {
  await signAsync({
    ...options,
    identity: resolveMacSigningIdentity(options),
  });
}
