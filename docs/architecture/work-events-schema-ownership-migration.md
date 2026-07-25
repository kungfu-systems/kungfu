# Work Events Schema Ownership Qualified Cutover

Assignment `2026-07-24-kungfu-work-native-admission` moved the exact
`work_events` declaration and compiled derivative to the admitted native Work
journal boundary:

```text
framework/core/src/libkungfu/schemas/work_events.fbs
framework/core/src/libkungfu/schemas/work_events.bfbs
```

`framework/core/schema-authority.json` registers those paths as
`kungfu.work.events`. The owner move changed paths and authority only:

```text
FBS  sha256:c2b894a743bd21bfd9dae38f923c8b6999971541e24700838677d5e5c9d1bdbe
BFBS sha256:16cc045eaa756670eeb9481d8027b94fadd5e5415477d3dcf68855ce08b4cb77
```

Python retains generated FlatBuffers accessors as the declared compatibility
reader. It no longer carries a tracked FBS/BFBS declaration or a persistent
writer.

## Qualified gates

1. `tests/fixtures/native-admission/work-journal-v1.json` freezes all eight
   payloads, ActionEnvelopes, length-delimited Root preimages, and Roots.
2. Native C++ and independent Python replay reproduce every byte and Root.
3. The Python compatibility fold replays frames written by the native service.
4. `kungfu_get_api` → `KF_INTERFACE_RUNTIME_ACTION` v1 reaches the Work journal
   service without adding a bootstrap symbol, interface ID, or ABI version.
5. `WorkStore` sends semantic fields to the native service and has no direct
   recorder or fallback writer.
6. The shared native-admission runner executes C ABI, KFX, Python, public API,
   schema-authority, incubation-passport, and no-rewrite gates fail closed.

## Forbidden shortcuts

This cutover did not rewrite a journal, alter a historical payload or envelope,
alias an identity, or copy records into another persistence plane. The new
`kungfu.work.record-root/v1` is an additive, length-delimited Root over exact
existing ActionEnvelope bytes; it can be calculated for old frames without
changing them and is distinct from Work portable JSON Roots.
