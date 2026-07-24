# `@kungfu-tech/storage`

The Node SDK exposes the versioned libkungfu storage contract without the GUI,
Electron, Python binding, or another language SDK. Its platform package carries
only the Node adapter, `libkungfu`, and public contract metadata.

The additive L1 wire edge uses the same `kungfu_get_api` C ABI as the C++,
Python, and Rust SDKs:

```js
const kungfu = require('@kungfu-tech/storage');

const wire = kungfu.callRuntimeActionRaw(
  runtimeDir,
  Buffer.from('{"action":"geometry_root"}'),
);
const typed = kungfu.runtimeActionV1.geometryRoot(kungfu, runtimeDir);
```

`wire` preserves the exact response protocol, version, schema, encoding, and
bytes returned by `libkungfu`. Generated typed methods parse that receipt but
also return it unchanged. JSON is the named runtime-action edge encoding; it
does not redefine Fact KFR2, Episode identity, or FlatBuffers carrier bytes.

Product consumers use the generated `runtimeActionV1` methods (or the explicit
`callRuntimeActionRaw`/`callRuntimeActionJson` standard-ABI adapters). Loading
`kungfu_node.node` or calling its native methods directly is reserved for this
package's adapter and qualification tests.

The older top-level `execute(runtimeDir, operation, request)` API remains as a
compatibility alias for `storageHelper.execute`. It addresses the internal
storage-service helper surface and makes no cross-language ABI-parity claim.
`surfaceBoundary` exposes this distinction for tooling.
