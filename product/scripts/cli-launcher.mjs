// SPDX-License-Identifier: Apache-2.0

export function cliLauncherContent(platform = process.platform) {
  if (platform === 'win32') {
    return [
      '@echo off',
      'set "KUNGFU_INSTALL_SOURCE=archive"',
      'set "KUNGFU_DIR=%~dp0runtime"',
      'set "KUNGFU_PRODUCT_MANIFEST=%~dp0product.json"',
      'set "KUNGFU_UPGRADE_MANIFEST=%~dp0upgrade\\kungfu-release-manifest.json"',
      'set "KF_BUNDLED_EXTENSION_ROOT=%~dp0extensions"',
      'set "KUNGFU_CLI_BIN=%~dp0kungfu.cmd"',
      'set "KUNGFU_AGENT_SESSION_EXECUTABLE=%~dp0runtime\\kungfu.exe"',
      'set "KUNGFU_CONTROLLER_ENTRYPOINT=%~dp0runtime\\kungfu.exe"',
      'set "PYTHONUTF8=1"',
      'set "PYTHONIOENCODING=utf-8"',
      '"%~dp0runtime\\kungfu.exe" %*',
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
export KUNGFU_DIR="$here/runtime"
export KUNGFU_PRODUCT_MANIFEST="$here/product.json"
export KUNGFU_UPGRADE_MANIFEST="$here/upgrade/kungfu-release-manifest.json"
export KF_BUNDLED_EXTENSION_ROOT="$here/extensions"
export KUNGFU_CLI_BIN="$here/kungfu"
export KUNGFU_AGENT_SESSION_EXECUTABLE="$here/runtime/kungfu"
export KUNGFU_CONTROLLER_ENTRYPOINT="$here/runtime/kungfu"
exec "$here/runtime/kungfu" "$@"
`;
}
