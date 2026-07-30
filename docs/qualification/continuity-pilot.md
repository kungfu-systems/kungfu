# Continuity Pilot v1

The continuity pilot exercises one narrow promise: **Keep the work when the
chat ends.** It exists to prove the fixture, reset, report, public projection,
and animation-input chain before a feature-complete release is eligible for a
matched long-task comparison.

This is preparatory evidence. It does not qualify FO10, compare model or
provider performance, prove production durability, or support a market-leading
claim.

## Bounded method

The v1 fixture contains one tiny inventory repository and one exact output
oracle. Both paths receive the same task, initial tree, deterministic worker,
worker version, configuration, attempt budget, and oracle.

1. Materialize the disposable initial tree.
2. Inspect the inventory.
3. On the Kungfu path, write one public durable continuation fact. The baseline
   path receives no continuation mechanism.
4. Start a fresh deterministic worker invocation. Neither path receives a
   transcript or reads a private provider session store.
5. Continue only from admitted post-reset input, evaluate the exact oracle, and
   emit separate reports.

The pilot has a hard 60-second wall-time budget and one attempt per path. The
worker is fixture code, not a hosted or native model agent. Consequently, a
Kungfu-path pass proves that the evidence pipeline can carry a durable fact
across the reset boundary; it does not prove that an actual agent product will
recover a long task.

Run the disposable pipeline with:

```bash
./shifu qualify:continuity-pilot -- --output /tmp/kungfu-continuity-pilot
```

Run its positive and fail-closed cases with:

```bash
./shifu test:continuity-pilot
```

The negative cases reject hidden transcript injection, different task trees,
missing baseline identity, missing oracle evidence, fabricated public metrics,
and a smoke report relabeled as FO10.

## Evidence products

The runner emits:

- `baseline-report.json` and `kungfu-report.json`, including run identity,
  source roots, task and tree roots, provider configuration, reset boundary,
  wall time, tool calls, human re-explanation, duplicate work, oracle result,
  citations, limitations, evidence class, and verdict;
- `raw-evidence-index.json` over the reports and ordered event streams;
- `public-projection.json`, which contains only public-safe observed values and
  exact input roots; and
- `animation-pack.json`, which binds a 32-second storyboard, timing, data
  selectors, redaction rules, desktop/mobile framing, static fallback, and a
  `How this was tested` payload to the projection root.

The retained v1 pilot keeps the
[public-safe projection](evidence/continuity-pilot/2026-07-21-preparatory-v1/public-projection.json),
[raw evidence index](evidence/continuity-pilot/2026-07-21-preparatory-v1/raw-evidence-index.json),
and [animation production pack](evidence/continuity-pilot/2026-07-21-preparatory-v1/animation-pack.json)
together under one run identity. Its baseline verdict is `unsupported`; the
Kungfu fixture path passes the exact oracle from one durable fact. Both remain
explicitly preparatory.

Animation production must read the projection rather than substitute hand-made
numbers. If the projection is missing or invalid, production falls back to the
static truthful statement in the pack. Design annotations remain visibly
separate from observed evidence.

## Extension to the matched long-task comparison

The future comparison replaces the fixture duration and deterministic worker
with the exact release candidate and latest available native Agent baseline.
It retains the same task/tree identity, provider/agent/version/config binding,
fresh-context rule, oracle, raw-report separation, limitations, and independent
review boundary. That future run is the place to evaluate FO10 or publish a
comparative outcome; this pilot deliberately does neither.

The machine contract is
[`kungfu-continuity-pilot.contract.json`](../../framework/agent-work/kungfu-continuity-pilot.contract.json).
