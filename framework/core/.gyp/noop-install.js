// SPDX-License-Identifier: Apache-2.0
// @ts-check

/**
 * No-op install guard for `@kungfu-tech/core`.
 *
 * v4 no longer compiles the native addon on `npm install`. Prebuilt binaries
 * arrive through npm platform packages (`@kungfu-tech/core-{platform}`, wired as
 * optionalDependencies); the runtime resolver (`lib/kungfu.js`) loads the addon
 * from the matching platform package, falling back to an in-package build tree
 * for developers who ran `npm run build` explicitly.
 *
 * Mirrors the libnode `noop-install.js` guard. Developers build with
 * `npm run build` (source) or consume the published platform package.
 */

// Intentionally does nothing. Kept as a script (not an empty string) so
// `verify-source` can assert the install script points at this guard.
