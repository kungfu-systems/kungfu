# GUI capability-boundary qualification

This contract closes the product gate for
[ADR-0083](../adr/ADR-0083-core-system-kfx-profile-kfx-capability-boundary.md).
It tests the boundary as one installed product rather than treating the four
migration stages as sufficient proof in isolation.

## Required evidence

The exact candidate must be clean and must pass all of these checks:

1. the complete source acceptance gate, including Shell neutrality, generic
   Profile operations, domain-local Query/ViewSpec ownership, Core WorkConsole
   authority, compatibility fixtures, and packaging tests;
2. a Product distribution build whose bundle audit resolves every external
   main-process dependency and restores executable native helpers;
3. a qualification-mode cold start reaching `KF_GUI_QUALIFICATION_READY`;
4. an authenticated packaged Codex structured-transport run covering start,
   output observation, approval denial, interrupt, main restart/reattach, and
   provider-end input closure;
5. promotion through the Shifu artifact catalog, followed by an installed
   Electron main/renderer check and preservation of pre-existing detached
   session containers.

The retained [evidence index](evidence/gui-capability-boundary/611e39d82/README.md)
and its machine-readable
[`report.json`](evidence/gui-capability-boundary/611e39d82/report.json) bind the
result to the exact candidate.

## Claim boundary

Passing this contract proves the ADR-0083 ownership migration and packaged
product closure on the named macOS arm64 candidate. It does not prove Linux or
Windows packaging, physical machine restart recovery, interactive pixel
correctness, every provider transport, or the completion of work represented by
a successful terminal process. Raw terminal content and private environment
values must not be retained as evidence.
