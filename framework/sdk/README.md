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
