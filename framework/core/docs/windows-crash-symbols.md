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
