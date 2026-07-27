# Verify your first installed authority

You are at **First success**. The goal is one verified result before any deeper
reading.

## 1. Install an exact pickup

```sh
SPEC_VERSION=$(npm view @kungfu-tech/spec@alpha version)
npm install --save-exact "@kungfu-tech/spec@$SPEC_VERSION"
```

The package version is a pickup coordinate. It is not a format compatibility
decision. Review the discovered version and commit the exact version selected
by your release process; do not persist `@alpha`.

## 2. Verify the installed projection

```js
const {
  authorityManifest,
  verifyAuthorityBundle,
} = require('@kungfu-tech/spec');

const manifest = authorityManifest();
const proof = verifyAuthorityBundle();

if (proof.normative_root !== manifest.normative.root) {
  throw new Error('installed authority root mismatch');
}

console.log({
  status: proof.status,
  normativeRoot: proof.normative_root,
  artifacts: proof.artifact_count,
  vectors: proof.vector_count,
});
```

A successful result has `status: "read"`, eight rooted authority artifacts,
and the retained vector count declared by the installed package. Do not copy a
root from this page: read it from the installed manifest and persist it in
your own release evidence.

## 3. Choose the next task

- Integrating in Node: [Use the Node API](api.md).
- Automating from a shell or CI job: [Use the Spec CLI](cli.md).
- Checking independence from Node and Kungfu runtime:
  [Run the Python reader](python-reader.md).

Previous: [Start here](index.md)\
Next: [Use the Node API](api.md)
