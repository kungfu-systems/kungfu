# KFD Agent Hub 20 installed-product qualification

Kungfu Work owns a local-peer implementation of the experimental KFD Agent Hub
profile. The black-box adapter is intentionally thin: every JSONL request is
forwarded to `kungfu agent hub handle`, and the installed product owns
capability negotiation, transport receipt separation, idempotency, Warrant
attenuation and revocation, conflict visibility, progressive disclosure,
completion assessment, recovery, and export/import observations.

The fixed input is `@kungfu-tech/kfd@1.0.0-alpha.46`. The package, profile,
protocol, Hub 20 vector registry, failure inventory, and verifier roots are
frozen in
[`kfd-lock.json`](../../tests/qualification/agent-hub-20/kfd-lock.json).
[`responsibility-map.json`](../../tests/qualification/agent-hub-20/responsibility-map.json)
maps every vector to its Kungfu authority owner and product evidence.

## Run

Build and promote a pristine local product candidate before qualification. The
qualifier refuses an existing output directory, runs offline against two
distinct disposable Hub homes, snapshots metadata-only state for the real
`~/.kungfu`, invokes the exact KFD runner, and binds the result to the installed
product:

```sh
./shifu kfd:agent-hub:qualify \
  --kungfu /usr/local/bin/kungfu \
  --output-dir /new/path/kfd-agent-hub-20
```

Verify the retained result and current installed artifact:

```sh
./shifu kfd:agent-hub:verify \
  --kungfu /usr/local/bin/kungfu \
  --qualification-dir /path/to/kfd-agent-hub-20
```

The release gate fails closed on stale KFD roots, adapter bytes, installed
product identity, source provenance, report closure, isolation evidence, an
incomplete or non-20/20 result, offline verifier failure, or a widened claim.

## Evidence and claim boundary

The first full baseline is retained append-only at
[`first-baseline.json`](../../tests/qualification/agent-hub-20/evidence/first-baseline.json).
It records `0/20` against the preceding installed product because that product
did not expose `kungfu agent hub handle`; it also records all 21 requests,
transcript and result roots, exact KFD roots, adapter digest, installed product
identity, and unchanged metadata-only real-home snapshots.

The passing retained result is
[`installed-macos-arm64-ff8f5e27f/qualification.json`](../../tests/qualification/agent-hub-20/evidence/installed-macos-arm64-ff8f5e27f/qualification.json).
It binds pristine installed source commit
`ff8f5e27f85fcdb23dc1f7d7ac6a3011d586d9fd`, KFD
`1.0.0-alpha.46`, adapter digest
`sha256:70a53630b9f9df9e11727740b142a956fe5389dfbb14ae2ecd7504f3564fd4a2`,
and report digest
`sha256:937d157559f2035fe7aed4fc18ac6890ebb8f4238dc69d8b9fe6398ad8f81110`.
All 20 vectors pass, the official offline verifier reports valid, the two Hub
homes are distinct, and the real-home metadata root is unchanged.

A passing retained qualification proves only the named installed Kungfu macOS
arm64 artifact, thin adapter, exact KFD alpha package, two isolated local-peer
authority domains, and recorded execution. It is not KFD certification,
external adoption, production fitness, network interoperability, stable/public
release evidence, or evidence for another platform.
