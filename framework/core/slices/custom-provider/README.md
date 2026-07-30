# Custom provider consumer

This standalone CMake project models a third-party static embedder. It consumes
the public `yijinjing` target and `provider_registry.h`, registers an
instance-local in-memory provider without static initialization, and verifies
descriptor discovery, configuration, read/write, error mapping, duplicate IDs,
and unavailable-provider diagnostics.

Run it after seeding the Core Conan toolchain:

```bash
node framework/core/slices/custom-provider/run.mjs
```
