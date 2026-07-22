# Upgrade Kungfu without interrupting current work

Kungfu separates three events that traditional installers often blur together:

1. a distribution adapter downloads and verifies release bytes;
2. those bytes are installed beside existing runtime and product images; and
3. Core decides when a workspace may use the new runtime.

Downloading or installing an update never grants it live authority. Existing work
keeps the exact runtime bytes it already owns until Core produces a compatible plan,
stages a new generation, and accepts semantic readiness.

> **Pre-release boundary:** the shared Core contract and explicit archive CLI are
> implemented in the v4 source line. Desktop transport wiring, official signed
> update channels, native package-manager artifacts, and cross-platform release
> qualification are still staged. A build without qualified publication evidence
> must not offer the update as releasable.

Before relying on a version-to-version data claim, read
[Exit, Migration, and Version Compatibility](exit-and-version-compatibility.md)
and inspect the policy shipped with the candidate using
`kungfu exit verify --info --json`. Product SemVer does not replace explicit
schema, protocol, artifact, and platform evidence.

## Read update status

Use the product-level status first:

```console
kungfu update status
kungfu update status --json
```

The human view identifies the frontend version, install source, selected workspace
runtime, installed runtime count, and the fact that there is no background updater
daemon. The JSON view adds stable fields for automation, including
`installSource`, `workspaceId`, `selectedRuntime`, and `installedRuntimes`.

For advanced runtime inventory diagnostics:

```console
kungfu runtime upgrade inventory --json
```

Normal update messages do not expose supervisor, coordinator, PID, socket, or
service controls. Those details remain in advanced runtime diagnostics.

## Know who owns the frontend update

Kungfu detects the install source before it offers an action:

| Install source | Frontend authority | Product behavior |
| --- | --- | --- |
| Desktop app | desktop updater | the app may stage an eligible installer; Core still owns runtime activation |
| Desktop companion CLI | desktop updater | reports the app-owned action; never installs a competing standalone frontend |
| Standalone archive | archive updater | may download a verified archive and install a versioned CLI image beside the current one |
| Homebrew, WinGet, deb, or rpm | package manager | never overwrites manager-owned files; shows only the exact command embedded by that package |
| Native installer | external installer | links to the release instructions; does not guess an installer command |
| Unknown | user | fails closed to an external install action |

Kungfu does not currently publish official Homebrew, WinGet, deb, or rpm channels.
Until a package embeds its exact `managerCommand` in `product.json`, the CLI shows no
invented package name and directs the user to this guide.

## Check and plan an update

Given a release manifest URL or local file:

```console
kungfu update check <release-manifest>
kungfu update plan <release-manifest> --json
```

Every standalone CLI release path (`check`, `plan`, `download`, and `apply`)
validates the platform and architecture before it can create a download target,
extract an archive, or write an inventory. `check` also validates the publication
qualification reference, artifact evidence fields, and secure transport
requirements. `plan` adds Core's current workspace decision and a `message` object.
That object always answers:

- what happened;
- whether current work continues;
- when the new runtime takes effect;
- whether one user action is required; and
- what happens to workspace data and session facts.

Treat the release manifest as evidence, not as a version string. The current
pre-release adapter verifies archive size and SHA-256 against that manifest and
requires non-placeholder signing evidence. Client-side cryptographic verification
of that evidence is not yet a qualified release claim; official publication must
remain closed until the release gate supplies that proof.

The release gate separately requires retained native-packaged qualification evidence
whose source, product, platform, architecture, artifact digest, size, and signing
reference match the manifest. Its Ed25519 statement verification, message/manual
checks, and at least 128 runtime-generation churn iterations must all pass. Source
fixtures prove the verifier fails closed, but do not promote any current platform to
a supported signed update channel.

For publication, every platform payload must carry the retained record at
`product/release/qualification/kungfu-upgrade-qualification-evidence.json`.
Buildchain promotion rechecks that record against the RC passport, the external
manifest, and the exact Desktop and CLI bytes before it can write publish evidence.

## Download and install without interrupting work

Archive download is dry-run first:

```console
kungfu update download <release-manifest> --json
```

The response contains a `planId`. Execute only that unchanged plan:

```console
kungfu update download <release-manifest> \
  --execute --expected-plan-id <plan-id> --json
```

Downloads use a partial file, support HTTPS range resume, and serialize concurrent
writers in one process and across host processes. The lock is keyed by the canonical
cache target rather than by plan ID, so two differing plans cannot write the same
partial file concurrently. Every redirect target and the resolved response must
remain HTTPS.
A resumed response must begin at the exact cached byte offset and declare the
manifest's total size. Streaming stops as soon as bytes exceed that size, and exact
size plus SHA-256 are verified before the final atomic rename. An incomplete partial
file is retained for an exact range resume. An oversized partial file is discarded
before a full restart, while a complete file with the wrong SHA-256 is discarded so
the next attempt can fetch clean bytes without manual cache cleanup. A stale plan,
changed target, symbolic-link target, unsafe redirect, mismatched range, size or
digest mismatch, or I/O failure cannot become an installed image.

Concurrent archive applies may install multiple immutable CLI images, but they
publish the current CLI selection through one process- and host-wide lock. Selection
is monotonic by product SemVer: a slower older plan cannot replace a newer completed
selection, and one product version cannot name different image evidence.

Applying an archive is also explicit:

```console
kungfu update apply <release-manifest.json> <archive> \
  --expected-digest sha256:<digest>
kungfu update apply <release-manifest.json> <archive> \
  --expected-digest sha256:<digest> --execute --json
```

The first command previews the operation. Before either path succeeds, direct apply
rechecks the archive's exact byte size and SHA-256 against the manifest and the
caller's expected digest. Execute then copies the candidate into an isolated staging
snapshot, rechecks that snapshot's size and digest, and extracts only those exact
bytes. Preview and execute also reject archives with more than 100,000 entries or an
expanded size beyond the bounded budget: at most 200 times the archive size, with a
64 MiB floor and an 8 GiB absolute ceiling. The second extracts only safe regular
files and directories, verifies that the archive and bundled manifest describe the
same release, and publishes two versioned inventories under the user config home.
Both paths independently recheck publication qualification and signing-evidence
references before any extraction, so direct `apply` cannot bypass the release gate:

- the shared immutable Core runtime image; and
- the standalone CLI product image.

The running CLI process is never overwritten. Its stable bootstrap selects the new
CLI image on the next command. A desktop companion CLI does not read this standalone
selection.

## Downgrades require a recovery decision

Normal update commands never install a product version older than the running
frontend. The CLI compares SemVer precedence before it creates a download target or
extracts an archive, and the Desktop updater keeps downgrade transport disabled. A
lower version therefore returns `downgrade-refused`, leaves current work on its
existing frontend and pinned runtime, and performs no product-image or runtime-route
write.

Runtime rollback after failed readiness is a different operation: Core may restore a
previously retained route when the release contract proves that rollback is safe. Do
not use an older installer as a shortcut for that authority. If recovery truly
requires an older frontend, first preserve the workspace, Episode, session, and
runtime evidence needed for diagnosis, then follow a release-specific manual
recovery procedure.

## When the new runtime takes effect

Installing a runtime image does not activate it. Core returns one of these common
plans:

| Plan | Meaning |
| --- | --- |
| `apply-now` | the workspace is idle; stage and reconcile readiness now |
| `compatible-handoff` | current work stays pinned; new work moves at a fenced safe point |
| `defer-until-idle` | current work is incompatible with the target; wait |
| `resume-required` | the provider must create a supported new physical attempt |
| `blocked-incompatible` | safe continuation cannot be proved |
| `action-required` | an irreversible or non-recoverable boundary needs one explicit action |

Every generation pins `runtimeBuildId`, artifact root, entrypoint, manifest digest,
and protocol/schema contract. A frontend update, environment variable, or
convenience pointer cannot change an existing generation's bytes.

## Updates while work is active

An update never kills active work merely to make progress.

- With `active-work-compatible`, the current generation continues and a new
  generation may take new work after a fenced handoff.
- With `active-work-incompatible`, the update waits until the workspace is idle.
- Downloaded bytes may remain installed while activation waits.

Do not restart or stop work just to clear a normal deferred state. Read the message's
`userAction`; a recoverable wait has no immediate action.

## Provider resume and session continuity

Some providers can resume logical work only by creating a new physical attempt.
Kungfu records that boundary rather than pretending a PTY or remote process survived.

- `provider-resume-required` means finish at a safe point and use the provider's
  supported resume action.
- `provider-resume-unsupported` means finish or explicitly stop the current work
  before activation.

Episode, workspace, and recorded session facts remain. The resumed attempt receives a
new physical identity.

## Irreversible migrations

An irreversible migration is always `action-required`. Core requires verified backup
or restore evidence and explicit approval before it can stage the target. Neither the
desktop nor CLI adapter may turn download success into migration approval.

## Rollback and recovery

Semantic readiness decides whether a staged generation becomes active. If readiness
fails and the manifest permits automatic rollback, Core restores the prior runtime
route and reports `failed-rolled-back` with reason `readiness-failed`.

Rollback changes runtime routing only. It does not delete or rewrite workspace,
Episode, journal, Work, or provider-session facts. If the release declares rollback
unavailable, the state remains `action-required`; follow the recovery instructions
for that release instead of forcing a pointer change.

There is intentionally no general command that claims arbitrary frontend bytes are a
safe rollback target. Use the retained release evidence and Core receipt.

## Stale plan or generation

Plans and receipts fence the generation and content identity they observed. If either
changes, Kungfu returns `stale-plan` or `stale-generation` and performs no activation.
Refresh status, create a new plan, and execute only its exact identifier.

## Runtime retention and cleanup

Versioned images remain until Core proves that no process, generation, lease,
rollback window, or recovery record refers to them. Preview cleanup with:

```console
kungfu runtime upgrade gc-plan --json
```

Unknown ownership fails closed. Cleanup owns only runtime-image inventory roots; it
never owns workspace, Episode, journal, or session data. Applying a GC plan is an
advanced operation and requires the unchanged plan id plus `--execute`.

## Offline and manual updates

For an offline host, transfer the release manifest and archive through your approved
channel, preserve their exact bytes, run `check` and `plan` on the local manifest, and
use `apply` with the published SHA-256. A local file does not become trusted merely
because it is reachable. Keep the publication, signature, qualification, and
provenance evidence with it.

Package-manager and native-installer users should update through that owner. The
built-in updater may still install a compatible shared runtime image when future
package contracts explicitly allow it, but it must never replace manager-owned
frontend files.

## Uninstall and data retention

Removing a desktop app, archive launcher, or package-manager installation is separate
from deleting user data. Do not treat uninstall as permission to remove the config
home, workspace, Episode, journal, runtime receipt, or recovery evidence. Current
pre-release adapters do not implement automatic data deletion.

GUI and standalone CLI product images have separate frontend ownership. Their verified
Core runtime inventory is shared by build identity, so removing one frontend must not
collect an image still referenced by the other.

## Troubleshooting

| Symptom or reason | Safe response |
| --- | --- |
| `release-unqualified` or missing signing evidence | do not install; use a qualified publication |
| platform or architecture mismatch | obtain the artifact for this host |
| digest, size, archive, or release-identity mismatch | discard the candidate bytes; do not bypass verification |
| I/O or disk-full failure | free space, keep current work running, and retry from a fresh plan |
| stale plan or generation | refresh status and create a new plan |
| readiness failure | allow Core recovery; inspect diagnostics only if it becomes action-required |
| unknown image reference | retain the image and inspect advanced diagnostics |
| no package-manager command | use that package's published instructions; Kungfu will not guess |

For the exact compatibility fields and stable reason contract, see
[Upgrade Compatibility Reference](../development/upgrade-compatibility.md). For
the public same-minor semantic commitment, cross-version reader boundary, and
current qualification matrix, see
[Exit, Migration, and Version Compatibility](exit-and-version-compatibility.md).
For
process-level investigation after a user message becomes action-required, use
[Debugging](debugging.md).
