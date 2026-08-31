// SPDX-License-Identifier: Apache-2.0
// @ts-check

export const SDK_PACKAGE_PLATFORMS = Object.freeze([
  Object.freeze({ key: 'darwin-arm64', os: ['darwin'], cpu: ['arm64'] }),
  Object.freeze({ key: 'linux-x64', os: ['linux'], cpu: ['x64'] }),
  Object.freeze({ key: 'linux-arm64', os: ['linux'], cpu: ['arm64'] }),
  Object.freeze({ key: 'win32-x64', os: ['win32'], cpu: ['x64'] }),
]);

export function sdkPackagePlatformDescriptor(key) {
  return SDK_PACKAGE_PLATFORMS.find((item) => item.key === key);
}
