# Runtime surface provenance

Kungfu distinguishes *what work means* from *which concrete runtime performs an
operation*. The Runtime Surface Contract is the single machine-readable authority
for that second question. It prevents an installed product, a source checkout, or
a composed boundary from silently substituting for another.

The frozen contract is shipped as
`config/kungfu-runtime-surface.contract.json`; its source is
`framework/core/runtime/kungfu-runtime-surface.contract.json`. KFD-1 contract audit
requires the two files to remain byte-for-byte equal.

## Surface classes

- `installed-product` uses one exact qualified product executable and packaged
  artifacts. It carries no source-worktree coordinates.
- `source-checkout` uses `shifu` at one exact Git commit, tree, and worktree. A
  product executable cannot satisfy source build or source test.
- `hybrid-boundary` composes independently rooted product, bundle, source, or
  context evidence without transferring their authority to the composition.
- `capability-negotiated` is a selection mode, not a concrete execution surface.
  Contract provider preference makes its result deterministic.

The contract currently governs Assignment capture and seal verification,
source build and test, Portable Atlas Bundle consumption, dogfood capture, and
context consumption. Each operation declares its owner, capabilities, allowed
surfaces, provider preference, and fallback rule.

## Rooted receipts

Every accepted request produces a `kungfu.runtime-surface-receipt/v1`. The
receipt records the selected surface and provider, executable path/digest/version,
source commit/tree/worktree, bundle root, Assignment and Work roots, capabilities,
qualification evidence, and the complete fallback decision. Its `receiptRoot`
binds the canonical receipt body. Verification rejects tampering, contract drift,
unknown capabilities, unqualified evidence, contradictory coordinates, and
unauthorized fallback.

Inspect the authority and operate on explicit JSON files:

```sh
kungfu runtime surface contract --json
kungfu runtime surface resolve request.json --json > receipt.json
kungfu runtime surface verify receipt.json --json
```

The verify command is declared as a public Agent API and returns the same rooted
observation used by human tooling. Dogfood requires the complete receipt and
authority verification rather than accepting a root-shaped string. The TUI
diagnostic accepts `--runtime-surface-receipt`, invokes the same verifier, and
exposes only the matching verified observation; it does not select another runtime.
If its packaged CLI is unavailable, it fails closed unless `KUNGFU_CLI_BIN`
names an exact installed command or `KUNGFU_TUI_SOURCE_CLI=1` explicitly requests
source operation.

The six-row closeout qualifier does not synthesize consumer success from resolver
calls. Every row requires a content-rooted
`kungfu.runtime-surface-consumer-evidence/v1` object containing the full receipts
emitted around the real Assignment, Shifu, Portable Bundle, Dogfood, Atlas/Xinfa,
seal, and TUI probes. The qualifier re-verifies those receipts against the exact
source and assembled product coordinates. Publish the report and its consumer
evidence with the reviewed head so another reviewer can recompute every root.

## Migration boundary

Callers must stop using path presence, repository discovery, or a failed product
probe as permission to switch surfaces. They submit candidates to the shared
resolver and retain the returned receipt root. A fallback is valid only when the
operation contract permits the target, the request explicitly authorizes it with
a reason, and the selected candidate carries qualified evidence.

This contract does not acquire source, install a product, launch a worker, mutate
system configuration, publish a release, or upgrade local evidence into universal
cross-platform qualification. `shifu source` remains the source acquisition
authority; Buildchain remains the delivery and publication-attestation authority.
