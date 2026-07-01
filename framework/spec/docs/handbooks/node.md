# Node handbook

> Pre-release (spec 0.1) · minimal recipe. The generated API reference (from the
> TypeScript types) is planned; signatures below are illustrative until it lands
> — check the reference page for authoritative names.

Embed fact-ledger recording in a Node or TypeScript script. Local-first,
in-process, no account or network.

## Install

```bash
pnpm add @kungfu-tech/api
```

## Import

```js
const kungfu = require('@kungfu-tech/api');
```

```ts
import * as kungfu from '@kungfu-tech/api';
```

## Produce and read a record (shape of use)

The Node binding writes the same portable bundle described in the
[format spec](../../spec/): append events with their causal parent, then read
them back with no runtime dependency.

```js
const kungfu = require('@kungfu-tech/api');

// open a ledger location (local-first; no account/network)
const ledger = kungfu.ledger('./runs/session-1');

// append a fact, carrying its causal parent
const e1 = ledger.append({ kind: 'note', payload: { msg: 'started' } });
ledger.append({ kind: 'note', payload: { msg: 'step done' }, causedBy: e1 });

// read the ordered, causal record back
for (const event of ledger.read()) {
  console.log(event.kind, event.payload);
}
```

The exact method names are being finalized against the real binding and will be
published in the generated reference. What is stable is the *shape*: open a local
ledger, append facts with a causal parent, read them back verifiably.

## Planned

- Generated API reference from the TypeScript types (authoritative signatures;
  drift = build fail).
- `--json` provenance emitting the authoritative `docs_url` for the installed
  version.
