# Installed KFX Authoring Brief

This installed Kungfu product contains a version-matched, content-addressed
KFX authoring kit. Start with:

```sh
kungfu kfx author capabilities --json
kungfu kfx author scaffold my-webhook --out ./my-webhook --json
kungfu kfx author scaffold my-webhook --out ./my-webhook --execute --json
```

The starter is a Node service KFX using the stable
`kungfu.kfx.service-host/v1` contract. It contains the exact runtime SDK
projection, TypeScript declarations, a loopback-only receiver, and a
deterministic qualification fixture. It has no npm dependency and remains
reproducible offline after Kungfu is installed.

Use one ordered lifecycle:

```text
inspect -> scaffold/edit -> validate -> build -> qualify -> package
        -> native plan -> authorize -> install/upgrade -> activate/run
        -> status/history/diagnose -> deactivate/rollback/remove
```

The authoring commands own only inert source and artifact bytes. They do not
grant capabilities, issue a Warrant or Release Passport, install a package, or
activate a listener. `kungfu kfx install`, native KFX plans, and Core receipts
remain the only lifecycle and authorization authority. A generated package
requests `network.listen` and `credential.verify`; normal policy may refuse
either request.

The local qualification fixture binds only `127.0.0.1` on an ephemeral port,
uses a synthetic broker response rather than credential material, and retains
only stable diagnostic and receipt roots. Its success is build evidence, not
production admission.

After editing, run:

```sh
kungfu kfx author inspect ./my-webhook --json
kungfu kfx author validate ./my-webhook --json
kungfu kfx author build ./my-webhook --out ./my-webhook-build --json
kungfu kfx author build ./my-webhook --out ./my-webhook-build --execute --json
kungfu kfx author qualify ./my-webhook-build --json
kungfu kfx author package ./my-webhook-build --out ./my-webhook.tgz --json
kungfu kfx author package ./my-webhook-build --out ./my-webhook.tgz --execute --json
```

Then inspect the existing native KFX surface before any mutation:

```sh
kungfu kfx native inspect my-webhook --root workspace=./my-webhook-build
kungfu kfx native plan --root workspace=./my-webhook-build
```

Installation, activation, upgrade, rollback, and removal require exact current
Core authority evidence. Never put a raw secret, signature, public endpoint,
or organization data into the manifest, fixture, package, log, or receipt.

