// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import { signAsync } from '@electron/osx-sign';

const CERTIFICATE_HASH = /^[A-F0-9]{40}$/i;
const MAC_CODE_BUNDLE = /\.(?:app|framework)$/i;
const MACH_O_MAGICS = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
  0xcafebabf, 0xbfbafeca,
]);

export function resolveMacSigningIdentity(options, env = process.env) {
  const configured = env.CSC_NAME?.trim();
  return configured && CERTIFICATE_HASH.test(configured)
    ? configured
    : options.identity;
}

export function isMachOHeader(header) {
  return header.length >= 4 && MACH_O_MAGICS.has(header.readUInt32BE(0));
}

export function isMacCodeArtifact(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) return MAC_CODE_BUNDLE.test(filePath);
  if (!stat.isFile()) return false;

  const header = Buffer.alloc(4);
  const descriptor = fs.openSync(filePath, 'r');
  let bytesRead;
  try {
    bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return bytesRead === header.length && isMachOHeader(header);
}

export function resolveMacSigningIgnore(
  ignore,
  inspectCode = isMacCodeArtifact,
) {
  const configured =
    ignore === undefined ? [] : Array.isArray(ignore) ? ignore : [ignore];
  // osx-sign 1.3.3 drops array ignores during option normalization.
  return (filePath) => {
    if (
      configured.some((rule) =>
        typeof rule === 'function' ? rule(filePath) : filePath.match(rule),
      )
    ) {
      return true;
    }
    try {
      // osx-sign treats every binary-looking resource as code. Restrict its
      // traversal to Mach-O files and nested code bundles; the app signature
      // still seals ordinary resources such as .pak, .pyc, and JSON files.
      return !inspectCode(filePath);
    } catch {
      // Do not silently skip paths that cannot be inspected. Let codesign fail
      // closed with the concrete path and filesystem error instead.
      return false;
    }
  };
}

export async function sign(options) {
  await signAsync({
    ...options,
    identity: resolveMacSigningIdentity(options),
    ignore: resolveMacSigningIgnore(options.ignore),
  });
}
