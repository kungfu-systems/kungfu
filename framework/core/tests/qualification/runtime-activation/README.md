# Runtime activation qualification

This harness binds KF-ADR-019f86da-4f90-7bc8-a3ed-a7b0a6363d6c Stage 7 to source-exact, retained machine evidence.
It composes the existing broker/service, Profile action, surface parity,
distribution, full verification, and local artifact-catalog checks. It does not
replace any lower authority or reinterpret a passing process-crash test as a
power-loss result.

Plan without building or writing product state:

    ./shifu runtime:qualify -- --mode dry-run

Execute the complete current-platform qualification, including distribution
and full product verification:

    ./shifu runtime:qualify -- --mode execute --with-product

Reports and raw logs default to
`.buildchain/runtime/qualification/runtime-activation/<run-id>/`. This ignored
runtime area survives Core distribution cleanup. An execute
run is `passed` only from a clean source tree when all Core and product suites
pass. Omitting product suites is intentionally `unqualified`.

The report can support only the named current-platform/process envelope. It
does not claim a production EmbeddedRuntimeHost, distributed leases or HA,
physical-host power-loss coverage, default-on candidate durability profiles,
or a universal activation latency SLO. A published readiness descriptor is
still only discovery coordinates; product consumers re-run the native
durability/projection authorities before admitting an operation.
