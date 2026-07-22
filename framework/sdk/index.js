// SPDX-License-Identifier: Apache-2.0

const path = require('node:path');
const runtimeActionV1 = require('./generated/runtime-action-v1.js');

const PLATFORM_PACKAGES = {
  'darwin-arm64': '@kungfu-tech/storage-darwin-arm64',
  'linux-x64': '@kungfu-tech/storage-linux-x64',
  'win32-x64': '@kungfu-tech/storage-win32-x64',
};

function loadBinding() {
  const key = `${process.platform}-${process.arch}`;
  const packageName = PLATFORM_PACKAGES[key];
  if (!packageName)
    throw new Error(`@kungfu-tech/storage does not support ${key}`);
  const platformPackage = require(packageName);
  return require(path.join(platformPackage.bindingDir, 'kungfu_node.node'));
}

let binding;
function native() {
  binding ||= loadBinding();
  return binding;
}

module.exports = {
  contract: require('./kungfu-storage.contract.json'),
  runtimeActionV1,
  capabilities() {
    return native().storageServiceCapabilities();
  },
  execute(runtimeDir, operation, request = {}) {
    return native().runStorageServiceOperation(operation, runtimeDir, request);
  },
  callRuntimeActionRaw(
    runtimeDir,
    requestBytes,
    {
      protocolId = 'kungfu.runtime.action',
      protocolVersion = 1,
      schemaRef = 'kungfu.action-runtime.operation/v1',
      encoding = 'application/json',
    } = {},
  ) {
    const bytes = Buffer.isBuffer(requestBytes)
      ? requestBytes
      : Buffer.from(requestBytes);
    return native().runRuntimeActionWire(
      runtimeDir,
      protocolId,
      protocolVersion,
      schemaRef,
      encoding,
      bytes,
    );
  },
  callRuntimeActionJson(runtimeDir, request) {
    return module.exports.callRuntimeActionRaw(
      runtimeDir,
      Buffer.from(JSON.stringify(request)),
    );
  },
};
