# Installed provider migration qualification

The retained qualification runs the official Kungfu CLI archive in isolated
Python processes against disposable populated runtimes. It exercises the public
CLI and the installed Core binding over the same C++ authority-atomic storage
operation.

The drill proves:

- arbitrary valid content namespaces survive File→RocksDB and rollback with
  exact object, byte, and semantic roots;
- a mid-copy process failure leaves File authoritative and a fresh process
  resumes the same operation;
- acknowledged concurrent writes are present after the cut;
- a fresh installed CLI process observes the committed binding;
- manual provider mismatch and pre-cut corruption fail closed;
- rollback reverse-syncs objects admitted after RocksDB became authoritative;
- projections and journals do not enter provider identity;
- the retained provider is not deleted and its residual disk cost remains
  visible; and
- a separately built supported `embedded-sqlite` Core candidate, whose build
  identity omits RocksDB, returns stable `provider_unavailable: rocksdb`
  without publishing migration state or a RocksDB binding.

The no-RocksDB candidate proves the supported Core profile behavior but is not
an official CLI release. Product qualification therefore belongs only to the
exact official artifact and platform named in the retained report. Linux,
Windows, GUI/TUI parity, cross-machine migration, distributed writer fencing,
destructive source cleanup, and physical-media durability remain unqualified.

Run after producing the two artifacts:

```sh
KUNGFU_NO_ROCKS_LIBRARY=/path/to/libkungfu \
KUNGFU_NO_ROCKS_IDENTITY=/path/to/kungfu-core-build-identity.json \
./shifu check:provider-migration-product
```

The retained report lives under
`docs/qualification/evidence/provider-migration-product/<commit>/report.json`.
