# Upgrade Kungfu without interrupting current work

Kungfu separates three events that traditional installers often blur together:

1. a distribution adapter downloads and verifies release bytes;
2. those bytes are installed beside existing runtime and product images; and
3. Core decides when a workspace may use the new runtime.

Downloading or installing an update never grants it live authority. Existing work
keeps the exact runtime bytes it already owns until Core produces a compatible plan,
stages a new generation, and accepts semantic readiness.

> **Alpha boundary:** `v4.0.0-alpha.1` publishes the signed Alpha channel,
> standalone CLI archives, and desktop artifacts for the declared macOS arm64,
> Linux x86_64, and Windows x86_64 surfaces. It does not open a Stable channel,
> native package-manager publication, or a general production claim. A build
> without matching qualified publication evidence must not offer itself as an
> update.

Before relying on a version-to-version data claim, read
[Exit, Migration, and Version Compatibility](exit-and-version-compatibility.md)
and inspect the policy shipped with the candidate using
`kungfu exit verify --info --json`. Product SemVer does not replace explicit
schema, protocol, artifact, and platform evidence.

## Current install and update claims

The public Alpha channel currently identifies `v4.0.0-alpha.1`. Its hosted
channel index, trust anchor, Release Passport, installers, and standalone CLI
archives are published for Darwin arm64, Linux x86_64, and Windows x86_64. The
[installation guide](installing-cli.md) owns acquisition instructions. There
is still no Stable channel or official Homebrew Formula, WinGet package, deb,
or rpm publication.

Because `v4.0.0-alpha.1` is the first public v4 Alpha, it establishes an
acquisition baseline but not an observed public old-to-new transition. Claims
about upgrading from it require a later qualified release and the exact
transition evidence described below.

The first Windows Alpha is intentionally an unsigned PE distribution. Kungfu
does not require or claim Authenticode certification for that cut. Its bootstrap
trust boundary is the signed channel index plus the exact archive digest,
manifest root, artifact root, and installed-product read-back. The verifier
reports `platformCodeSigning: false`; users must not interpret the Alpha as an
operating-system publisher-identity claim.

A release may advertise only a platform, architecture, channel, and
install-source tuple whose retained native campaign starts from one exact older
public version and reaches the exact candidate. The campaign must bind both
channel-index roots, both release-passport roots, source commits, manifests,
artifact roots, receipts, activation behavior, `kungfu run agent`, and the
complete fault matrix. Source fixtures remain mechanics-only.

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

## One-command install-source behavior

For a qualified installed product, the ordinary update is one command:

```console
kungfu update
```

It discovers the signed channel entry, explains current-work and activation
impact, asks at most one confirmation, delegates to the locally installed
source owner, verifies the exact target version, and writes a content-addressed
receipt. Non-interactive use must pass `--yes`; `--check` remains read-only.
There is no updater daemon, supervisor action, coordinator command, or service
restart for an ordinary update.

An archive install uses the archive adapter and immutable side-by-side images.
A Homebrew install may run only the Formula-owned exact argv and then
`kungfu --version`; it cannot switch to archive ownership. Desktop-companion,
native-installer, unsupported, and unknown sources return one explicit external
action instead of inventing a second authority.

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
The prepared Homebrew Formula owns one local contract in `product.json`:
`brew upgrade --formula kungfu-systems/tap/kungfu`, followed by
`kungfu --version`. Core accepts only that exact argument pair, invokes it without
shell interpolation or ambient secrets, and verifies the selected target version
before reporting success. The Formula remains non-installable until the tap
publishes an official Formula bound to qualified archives and exact checksums;
the Alpha archive publication alone does not create that package-manager entry.
Other package-manager sources still show no invented package name until their own
locally allowlisted contract is implemented and embedded.

Package-manager failures preserve manager ownership and write a stable receipt.
Unavailable Formula or executable, untapped/unreachable source, offline transport,
permission denial, bounded timeout, cancellation, failed upgrade, and target-version
mismatch remain distinguishable without retaining raw manager output.

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

Treat the release manifest as evidence, not as a version string. A
`productVersion` is a compatibility and ordering label; the exact identity is
`releaseCutRoot`. The Product Release Cut closes over source settlement,
semantic and assembled product identity, compatibility and migration contracts,
platform slices, qualification/signing evidence, omissions, waivers, parent
Cuts, and publication policy. Two manifests may therefore share one SemVer only
when their unequal Cut roots remain explicit.

Movement between unequal Cuts requires a `Cut Transition`. A same-SemVer public
successor needs signed supersession evidence, while a local Shifu successor is
explicitly publication-ineligible. Diverged or unknown relations never update
implicitly. Each plan and receipt reports the current/target Cut roots and the
transition root so a human or agent can distinguish identical, successor,
conflict, recovery, and refused movement.

The published Alpha archive adapter verifies archive size and SHA-256 against
the manifest, requires non-placeholder signing evidence, and binds the signed
channel and Release Passport before selection. That qualifies only the exact
`v4.0.0-alpha.1` acquisition path; it does not qualify a later transition or a
Stable channel by implication.

The release gate separately requires retained native-packaged qualification evidence
whose source, product, platform, architecture, artifact digest, size, and signing
reference match the manifest. It also requires a fresh clean-environment
old-to-new `kungfu update` campaign for every advertised install-source tuple.
That campaign binds the signed channel-index and Buildchain release-passport
roots, one exact older public version, install owner and action, the final
receipt, `--version`, `--help`, `run agent`, update status, package smoke,
activation behavior, and every required fault verdict. Its Ed25519 statement
verification, message/manual checks, and at least 128 runtime-generation churn
iterations must all pass. Source fixtures prove the verifier fails closed, but
do not promote another version, platform, architecture, or install source
beyond the published Alpha coordinates.

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
is monotonic by Product Release Cut transition: a slower older plan cannot replace a
newer completed selection. Equal SemVer with unequal Cut roots is accepted only
when the verified transition authorizes it. Every
successful selection increments a generation and retains the exact previous
frontend build, artifact digest, runtime build, product root, Release Cut, and
platform slice as rollback
coordinates. These coordinates are recovery evidence, not permission for an
implicit downgrade.

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

For local KFD-3 builds, one Shifu slot must contain the desktop artifact, CLI
archive, and final upgrade manifest. `shifu promote` selects that exact slot,
preflights the native update, and hands the manifest/archive/evidence roots to
the shipped `kungfu` updater. Shifu does not extract or select the CLI image.
Native Core owns side-by-side installation, activation-on-next-command, and
rollback. The installed inventory retains the rollback image, so deleting the
Shifu source slot or build cache does not remove rollback authority.

`kungfu update status --json` includes a read-only `frontendInventory` fsck result.
It verifies the selected image and every complete side-by-side image, reports
retained `.partial` staging material, and gives a recovery action when the current
selection or an image is unreadable. A killed install never reuses a partial
directory name, so an exact retry can proceed without deleting the last known-good
image or diagnostic material.

Download, apply, and top-level update receipts each carry a content-addressed
`receiptRoot`. The top-level receipt also retains the signed release payload root
and the exact frontend/runtime build identities, so qualification can distinguish
transport success from the bytes actually installed and selected.

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

## Fault and recovery qualification

Every advertised tuple must retain exact-candidate evidence for network
interruption, cache corruption, digest mismatch, signature mismatch, stale
plan, unsafe archive, disk-full and permission failures, package-manager
failure, activation boundary, clean restart, exact retry, and unsupported
source. Each row must end in either `no-mutation` or `recoverable`, retain the
previous authority, name one recovery action, and carry a receipt root.

This matrix covers ordinary process, filesystem, transport, archive, and
package-manager faults in its recorded environment. It does not claim sudden
power-loss durability, recovery from malicious tampering, or that an already
running process changes binary versions without a boundary. Those three
non-claims must remain explicitly false in release evidence.

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
advanced operation and requires the unchanged plan id plus `--execute`. When
`--references` is omitted, Core derives live references from runtime status and the
active image pin; if an installed inventory has no active pin, the plan is blocked
instead of treating the missing authority as an empty reference set. Operators may
provide a verified reference array explicitly when another owner supplies the
complete process, generation, lease, rollback, and recovery view.

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
