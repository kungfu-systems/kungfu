# Windows crash symbols (ship the PDBs)

## Constraint

Every kungfu-compiled native shipped in a Windows release **must** have its PDB
next to it in `dist/kfc`:

| Native | PDB |
| --- | --- |
| `kungfu_node.node` | `kungfu_node.pdb` |
| `kungfu_electron.node` | `kungfu_electron.pdb` |
| `drone.node` | `drone.pdb` |
| `pykungfu*.pyd` | `pykungfu*.pdb` |

Third-party natives (`libnode.dll`, `link_node.node`) are out of scope — they
ship without PDBs of ours.

## Why

When a native crash reaches the yijinjing stackwalker (an access violation in the
`hero::produce` event loop, or a C++ exception escaping into `std::terminate` in
the node binding), the walker resolves each frame through DbgHelp. On Windows,
unlike Linux/macOS, the binary carries **no** symbol table — the function names
and source lines live only in the PDB.

- **PDB present** → frames resolve to `func+0xNN (file:line)`, so a field crash
  report points at the exact failure site.
- **PDB absent** → frames degrade to `[kungfu_node.node+0xRVA]`. Still
  recoverable offline (see below), but the on-box report is not directly
  readable.

The C++ core (`libkungfu` / `libyijinjing`, including the stackwalker itself) is
linked **statically** into `kungfu_node.node` / `pykungfu.pyd` on Windows, so
those two PDBs cover the whole native surface — there is no separate
`libkungfu.dll` PDB to ship.

## How it is enforced

1. **Generation** — `.cmake/compiler.cmake` builds MSVC targets with `/Z7`
   (debug info embedded per-`.obj`, so `sccache` still caches the compile) and
   links with `/DEBUG /OPT:REF /OPT:ICF` (emit `<target>.pdb` while keeping the
   Release size optimizations `/DEBUG` otherwise disables).
2. **Packaging** — `.gyp/run-freeze.js` copies each native's `.pdb` sibling into
   `dist/kfc` alongside the binary.
3. **Verification** — `.gyp/verify-windows-symbols.js` runs at the end of the
   Windows freeze and `exit(1)`s if any required native lacks a PDB, so a release
   that would ship unsymbolizable crash reports fails the build instead.

Run the check standalone against a staged release:

```
node .gyp/verify-windows-symbols.js dist/kfc
```

## Symbolizing an old report offline

If a crash report only has `[module+0xRVA]` lines (e.g. from a build made before
this constraint, or a stripped third-party frame), resolve them against the
matching PDB with any of: WinDbg (`!address` / `ln module+RVA`), `cvdump`, or a
short DbgHelp `SymFromAddr` helper. The RVA plus the exact-version PDB is enough;
keep PDBs archived per release so past crash reports stay decodable.

## Minidump companion (`.dmp`)

On a real fault (the SEH `__except` in `hero::produce` and the
`SetUnhandledExceptionFilter` backstop, both of which carry an exception
context), the crash handler writes a **minidump** alongside the text report, in
the same directory (`$KF_HOME/logview`), with the same `<pid>_<ts>` stem. The
non-fatal diagnostic call `print_stack_trace()` (no exception context, used by
node/rx catch blocks) stays text-only and does not emit a dump.

| File | Contents | Best for |
| --- | --- | --- |
| `hs_err_pid<pid>_<ts>.log` | Text report: exception code + symbolized native stack + system/module info | Quick on-box reading, no tools |
| `hs_err_pid<pid>_<ts>.dmp` | `MiniDumpNormal`: thread stacks, register contexts, module list, handles | Offline post-mortem in WinDbg / Visual Studio |

**Why both.** The text report resolves symbols in-process via DbgHelp (`Sym*`),
which allocates on the crashing heap — fine normally, but the heap is exactly
what is broken in a heap-corruption crash, the case most worth diagnosing. The
minidump snapshots memory and the module list and defers symbolization to
offline, so it needs no in-handler symbol allocation and usually survives
heap-corruption crashes that truncate the text stack.

### Residual limitations (by tier)

1. **Normal fault (null-deref AV):** full symbolized text stack; dump fully
   usable. No loss.
2. **Moderate heap corruption:** text stack may degrade to `module+offset`
   (still offline-symbolizable, above); the minidump is normally intact and is
   the preferred artifact.
3. **Extreme heap corruption:** both can truncate — `MiniDumpWriteDump` itself
   walks loader data and allocates, so a sufficiently corrupted process can
   defeat it. Accepted limitation.
4. **Stack overflow:** little stack is left to run a heavy dump call, so the
   minidump is deliberately skipped (attempting it just faults) and only the
   text report is written; native frames there are limited. Accepted limitation.

A `.dmp` is written to a `.part` sibling first and renamed only on success, so a
`hs_err_*.dmp` file always means a complete minidump. A leftover `hs_err_*.dmp.part`
means the dump was defeated mid-write by extreme heap corruption (tier 3) — the
paired `.log` still holds the exception line.

Removing tiers 3–4 would require an out-of-process dumper (a resident helper
that dumps the frozen target across process boundaries, immune to the target's
heap and stack). That was evaluated and **not adopted**: the resident process,
IPC protocol, and packaging/lifecycle surface it adds are not justified by the
residual once the in-process minidump is in place. The in-process minidump is
the deliberate stopping point.

### Opening a `.dmp`

Use the release PDBs that this doc already requires (matched by PDB GUID + age):

```
cdb -z hs_err_pid1234_20260703_120000.dmp -y <pdb-path> -c "k; lm; q"
```

Visual Studio: open the `.dmp`, point the symbol path at the archived PDBs, then
"Debug with Native Only".

### Privacy

A minidump contains process memory (stacks, registers, module list).
`MiniDumpNormal` is used deliberately to stay small and avoid the full working
set, but still treat `.dmp` files as **private**: they live under a runtime
directory (never the repo), should not be attached to public issues, and should
be rotated like other crash logs. If richer dumps (`MiniDumpWithFullMemory`) are
ever needed, gate them behind an explicit opt-in — full memory captures the
entire working set and materially widens the privacy surface.
