# Assignment capture

`framework/work/assignment-capture` is the build-free, capture-only ingress for an
Assignment request. It accepts canonical JSON before Core is compiled, resolves
the same target order as `workspace.py`, and writes only durable material under
`.kungfu/inbox/assignment-requests/`.

```sh
./shifu assignment capture --request request.json --json
./shifu assignment cleanup --now 2026-08-01T00:00:00Z --json
./shifu assignment cleanup --now 2026-08-01T00:00:00Z --execute \
  --expected-plan-root sha256:<digest> --json
```

Capture does not admit an Initiative or Assignment, initialize a runtime, write
a journal, claim work, or infer Mission purpose. With no explicit, environment,
or discovered project workspace, it writes to `~/.kungfu` with
`association=unassigned`.

Expiry is explicit. A cleanup preview lists expired request roots and has a
content-addressed plan. Execution requires that exact plan root and writes an
expiry receipt that removes the request from the active inbox projection. The
request and all of its content-addressed capture receipts remain byte-for-byte
present; physical garbage collection is outside v1.
