# Run the independent Python reader

You are at **Do a task**. Use this path when you need evidence that the
installed Spec bytes can be verified without Node APIs, Kungfu runtime, or
third-party Python packages.

The reader exists in the direct `@kungfu-tech/spec` package:

```sh
python3 node_modules/@kungfu-tech/spec/reference-readers/python/portable_format_reader.py --json
```

It verifies:

- every artifact root and byte length declared by `manifest.json`;
- the canonical normative root;
- every retained vector byte root and byte length;
- each vector's declared classification against the reader's known outcomes;
- that all required package-local paths stay inside the package root.

Its report contract is
`kungfu.spec.independent-python-reader-report/v1`. A successful report declares
an empty `runtimeDependencies` array and reports the installed package,
normative root, corpus release, vector count, and observed outcomes.

## Verify a staged package root

When the package is unpacked somewhere other than `node_modules`, pass its
root explicitly:

```sh
python3 portable_format_reader.py \
  --package-root /path/to/unpacked/package \
  --json
```

The Site Bundle carries this guide and all rooted Spec documentation and
evidence, but it intentionally does not claim to contain this executable
reader. Install `@kungfu-tech/spec` when you need to run it.

Previous: [Use the Spec CLI](cli.md)\
Next: [Run and interpret the conformance corpus](conformance.md)
