# Python environments — `kungfu env`

How to use the full Python package ecosystem (PyTorch-class included) with
Kungfu. The product manages its own exact Python runtime; every package you
install resolves against that runtime and can read journal data through
`pykungfu` at full zero-copy. This is a *use* reference; the architecture and
its staged adoption live in
[ADR-0046](../framework/core/docs/adr/ADR-0046-rust-host-trunk-and-assembled-runtime.md).

## The one-runtime contract

Kungfu ships and manages the only Python your Kungfu packages run on:

- **One pinned interpreter.** Environments derive exclusively from the exact
  CPython build the product pins (`runtime-pins.env`, shipped next to the
  binary). Your system Python, Homebrew Python, or conda are never eligible —
  by mechanism, not by convention.
- **Kungfu owns the install surface.** Packages are installed through
  `kungfu env` (with [uv](https://docs.astral.sh/uv/) as the engine
  underneath). There is no pip step to get wrong.
- **Wrong runtime is a named error.** If Kungfu Python code ever runs on a
  foreign interpreter it stops immediately with a message naming what was
  found, what was expected, and the fix — instead of failing three layers
  deeper in a native import.

## Commands

```sh
kungfu env create [<name>]              # create an env (default name: default)
kungfu env add <pkg>... [--env <name>]  # install packages
kungfu env remove <pkg>... [--env <name>]
kungfu env list
kungfu env info [<name>]
kungfu env run [--env <name>] [-- <cmd>...]   # run inside the env (default: python)
kungfu env delete <name>
```

Environments live under `<KF_HOME>/envs/<name>`. Every new env comes with the
`kungfu` package (and its `pykungfu` native binding) pre-installed from the
wheel shipped inside the product, so `import pykungfu` works from birth.

## First use downloads the toolchain — once

The installer stays small: neither uv nor the Python interpreter travels
inside it. Your first `kungfu env create` fetches the pinned uv (exact
version, checksum-verified) and, through it, the pinned CPython — both into a
user-level cache shared across installs. Subsequent envs are instant.

Behind a firewall, set `KUNGFU_UV_DIST_MIRROR` to a reachable mirror of the
uv release assets; a failed fetch prints the exact URL, the expected checksum,
and this override. For air-gapped machines, `kungfu-trunk prewarm` produces
the warmed cache on a connected machine (the offline installer variant ships
it pre-warmed) — the on-demand and offline paths are the same code, differing
only in when the cache fills.

## Example: heavy packages on journal data

```sh
kungfu env create research
kungfu env add pandas --env research
kungfu env run --env research -- python analyze.py
```

where `analyze.py` reads frames through the binding:

```python
import pandas as pd
import pykungfu

rt = pykungfu.runtime
# ... open a location and assemble(loc, 0).read_bytes(carrier_type) ...
df = pd.DataFrame(decoded_rows)
```

Satellite processes speak to the runtime over the journal's shared-memory
fabric — installing a heavy stack into an env costs the runtime nothing.

## Escape hatch (explicit, named)

Setting `KUNGFU_ALLOW_FOREIGN_RUNTIME=1` lets the kungfu package load on an
unblessed interpreter, with a warning. This is for development experiments;
nothing about it is supported.
