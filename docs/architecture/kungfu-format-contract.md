# The `.kungfu` Format Contract

`.kungfu` is both a workspace data home and the intended boundary for portable
Kungfu evidence. Those two surfaces are at different maturity levels:

- the workspace root, layout inventory, persistence classes, and journal epoch
  have current machine-readable contracts;
- the complete runtime-independent semantic format is still pre-release and
  has no normative standalone specification.

This page is the human status and authority index. It composes the current
contracts; it does not replace their schemas, source declarations, ADRs, or
verification commands.

## What is authoritative now

| Surface | Current status | Authority | Verification |
| --- | --- | --- | --- |
| workspace and fallback root selection | implemented configuration contract | [Configuration](../guides/config.md) and [`kungfu-config.contract.json`](../../framework/core/config/kungfu-config.contract.json) | `kungfu config path --json` |
| workspace `.kungfu/` layout v1 and persistence classes | accepted decision; implementation staged | [Freeze workspace `.kungfu` home layout v1](../adr/KF-ADR-019f86da-4f90-713d-8626-d70bca82cb76.md) and the [typed C++ layout projection](../../framework/core/src/libkungfu/src/runtime/storage/layout.cpp) | `kungfu storage layout --json` and `kungfu storage layout --verify --json` |
| journal wire epoch used by layout v1 | declared and reader-enforced; implementation staged with the layout decision | [`layout_fingerprint.h`](../../framework/core/src/libyijinjing/include/kungfu/yijinjing/journal/layout_fingerprint.h) and the [retained fixture](../../framework/core/src/libyijinjing/tests/fixtures/journal-wire-v1.json) | native build and journal mmap tests |
| retained cross-version byte corpus | qualified v2; append-only releases and all seven compatibility axes | [`portable-format-vectors`](../../framework/spec/format/conformance/portable-format-vectors/index.json) | `./shifu check:portable-format-authority` |
| pre-stable v4 alpha baseline | `4.0.0-alpha.2` content-rooted successor; `alpha.1` retained immutably and incompatible in-place mutation rejected | [`v4-alpha/index.json`](../../framework/spec/format/compatibility/v4-alpha/index.json) | `./shifu check:portable-format-authority` |
| Fact and Episode meaning | current public semantic authority | [Fact, Episode, and Action Primitive Runtime](fact-episode-action-runtime.md), [Episode Object Model](../concepts/episode-object-model.md), and [Event Model](event-model.md) | source and qualification gates named by those documents |
| portable spec bundle manifest | generated and content-root qualified; standalone status remains pre-release | [`@kungfu-tech/spec`](../../framework/spec/README.md), its [`manifest.schema.json`](../../framework/spec/schema/manifest.schema.json), and [generated authority](../../framework/spec/generated/authority.json) | deterministic generation, full schema/root verification, clean install, and layer-format qualification |

The layout contract classifies every declared entry as `durable`, `ephemeral`,
or `cache`. Unknown durable candidates make
`kungfu storage layout --verify --json` fail closed. Layout v1 is additive-only:
renaming, removing, reclassifying, or changing the meaning of an existing path
requires layout v2, a migration and rollback path, retained fixtures, and an
explicit reader compatibility rule.

The declared journal epoch is `0xe3b24c8d` (`3820113037`). Current readers
refuse pages from a different epoch. This is a wire compatibility boundary
inside the workspace layout; it is not a complete portable semantic-format
version.

## Accepted composition authority and executable evolution protocol

The accepted
[portable-format authority decision](../adr/KF-ADR-019f96a2-c686-76e1-9261-f6106aa50429.md)
and its
[machine composition contract](../../framework/spec/format/kungfu-portable-format-authority.contract.json)
now define how the existing authorities relate. The contract keeps Fact,
Episode, journal, manifest, payload-schema, package, content-root, layout, and
Spec Bundle identities and version axes separate. It is a routing and
compatibility-ownership authority, not a mega-schema or a replacement for any
component contract.

The required-reader contract and the explicit
[migration-and-repair protocol](../../framework/spec/format/kungfu-format-migration.contract.json)
are executable. Compatibility is a tuple over journal epoch, workspace layout,
record and payload schemas, root protocols, bundle manifest, and capabilities;
package semver is not a substitute. Supported changes run only as explicit
cold-path edges, create receipt-bound successor identities, and retain source
evidence. Downgrade and unsupported edges refuse before authority changes.
Structural repair keeps damage evidence and cannot claim semantic recovery it
cannot prove.

The retained v2 conformance corpus keeps every v1 byte and appends eight exact
compatibility-tuple vectors. Its sixteen vectors cover journal epoch, workspace
layout, record schemas, payload schemas, root protocols, bundle manifest,
capabilities, malformed unknown axes, and all five required-reader outcomes.
Native yijinjing, the independent JavaScript oracle, and the stdlib-only Python
reader shipped inside `@kungfu-tech/spec` reproduce the applicable roots and
classifications.

The `v4-alpha` baseline binds the complete current tuple and exact roots of the
composition, required-reader, migration/repair, and retained-corpus
authorities. `4.0.0-alpha.2` records the identity-neutral KFX manifest
composition successor while retaining `alpha.1` immutably. Rewriting any bound
source under either release fails the gate. A
change must append a content-rooted successor baseline, bind its predecessor,
and enumerate every changed authority; this is a pre-stable alpha discipline,
not a stable-v4 compatibility promise.

The disposable migration campaign exercises preview, no-op, successful
successor admission, unsupported refusal before writes, injected interruption,
staging recovery, exact receipt retry, evidence-preserving repair, and semantic
repair refusal. It proves source preservation and deterministic receipts
without touching a user `.kungfu` workspace. Real user-workspace mutation
remains explicitly unimplemented.

The generated normative bundle is now qualified. It contains eight
content-addressed machine projections for composition authority, schema
registry, errors, capabilities, required-reader matrix, compatibility,
migration, and retained vectors. Every projection binds its exact owner source
roots, and the manifest binds all artifact roots into one canonical normative
root. Mutable build provenance is outside that root. The package's clean-install
CLI and Node API can inspect and recompute those roots without the monorepo.

The exact package-local site projection and all eleven renderable page models
are qualified through clean tarball installation. The standalone format remains
pre-release because the v4 alpha baseline has not been promoted to a stable
compatibility contract.

## Historical Spec 0.1 is not normative

The prose called **Spec 0.1** under `framework/spec/docs/format-spec.md` is a
retained historical input. The package moves it to the explicit
`history/spec-0.1-draft.md` route with status
`historical-non-normative`; the current `format_spec` route resolves to the
generated composition authority instead. The draft predates the
Episode-centered object model and must not be used to implement a reader or
claim compatibility. Its `spec_version: 0.1` is not the workspace layout
version and is not a stable format promise.

A stable portable format must still define and approve the post-alpha
compatibility window, promotion criteria, and real-workspace migration policy.
The executable readers, retained vectors, disposable migration/repair campaign,
generated Spec bundle, and exact site projection are now qualified.

Until those conditions are met, describe the current surface as:

> a machine-readable workspace layout and runtime evidence system with
> qualified `@kungfu-tech/spec@4.0.0-alpha.1` and
> `@kungfu-tech/site@4.0.0-alpha.1` package surfaces, not yet a stable
> standalone `.kungfu` format.

## Authority boundaries

`.kungfu/` and `.xinfa/` are separate:

- `.kungfu/` owns workspace Fact, Episode, runtime, payload, receipt, continuity,
  projection, cache, and process state;
- `.xinfa/` owns Git-published semantic declarations, routes, projection
  recipes, promoted manifests, and reviewed submissions.

Selected Git-provider artifacts may appear under `.kungfu/episodes/` or
`.kungfu/project-cuts/`. They do not turn live runtime storage into a Git
authority and do not move `.xinfa` declarations into `.kungfu/runtime/`.

## Git publication boundary

An Agent must not infer Git policy from persistence class and must never stage
the whole `.kungfu/` directory. The installed, version-matched machine contract
is `workspaceGit` in `kungfu agent map --json` and
`kungfu agent capabilities --json`. Its default is closed: a path enters Git
only when it matches a publication-allowlist row and satisfies that row's
selection rule. Publisher content must use the exact path it returns.

| Disposition | Exact workspace paths |
| --- | --- |
| publish after repository review | `.kungfu/.gitignore` |
| publish qualified sealed Episode shadows | `.kungfu/episodes/sealed/sha256/<2-hex>/<64-hex>/{claims.jsonl,manifest.json,qualification.json}` |
| publish settled Project Cuts | `.kungfu/project-cuts/sha256/<2-hex>/<64-hex>/{manifest.json,receipt.json}` |
| publish protected settlement batches | `.kungfu/ledger-publications/sha256/<2-hex>/<64-hex>/manifest.json` |
| always local | `.kungfu/{runtime,inbox,private,cache,locks,projections}/` and `.kungfu/episodes/.tmp/` |

Every unmatched path stays local unless the repository has an explicit policy
for it. This includes workspace identity, config, installed extensions,
datasets, backtests, backups, contracts, missions, and skills by default.
“Durable” means deletion may lose accepted state; it does not mean Git should
track that state. Kungfu itself does not stage, commit, or push any path.

Within `.kungfu/`, authority remains singular:

- append-only journals and admitted content are durable authority;
- projections and caches are rebuildable;
- locks, PIDs, sockets, and live ownership state are ephemeral;
- JSON is authoritative only where an explicit schema or contract says so.

## Reader and tool obligations

A tool that inspects or transfers `.kungfu` material should:

1. resolve the workspace or fallback root through the config contract;
2. inspect the declared layout and fail on unclassified durable candidates;
3. check the journal epoch before reading pages;
4. verify manifest, schema, and content roots before admission;
5. preserve unknown well-formed material unless an explicit migration owns it;
6. keep projections and caches subordinate to journal/content authority; and
7. report unsupported versions instead of guessing.

Migration and repair tools have additional obligations:

1. compare the complete compatibility tuple, not a package version;
2. reject reverse and undeclared graph edges before any write;
3. preserve the source root, exact source evidence, and damage observations;
4. create a successor root rather than relabeling an old root;
5. bind source and target protocols and roots in an operation receipt; and
6. reconcile outcome-unknown retries by operation id and exact request root.

Do not treat deleting `.kungfu/` as cache cleanup. The layout contains durable
workspace facts, payloads, receipts, configuration, trust material, and
continuity evidence.

## Maintainer gate

When this status changes, update the owning machine contract or ADR first, then
refresh this index and its Xinfa route. Run:

```sh
./shifu docs:check
./shifu check:portable-format-authority
./shifu qualify:portable-format-packages
./shifu adr:audit
./shifu adr:map:check
```

`docs:check` also rejects unlinked or unresolved ADR identities in authored
Markdown. Generated ADR navigation must be regenerated through its owner;
historical append-only records are not mechanically rewritten.
