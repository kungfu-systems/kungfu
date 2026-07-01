# Python handbook

> Pre-release (spec 0.1) · minimal recipe. The generated API reference (from
> Python introspection) is planned; this page shows the shape of use, not the
> full signature surface. Signatures below are illustrative until the generated
> reference lands — check the reference page for authoritative names.

Embed fact-ledger recording directly in a Python script. Installing the package
puts recording in-process — no service, no account, local-first.

## Install

```bash
pip install kungfu
```

## Import

```python
import kungfu
```

## Produce and read a record (shape of use)

The Python binding writes the same portable bundle described in the
[format spec](../../spec/): append events with their causal parent, then read
them back — in this process or any later one, with no runtime dependency.

```python
import kungfu

# open a ledger location (local-first; no account/network)
ledger = kungfu.ledger("./runs/session-1")

# append a fact, carrying its causal parent
e1 = ledger.append(kind="note", payload={"msg": "started"})
ledger.append(kind="note", payload={"msg": "step done"}, caused_by=e1)

# read the ordered, causal record back
for event in ledger.read():
    print(event.kind, event.payload)
```

The exact method names are being finalized against the real binding and will be
published in the generated reference. What is stable is the *shape*: open a
local ledger, append facts with a causal parent, read them back verifiably.

## Planned

- Generated API reference from Python introspection (authoritative signatures;
  drift = build fail).
- `--json` provenance emitting the authoritative `docs_url` for the installed
  version.
