# Adapters — language and framework boundaries

Where the boundaries are between the C++ core and the languages that consume it,
and where the framework-neutral surface sits. This is a *use* reference: it tells
you which boundary you are crossing, so you know what is in-process zero-copy and
what is not.

## The shape

```
        C++ application / kfx            Python (py_kungfu)        Node (kungfu_node.node)
                  │                             │                          │
                  └──────────────┬──────────────┴──────────────┬───────────┘
                                 │  in-process, zero-copy       │
                          ┌──────┴──────────────────────────────┴──────┐
                          │  libkungfu  —  longfist + yijinjing (C++)   │
                          └─────────────────────────────────────────────┘
```

All three language surfaces are **bindings over the same in-process libkungfu**,
not separate reimplementations. They read the same journal bytes without
serialization (see [`event-model.md`](event-model.md), [`contracts.md`](contracts.md)).

## C++ — the core itself

C++ code (including a C++ `kfx` extension) uses `libkungfu` directly: the
`longfist` types and the `yijinjing` journal API, no binding layer. This is the
reference boundary the other two mirror.

Source: [`framework/core/src/libkungfu/include/kungfu/`](../framework/core/src/libkungfu/include/kungfu),
[`framework/core/src/libkungfu/`](../framework/core/src/libkungfu).

## Python — pybind11

The Python surface is a pybind11 binding (`py_kungfu`) that exposes longfist
types/enums and the wingchun book/broker layer to Python, over the same
in-process core.

Source: [`framework/core/src/bindings/python/binding/`](../framework/core/src/bindings/python/binding)
(`py-longfist*.cpp`, `py-wingchun-*.cpp`).

## Node — N-API

The Node surface is an N-API addon (`kungfu_node.node`) — entry point
`kungfu_node.cpp` — exposing the journal, IO, history, longfist, and the in-memory
state stores. The `watcher` (`watcher.cpp`) is the component that consumes the
journal and presents state to JavaScript for the reference UIs; it is an
`apprentice` (see [`concepts.md`](concepts.md)). N-API is used as the stability
layer so the addon is decoupled from V8 ABI churn.

Source: [`framework/core/src/bindings/node/binding/`](../framework/core/src/bindings/node/binding)
(`kungfu_node.cpp`, `journal.cpp`, `watcher.cpp`, `longfist.cpp`, the `*_store.*`).

## The framework-neutral surface

`framework/api` is the typed, **framework-neutral** capability SDK over the
in-process binding (journal / state / replay). It is the boundary an external
product consumes — independent of any UI framework — and the surface
[ADR-0006](../framework/core/docs/adr/ADR-0006-v4-frontend-platform-architecture.md)
positions as the real value of the platform.

Source: [`framework/api`](../framework/api).

## Where the zero-copy boundary ends

Inside a process, all of the above share the journal bytes with no copy on the
hot path. The boundaries that are **not** zero-copy:

- across processes, frames travel through the mmap journal (still no per-frame
  serialization, but a different mechanism than in-process sharing);
- any export out of the system (e.g. `kfc journal show -o file.csv`, see
  [`debugging.md`](debugging.md)) is an explicit, non-zero-copy conversion.
