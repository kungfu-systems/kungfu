# Install the standalone Kungfu CLI

## Quick install

The public routes below stay the same across Kungfu versions. They resolve the
release currently selected by the Buildchain publication state rendered on the
public [installation page](https://kungfu.tech/install/). That page owns the
current version, channel, Desktop GUI downloads, byte sizes, and SHA-256
digests.

macOS and Linux use the reviewed POSIX installer:

```sh
curl -fsSL https://kungfu.tech/install.sh | sh
```

Windows PowerShell uses the reviewed PowerShell installer:

```powershell
irm https://kungfu.tech/install.ps1 | iex
```

These are convenience forms, not a claim that TLS alone proves the release.
Each friendly route is a Buildchain-bound projection of the selected signed
release channel. It cannot reinterpret a version, change channels, or authorize
product bytes on its own.

Stable and Alpha remain distinct. An Alpha-only public launch must say `alpha`
in the page, installer plan, installed status, and retained receipts. A missing
qualified Stable channel fails honestly instead of silently selecting Alpha.

## Make Kungfu available in PATH

Standalone archive installations print their per-user bin directory. Add that
exact directory to the environment used by your shell and agent.

If you installed the desktop app on macOS, open **Kungfu → Install 'kungfu'
Command in PATH**. The app creates `/usr/local/bin/kungfu` as a launcher for the
exact bundled CLI; it does not copy or replace the runtime.

Verify the command before asking an agent to use it:

```sh
command -v kungfu
kungfu --version
```

If PATH installation is unavailable or you do not want it, open **Getting
Started with Your Agent** in the app and copy the prompt shown there. That
prompt includes the exact local CLI path, so the agent does not have to guess
where the app was installed. Do not hand-create a symlink to a guessed app
bundle path; moving or replacing the app would leave that guess stale.

The release and ownership boundary for both installation paths follows below.

## Higher assurance: download, inspect, pin, then run

For higher-assurance or automated use:

1. open the installation page and copy the immutable installer URL;
2. download that version-addressed file without executing it;
3. compare its size and SHA-256 digest with the Buildchain publication evidence;
4. inspect the script; and
5. execute the local file with an explicit channel or version.

Example shape:

```sh
curl --fail --proto '=https' --tlsv1.2 \
  --output install.sh \
  https://kungfu.tech/installers/v1/CHANNEL/CHANNEL_ROOT/install.sh
shasum -a 256 install.sh
sed -n '1,240p' install.sh
sh install.sh --channel CHANNEL --version VERSION
```

The installation page supplies the concrete `CHANNEL`, `CHANNEL_ROOT`,
`VERSION`, byte size, and digest. Never copy placeholders from this guide.

## Options and filesystem ownership

Both installers support an explicit channel, exact version, install directory,
bin directory, no-PATH mode, dry-run plan, verbose diagnostics, and
non-interactive CI use. Run `--help` on the downloaded file for the exact
spelling.

The default is per-user. The installer does not request sudo or Administrator
rights and does not edit shell profiles, PowerShell profiles, registry, services,
scheduled tasks, global PATH, or package-manager databases. It prints the
per-user bin directory so the user or CI environment can add it explicitly.

Archive installations own only their versioned product directory and launcher.
If the discovered `kungfu` is owned by Homebrew, WinGet, MSI, a desktop
companion, deb/rpm, or an unknown path, bootstrap fails with an ownership
conflict. Use that manager for update and uninstall. Confirm ownership with:

```console
kungfu update status
kungfu update status --json
```

## What is verified before selection

The immutable installer pins the exact signed-channel bytes produced by the
release transaction. It downloads into a bounded same-filesystem staging area
and checks:

- signed channel file digest, Ed25519 signature, trust-key identity, freshness,
  and rollout state;
- Release Passport reference and root;
- product version, source commit, channel, platform, architecture, and
  `archive` install source;
- release-manifest and artifact roots;
- archive byte size and SHA-256 digest;
- retained platform-signing evidence where required by the selected release,
  together with any explicit signing exception bound to that publication; and
- the extracted product and bundled runtime identity.

The staged CLI repeats the signed-channel and product checks through
`kungfu update bootstrap-verify`. Only after that receipt succeeds does the
installer atomically publish a version directory and switch the stable launcher.
Interrupted, concurrent, truncated, tampered, stale, cross-channel, or
permission-denied attempts leave the prior launcher authoritative.

The unavoidable first stage is the installer file obtained over public HTTPS.
That is why the immutable URL, pinned digest, inspection path, Buildchain
deployment evidence, and public read-back are all part of the release claim.

## Update, rollback, and uninstall

Use [Upgrade Kungfu](upgrading.md) for normal signed-channel updates and retained
runtime generations. Archive updates preserve side-by-side product images and
do not overwrite a running process.

Rollback selects a retained verified generation through the archive update
contract; it does not rewrite old evidence. Uninstall removes only
archive-installer-owned launcher and version directories after ownership has
been confirmed. Workspace, Episode, journal, and package-manager facts are not
installer-owned and must not be deleted as part of uninstall.

## Proxy and troubleshooting

`curl`, `Invoke-WebRequest`, and the staged CLI use the platform's explicit proxy
environment or PowerShell networking configuration. The installer does not
install certificates, weaken TLS, or add proxy bypasses.

Stable failure codes identify the layer: unsupported platform or architecture,
ownership conflict, channel download or byte mismatch, artifact size or digest
mismatch, platform trust failure, signed-authority mismatch, concurrent install,
or activation failure. Retry only after resolving that exact cause; do not
disable verification.
