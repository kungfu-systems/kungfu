# Zero-burden desktop runtime qualification

This gate is the final single-host composition check for the runtime activation,
live Peer continuity, durable Agent Session, and rebuildable frontend product
boundaries. It creates no new runtime authority. It verifies the retained reports
from the existing component qualifiers, executes the Agent Session and terminal
presentation suites, and emits one source- and platform-bound aggregate report.

## Alpha and release sequence

Every alpha and release Buildchain leg runs these stages in order:

1. source, native, sanitizer, and fuzz verification;
2. live Peer continuity qualification;
3. complete runtime activation and product-artifact qualification;
4. zero-burden desktop aggregation;
5. Linux Episode/ADR release admission where applicable; and
6. source-bound layer artifact Gates.

The aggregate stage is:

```sh
./shifu zero-burden:qualify -- \
  --retain product/release/qualification/zero-burden-desktop
```

It fails closed unless both component directories contain `report.json` beside
`raw-logs.jsonl.gz`, each report passes for the exact source revision and host
platform, and each report binds the adjacent raw bundle by SHA-256. It then runs
the complete Agent Session control-plane suite plus the terminal product
presentation suite. Their raw output is stored in the aggregate gzip bundle.

Buildchain uploads these three retained evidence pairs under
`product/release/qualification/`:

- `live-peer-continuity/{report.json,raw-logs.jsonl.gz}`;
- `runtime-activation/{report.json,raw-logs.jsonl.gz}`; and
- `zero-burden-desktop/{report.json,raw-logs.jsonl.gz}`.

A report without its adjacent bundle, a digest mismatch, a dirty source tree,
a source/platform mismatch, or any failed suite blocks the release leg.

## Supported claim

A passing aggregate report supports this narrow statement:

> On the named source revision and platform, the qualified single-host runtime
> preserved daemonless activation, bounded self-maintenance, live Peer control
> continuity, Agent Session recovery, rebuildable product-state presentation,
> and verified product artifacts under the recorded automated campaigns.

The report deliberately does not claim authenticated Codex or Claude provider
behavior from credential-free CI, interactive GUI pixels or window input from a
headless runner, physical reboot or power-loss continuity, cross-host HA, or a
packaged-product result for an operating system other than the report platform.
Authenticated provider dogfood and interactive desktop checks remain separately
retained product evidence and cannot be inferred from this gate.

## AI provenance

`ai_provenance`: this contract was drafted by the visible GPT-5 model family
through Codex on 2026-07-14 from the executable runtime, live Peer, Agent Session,
frontend, and Buildchain contracts. The model had no invisible evidence for
unexecuted physical-host or interactive-device scenarios; those remain explicit
non-claims.
