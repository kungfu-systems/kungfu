// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SDK_PACKAGE_PLATFORMS,
  sdkPackagePlatformDescriptor,
} from './package-platforms.mjs';

test('SDK packaging covers every formal release host', () => {
  assert.deepEqual(
    SDK_PACKAGE_PLATFORMS.map(({ key }) => key),
    ['darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64'],
  );
  assert.deepEqual(sdkPackagePlatformDescriptor('linux-arm64'), {
    key: 'linux-arm64',
    os: ['linux'],
    cpu: ['arm64'],
  });
  assert.equal(sdkPackagePlatformDescriptor('linux-riscv64'), undefined);
});
