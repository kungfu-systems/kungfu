# Generated artifact welding

Kungfu treats a generated projection as current only when its exact bytes and
the complete executable generator closure match their declared roots. Moving
common code into a helper does not make that helper an implementation detail:
every imported generator helper that can change output semantics belongs in the
closure.

## Shared generator API

[`scripts/lib/sdk-generator.mjs`](../../scripts/lib/sdk-generator.mjs) provides
the common loading, canonical-root, output-root, generator-closure, and
write-or-check operations. A generator that imports the helper must:

1. persist its own path and root;
2. persist `scripts/lib/sdk-generator.mjs` in `dependencies`;
3. persist every generated output path and root;
4. call `verifyGeneratorClosure` and `writeOrCheckOutputs` in check mode; and
5. retain a negative test that mutates the shared helper and observes failure.

The Work lifecycle native contract is the reference consumer. The layered SDK
contract uses the same closure rule. A primitive catalog generator can adopt
the API without changing its domain schema:

```js
import {
  generatorClosure,
  loadJson,
  verifyGeneratorClosure,
  writeOrCheckOutputs,
} from './lib/sdk-generator.mjs';
```

`generatorClosure(root, generatorPath, dependencies)` returns the root-bearing
record to persist. `verifyGeneratorClosure` validates both the entry generator
and every declared dependency. `writeOrCheckOutputs` preserves the existing
fail-closed byte comparison.

## Registry envelope

`kungfu.registry-envelope/v1` adds generic welding around a domain registry; it
does not replace or flatten the registry's item schema. Each envelope declares:

- the authoritative framework registry and its registry-specific JSON Schema;
- `entriesPointer`, which selects the domain item array;
- `uniqueFields`, whose fields are each independently unique across all items;
  it is not a composite tuple constraint; and
- root-bound framework-to-config projections.

`./shifu registry:generate` refreshes declared projection copies and roots.
`./shifu registry:check` validates the envelope, validates the domain
registry with its own schema, rejects identity duplication, and rejects missing,
mutated, or stale projections.

Generation validates the complete registry and projection plan before opening
any output. It stages every target beside its destination, atomically renames
each artifact, and publishes the envelope last as the commit marker. A rejected
schema, identity, path, or root therefore leaves both artifact and envelope
bytes unchanged.

The contract and invariant registries are the first consumers. The Work
lifecycle operation matrix is also declared as a generated config projection,
leaving the framework matrix as its sole authority.
