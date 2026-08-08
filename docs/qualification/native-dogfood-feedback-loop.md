# Native dogfood feedback-loop qualification

This record qualifies the first-party `kungfu.dogfood-feedback` Domain Profile
through the desktop Product's bundled `kungfu` executable. It distinguishes
native fact authority from native Finding and Issue facts and does not treat a
source-only Python invocation as installed-product evidence.

## Qualified product boundary

The command under test was:

```text
product/dist/desktop/mac-arm64/Kungfu Episodes.app/Contents/Resources/kungfu/kungfu
```

`./shifu product gui build` completed the signed directory Product build and
the bundle audit found one Kungfu runtime. The build generated a KFD-3 release
manifest containing both `kungfu.dogfood-feedback` and
`kungfu.work-control`. Local notarization was skipped because notarization
options were unavailable, so this record does not claim a publishable or
notarized installer.

## Native lifecycle

The bundled CLI initialized a disposable project workspace, activated the
packaged Dogfood Profile, and ran the checked-in fixtures in order:

1. capture one Finding;
2. admit one owned Issue;
3. transition the Issue to `deferred`;
4. record `design`, `admission`, `kickoff`, and `closeout` consideration
   receipts; and
5. evaluate the closeout gate.

The stable identities were:

| Evidence | Root |
| --- | --- |
| Finding | `sha256:3539a06d3bf914d6ae95e549295a1653d6d4931c9e4afa029f4683e87c6363cb` |
| admitted Issue | `sha256:fe3830617b388afbff6a9e49ed1ea1c6e78132152465a7737756fcb889fc3ae8` |
| deferred Issue | `sha256:546a2641c9fc1a8f1eb9ff739096fa43b4b691fe91514314263a9ae1b80b2131` |
| design consideration | `sha256:a44a559655f1b08feeea9e3623be26f3bc50364f245350b4d231eedf220a2d13` |
| admission consideration | `sha256:aa372be07655d39277ec24c7908c39fede8268d15c9d2b5a96c9e5520cd85288` |
| kickoff consideration | `sha256:ec80c8a1b0540cde9efcc818447c90e8267daac080e6c5b702785f8de3663324` |
| closeout consideration | `sha256:850d6f17325eea59e38ec96e91e95c6ae28718fbeb48ce080e9656b706122e51` |

The closeout gate returned `ok: true`. KFD-3 status for the same active runtime
returned `qualified`, `current: true`, and `activeExactRoot: true` for Profile
Suite root
`sha256:8e91036a2433a6af65c5fddbea77d321b14463ab8bc606c5bfacfd09bbca2dd5`.
Its release receipt is
`sha256:94718d5191e4cd7493c6e6e448d90336c20dbf0e0dcb3895737467181de6fcf8`
and witness is
`sha256:2860a9995e4e8a983dec5f7822be0378fbd349fa62d6f97bab2c596c7fffa548`.

## Reproduction

Use the bundled Product binary, initialize a disposable workspace with
`kungfu workspace ensure`, then run the five `native-dogfood-*` fixture files
under `docs/qualification/fixtures/`: Finding, Issue, transition, Assignment,
and the dispositions bundle used across the four consideration stages. Set
`KF_RUNTIME_DIR` to that workspace's receipt `runtime_dir` and
`KF_PROFILE_KFD3_MANIFEST` to the bundled `profile-kfd3.json` before
`profile kfd3-status`.

## Evidence boundary

This qualification proves the macOS arm64 directory Product and bundled
headless CLI on the observed host. It does not claim Windows/Linux packaging,
interactive GUI pixel behavior, remote Buildchain completion, notarization, or
publication. Those remain release- and merge-bound evidence.
