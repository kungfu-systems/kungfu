# Product Cache Home

Kungfu keeps disposable runtime caches outside installed artifacts and selected
workspaces. `KF_CACHE_HOME` names the general product cache root; it is not a
replacement for persistent workspace state in `KF_HOME` or product
configuration in `KF_CONFIG_HOME`.

## Resolution contract

The Desktop and installed CLI use the first available row:

| Precedence | Cache root |
| --- | --- |
| 1 | explicit non-empty `KF_CACHE_HOME` |
| 2 | `<KF_INSTANCE_HOME>/cache` |
| 3, macOS | `~/Library/Caches/kungfu` |
| 3, Windows | `%LOCALAPPDATA%\Kungfu\Cache` |
| 3, Linux | `${XDG_CACHE_HOME:-~/.cache}/kungfu` |

Relative explicit paths are resolved from the process working directory, and a
leading `~/` is expanded from the user's home. Operators should prefer absolute
paths when they need a stable managed location.

## Python cache namespace

Python bytecode is written through:

```text
PYTHONPYCACHEPREFIX=KF_CACHE_HOME/python/<runtimeBuildId>
```

`runtimeBuildId` comes from the installed upgrade manifest, so two assembled
runtimes do not share bytecode. Source development without a release manifest
uses `development`. If `KUNGFU_UPGRADE_MANIFEST` is explicitly set, the file and
its safe `runtimeBuildId` are required.

The native trunk owns the final Python launch boundary. Desktop also exports
the resolved values before it creates children, and the Desktop CLI wrapper
binds the colocated release manifest. The packaged runtime excludes pre-existing
`.pyc` files and `__pycache__` directories.

## Operational meaning

Everything under `KF_CACHE_HOME` must be reproducible or disposable. Removing a
versioned Python cache can make the next launch slower while bytecode is rebuilt,
but it must not remove Kungfu facts, configuration, extensions, or installed
runtime bytes. This contract defines location and isolation only; automated
retention and cleanup are separate operational decisions.

On macOS, build the signed directory Product and run the retained qualification:

```sh
./shifu product gui build
./shifu qualify:product-cache-home
```

The qualification checks the signature before and after a real bundled CLI
Python import and a qualification-mode GUI boot, compares the complete
application-tree digest, rejects packaged bytecode, and requires generated
`.pyc` below the external versioned cache. It leaves its disposable cache path
in the JSON receipt for inspection.

The authoritative rationale is
[KF-ADR-019f9ec5-fa5d-76a3-9adb-71611ee67005](../adr/KF-ADR-019f9ec5-fa5d-76a3-9adb-71611ee67005.md).
