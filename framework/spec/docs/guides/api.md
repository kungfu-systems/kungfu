# Use the Node API

You are at **Do a task**. This page is the complete public Node API, grouped by
the job it performs.

## Inspect and verify format authority

```js
const {
  authorityArtifact,
  authorityManifest,
  inspectAuthority,
  verifyAuthorityBundle,
} = require('@kungfu-tech/spec');

const manifest = authorityManifest();
const authority = inspectAuthority();
const readerContract = authorityArtifact('reader_matrix');
const proof = verifyAuthorityBundle();
```

- `authorityManifest()` loads the installed manifest.
- `authorityArtifact(id)` verifies one rooted artifact before returning its
  descriptor and parsed value.
- `inspectAuthority()` returns the current authority, compatibility, migration,
  vectors, roots, and non-claims.
- `verifyAuthorityBundle()` verifies the normative root, every authority
  artifact, and every retained vector byte root.

## Inspect and verify conformance evidence

```js
const {
  conformanceVector,
  inspectConformance,
  verifyConformanceCorpus,
} = require('@kungfu-tech/spec');

const corpus = inspectConformance();
const proof = verifyConformanceCorpus();
const vector = conformanceVector(corpus.vectors[0].id);
```

- `inspectConformance()` returns the installed release, release root, vector
  summaries, compatibility axes, and reader outcomes.
- `verifyConformanceCorpus()` verifies the exact retained byte length and root
  of every vector.
- `conformanceVector(id)` verifies and returns one descriptor plus its
  package-local byte path. It does not interpret the vector beyond the declared
  evidence.

## Operate on a portable bundle

```js
const {
  inspectBundle,
  preserveBundle,
  verifyBundle,
} = require('@kungfu-tech/spec');

const inspection = inspectBundle('/path/to/bundle');
const verification = verifyBundle('/path/to/bundle');
const preservation = preserveBundle(
  '/path/to/bundle',
  '/path/to/new-bundle',
);
```

- `inspectBundle(input)` reports known structure and unknown inventory.
- `verifyBundle(input)` verifies the structural scope implemented by the
  selected reader profile.
- `preserveBundle(input, output)` copies into a new, previously absent
  directory and proves that the event-log bytes did not change.

`bundleRoot`, `manifestPath`, `manifestSchemaPath`, and
`conformanceBundlePath` are exported package-local paths for tooling. Resolve
manifest-declared paths inside the package root and reject traversal.

## Interpret status precisely

`read` does not mean every future semantic is universally understood. Every
result is bounded by its selected reader profile. Use the conformance guide for
the meanings of `read-degraded`, `preserve-only`, `migration-required`, and
`reject`.

Previous: [Verify your first installed authority](quickstart.md)  
Next: [Use the Spec CLI](cli.md)  
Evidence: [Run and interpret the conformance corpus](conformance.md)
