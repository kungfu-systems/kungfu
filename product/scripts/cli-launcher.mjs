// SPDX-License-Identifier: Apache-2.0

export function cliLauncherContent(platform = process.platform) {
  if (platform === 'win32') {
    return [
      '@echo off',
      'set "KUNGFU_INSTALL_SOURCE=archive"',
      'set "KUNGFU_PRODUCT_MANIFEST=%~dp0product.json"',
      'set "KUNGFU_UPGRADE_MANIFEST=%~dp0upgrade\\kungfu-release-manifest.json"',
      '"%~dp0kungfu\\kungfu.exe" %*',
      '',
    ].join('\r\n');
  }
  return `#!/bin/sh
set -e
target=$0
while [ -L "$target" ]; do
  link=$(readlink "$target")
  case $link in
    /*) target=$link ;;
    *) target=$(dirname "$target")/$link ;;
  esac
done
here=$(cd "$(dirname "$target")" && pwd)
export KUNGFU_INSTALL_SOURCE=archive
export KUNGFU_PRODUCT_MANIFEST="$here/product.json"
export KUNGFU_UPGRADE_MANIFEST="$here/upgrade/kungfu-release-manifest.json"
exec "$here/kungfu/kungfu" "$@"
`;
}
