# Project Cut protocol contract

`framework/project-cut` is the build-free, content-addressed protocol layer that
binds one declared source projection, one Xinfa Atlas, and an admitted Kungfu
Episode delta. It implements [ADR-0097](../../docs/adr/ADR-0097-project-cut-spacetime-and-publication-boundary.md)
and [ADR-0098](../../docs/adr/ADR-0098-project-cut-v1-canonical-root-and-source-projection.md).

The layer owns no source, Atlas, Episode, Mission, Go, or Git authority. It
validates references to those authorities and computes four deliberately
separate identities:

- `cutRoot`: SHA-256 of the canonical `project.cut.root-input/v1` semantic
  preimage, excluding `cutRoot`, receipts, publication coordinates, and the
  containing Git commit OID;
- `serializationRoot`: SHA-256 of canonical `project.cut/v1` JSON, including
  `cutRoot`;
- `artifactDigest`: SHA-256 of the exact artifact bytes that were inspected;
  and
- `receiptRoot`: SHA-256 of the receipt preimage.

`sha256-project-cut-canonical-json-v1` hashes canonical JSON without a trailing
newline. Canonical JSON sorts object keys by UTF-8 bytes, preserves
schema-declared array order, admits valid NFC strings only, and admits
non-negative safe integers only. Set-like arrays must already be UTF-8 byte
sorted and unique; the verifier rejects ambiguous input rather than silently
repairing it. Exact artifact bytes are hashed separately and may include a
presentation newline.

The source projection policy permits declared `.xinfa` and `.kungfu` authority
inputs but rejects Git internals, runtime/cache/index/generated state, private
raw payloads, and `.kungfu/project-cuts` protocol output. Paths are NFC POSIX
relative paths. This prevents a generated Project Cut from feeding its own
source root without broadly hiding user-declared authority material.

The zero-dependency API is in [`src/project-cut.mjs`](src/project-cut.mjs):

```js
import {
  buildProjectCut,
  buildSourceProjection,
  createProjectCutReceipt,
  verifyProjectCut,
  verifyProjectCutReceipt,
  verifySourceProjection,
} from './framework/project-cut/src/project-cut.mjs';
```

Run the contract, schema bundle, golden roots, receipt, and negative fixtures:

```sh
node scripts/check-project-cut-contract.mjs
node --test scripts/check-project-cut-contract.test.mjs
./shifu check:source
```

This stage does not walk a Git tree, write `.kungfu`, seal an Episode, compile
an Atlas, create a Git hook, or publish a commit. Providers and the settlement
CLI consume this contract in later stages. Optional JSON Schema validation runs
when repository dependencies are present; the semantic/root verifier itself
uses only Node built-ins and remains available for stage-0 recovery.
