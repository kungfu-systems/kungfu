# Use the Spec CLI

You are at **Do a task**. Every command writes one JSON object to standard
output and exits nonzero on a failed check.

## Authority commands

```sh
kungfu-spec authority
kungfu-spec authority-verify
```

- `authority` inspects the current authority, compatibility, migration,
  retained vectors, roots, and non-claims.
- `authority-verify` recomputes the normative root and verifies every installed
  authority artifact and retained vector.

## Conformance commands

```sh
kungfu-spec corpus
kungfu-spec corpus-verify
kungfu-spec corpus-vector journal-v1-unknown-carrier
```

- `corpus` lists the installed corpus release, root, axes, outcomes, and vector
  summaries.
- `corpus-verify` verifies every retained vector byte length and root.
- `corpus-vector ID` verifies one vector and returns its descriptor and
  package-local byte path.

These commands prove the retained evidence bytes. They do not claim that one
reader implementation has independently executed every semantic oracle.

## Portable bundle commands

```sh
kungfu-spec inspect BUNDLE
kungfu-spec verify BUNDLE
kungfu-spec preserve BUNDLE OUTPUT
```

- `inspect` performs bounded inspection and reports unknown records.
- `verify` performs the structural verification implemented by the reader
  profile.
- `preserve` writes a new destination, refuses an existing output, and verifies
  byte preservation.

Run `kungfu-spec` with no arguments to print the canonical usage line. Treat
the JSON fields and status values as the interface; do not scrape prose from
standard error.

Previous: [Use the Node API](api.md)\
Next: [Run the independent Python reader](python-reader.md)\
Evidence: [Run and interpret the conformance corpus](conformance.md)
