# Vendor Agent Hub embedding qualification

The reference target is the public OpenCode npm-plugin seam. This choice keeps
the vendor's current TUI, models, provider accounts, permission decisions,
tools, server/cloud connection, and customer relationship outside Kungfu.
Kungfu receives only lifecycle metadata needed to open, heartbeat, close,
recover, inspect, and export a generic Episode.

The source package is
[`examples/opencode-kungfu`](../../examples/opencode-kungfu/README.md). Its
qualification harness creates package tarballs, installs them in a disposable
consumer directory, discovers the observed machine and OpenCode version,
forces a plugin process to terminate with an unsealed Episode, restarts the
installed plugin, verifies native recovery, runs a 100-pair lifecycle workload,
exports and imports the Episode, runs source and destination fsck, records hook
latency, and binds the result to the independently verified KFD Runtime 100
report for the exact frozen adapter.

The retained output includes the self-contained portability artifact
`episode-bundle.json`, the public thin
`episode-project-cut-bundle.json`, and the matching
`episode-qualification.json`. The qualification is the complete native
`storageFsckTyped` response for the exact unsigned 64-bit Episode identifier.
Project Cut consumes the thin bundle, which excludes journal bytes and private
material, and therefore does not need to reconstruct the identifier through a
JavaScript `number`.

Run after building and freezing the exact source and producing the KFD adapter
qualification:

```bash
./shifu vendor:opencode:qualify -- \
  --runtime-dist framework/core/dist/kungfu \
  --kfd-qualification <kfd-qualification-directory> \
  --output-dir <new-output-directory>
```

The harness never calls a model, reads an OpenCode provider account, or mutates
hook outputs. Test fixtures contain sentinel prompt, tool, error, and credential
values and assert that none reach the retained adapter calls.

A passing report qualifies only its source state, package digests, frozen Core
artifact, KFD adapter digest, KFD profile/suite roots, platform, and observed
OpenCode public hook shape. It does not claim OpenCode endorsement, external
adoption, physical power-loss durability, or compatibility on an unobserved
platform.
