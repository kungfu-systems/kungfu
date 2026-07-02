# libkungfu

**An open, portable format for fact ledgers — and the agent-facing surface for
working with them.**

libkungfu is the open standard behind kungfu's runtime fact ledger: an ordered,
append-only, causally-linked record of events that can be opened and verified
**without the runtime that produced it, and without any particular library**.
The format is the product. Reference libraries are a convenience, not a
requirement and not a trust root — anyone can write a conforming reader from the
spec alone.

Born in a production, low-latency trading core, its first-class use today is
giving **agent runtimes** a record they cannot misreport: what an agent read,
called, and decided, captured as facts you can replay and verify.

> **Pre-release (spec 0.1).** This surface is a working draft. The format may
> change without compatibility guarantees until 1.0.

## Start here

- **[Format spec](spec/)** — what a bundle is: the guarantees, the four-part
  anatomy, how it stays verifiable and portable.
- **Handbooks** — get an agent working against kungfu, per runtime:
  - **[kungfu (CLI)](handbooks/cli/)** — produce and inspect ledgers from the
    command line with `kungfu`.
  - **[Python](handbooks/python/)** — embed recording in a Python script.
  - **[Node](handbooks/node/)** — embed recording in a Node/TypeScript script.
- **Reference** — machine-addressable data: schema registry, error dictionary,
  capabilities, conformance vectors and map. (Growing; see each page.)

## Why a format, not a library

The hard value — open five years from now, verify on another machine, trust the
bytes without trusting a vendor — lives in the *format*, not in any language
binding. libkungfu is designed format-first: the write API, read API, CLI, and
tools are all producers and consumers of one specified, versioned artifact.
