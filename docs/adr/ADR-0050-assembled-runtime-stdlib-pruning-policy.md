---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0050
decision_status: accepted
implementation_status: unknown
review_state: legacy-unreviewed
sensitivity: public
---

# ADR-0050: Stdlib pruning policy for the assembled runtime

- Status: accepted
- Date: 2026-07-11
- Category: distribution — product image content policy
- Subsystem: the assembled runtime distribution (the `assemble` leg of
  `framework/core/.gyp/run-freeze.js`, the interpreter tree under
  `dist/kungfu/python`)
- Related: [ADR-0046](ADR-0046-rust-host-trunk-and-assembled-runtime.md)
  (stage 2 requires this policy "decided here, in its own record"; this is
  that record)

## Question

The assembled distribution ships a complete python-build-standalone prefix
instead of a frozen subset. Complete is the point — but the full prefix
carries families the product has no path to (tk GUIs, an in-tree pip, C
headers). What may be removed from the shipped tree, by what mechanism, and
under what maintenance discipline — given that the freezer's hand-maintained
`nofollow-import` exclusion surface is precisely the disease ADR-0046 stage 2
retires, and this policy must not grow back into it?

## Drivers

1. **The nofollow disease, named.** The frozen leg's exclusion list grows
   with development activity — every new Python dependency can demand a new
   entry — and a miss fails at runtime in the field (missing module) or
   silently bloats the binary. Any pruning policy whose maintenance scales
   with dependency count, or whose failure mode is a field incident,
   recreates what this stage exists to retire.
2. **The install-surface contract.** The tree ships with pip inside it
   otherwise: a resolvable `python -m pip` inside the product tree is a
   standing silent bypass of the kungfu-owned install surface —
   ADR-0046 violation criterion 5 in shipped form.
3. **Size is secondary, not zero.** Measured on macOS arm64 (CPython
   3.13.14 install_only prefix): full tree 68M, pruned 56M. Worth taking
   when the mechanism is sound; never worth a maintenance surface that
   grows.

## Decision

### 1. Family-level subtraction only

The policy removes **whole families that have no intersection with product
semantics**, never individual modules chased along an import graph. First
fill (the manifest is the authority; this list is its rationale):

- the tcl/tk family — `tkinter`, `idlelib`, `turtle`, the tcl/tk runtime
  libraries (no kungfu path opens a tk window);
- `pip` + `ensurepip` — a contract action as much as a size one: removing
  the in-tree pip closes the silent-bypass door, leaving uv as the only
  install engine (the tree's `EXTERNALLY-MANAGED` marker refuses a stray
  host-python pip even before this — pruning removes the engine itself);
- C headers (`include/`) and `bin/` auxiliaries (`idle3`, `pip3`,
  `pydoc3`, `python3-config`) — build-time surfaces, not runtime ones.

The subtraction is from a **fixed** stdlib: new product dependencies land in
site-packages and never interact with this list. The manifest does not grow
with development activity, by construction.

### 2. Declarative manifest, fail-closed on staleness

The policy lives in `product/stdlib-prune.json`
(schema `kungfu.stdlib-prune/v1`): prefix-relative paths under a `common`
section plus per-platform sections, `*` globs covering version-suffixed
names. The assemble leg enforces two properties at build time:

- **an entry that matches nothing stops the build** — the manifest must
  describe the tree it prunes, so pbs layout drift surfaces at build time,
  not as silent shipping of a family believed pruned;
- **an entry that escapes the tree root stops the build**.

An absent manifest means the full tree ships — the mechanism defaults to
completeness, not to pruning.

### 3. Failure direction: fail-safe

The two lists fail in opposite directions, and this is the load-bearing
difference rather than a nicety: a missed `nofollow` entry ships a broken
runtime to the field; a missed prune entry ships a few extra megabytes. A
*wrong* prune entry (a family the product actually needs) is caught where
everything else is: `verify --full` dogfoods the assembled tree through the
real probe chain, and the wrong-runtime guard plus product smoke run on the
pruned tree, not the full one.

### 4. Maintenance discipline

A manifest change is one data edit plus the build's own assertions — no
code. Adding a family requires the same argument this record makes for the
first fill: the family must be semantically disjoint from the product, not
merely unused today. Per-platform sections carry platform layout differences
(the macOS section holds the tcl/tk runtime library paths of the darwin
prefix); a platform leg landing later (Linux, Windows) extends its own
section against its own tree, gated by the same fail-closed assertions.

## Alternatives considered

- **No pruning (ship the full 68M prefix).** Zero manifest, zero mechanism —
  legitimate if the ~12M and the list are judged not worth each other. It
  loses the contract action, though: the in-tree pip stays a resolvable
  bypass engine. Rejected for the pip door more than for the megabytes.
- **Import-graph pruning (cut the 24M stdlib to the observed closure).**
  Recreates the nofollow disease exactly: the list grows with code, a miss
  fails at runtime in the field. Rejected against this record's own driver 1;
  taking it would be self-refuting.

## Consequences

- The macOS assembled tree ships 56M instead of 68M; net dist growth against
  the retired frozen form stays where ADR-0046 accounted it.
- `import tkinter` and `python -m pip` inside the product tree fail by
  construction — the first is out-of-scope surface, the second is the
  install-surface contract holding by mechanism.
- pbs layout drift (a renamed tcl directory, a repathed pip) breaks the
  assemble build loudly at the manifest assertion, which is the designed
  place to notice it.

## Violation criteria

Record against this ADR any change that:

1. adds a prune entry to chase an individual module or to resolve a
   dependency conflict (import-graph creep — the disease returning);
2. makes pruning a step that must be revisited when a Python dependency is
   added (maintenance coupling to development activity);
3. weakens the fail-closed assertions (a non-matching entry that warns
   instead of stopping the build);
4. restores an install engine inside the product tree, or removes the
   `EXTERNALLY-MANAGED` refusal, without an explicit named bypass decision.
