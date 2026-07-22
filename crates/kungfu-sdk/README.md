# kungfu-sdk

The Rust SDK is a thin owner for the versioned `libkungfu` native storage
table. It forwards the ABI v1 operation name and UTF-8 JSON request unchanged;
the native runtime remains the only implementation of Episode, query, fsck,
and export semantics.

Consumers that execute native operations enable `link-native` and set
`KUNGFU_NATIVE_DIR` while building so Cargo can link the matching `libkungfu`.
The default feature set stays link-free, allowing documentation, metadata, and
package inspection without an ambient native installation.
