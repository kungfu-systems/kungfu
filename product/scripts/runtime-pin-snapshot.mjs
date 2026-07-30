// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';

export function readTrunkRuntimePinSnapshot({ runtimePinsPath, repoPinPath }) {
  const runtimePins = fs.readFileSync(runtimePinsPath, 'utf8');
  const uvPin = (runtimePins.match(/^UV_VERSION=(.+)$/m) || [])[1]?.trim();
  const repoPin = fs.readFileSync(repoPinPath, 'utf8').trim();
  if (!uvPin || uvPin !== repoPin) {
    throw new Error(
      `runtime-pins.env pins uv ${uvPin} but .uv-version pins ${repoPin}; update product/runtime-pins.env (version and checksums) alongside .uv-version`,
    );
  }
  return Object.freeze({ runtimePins, uvPin, repoPin });
}
