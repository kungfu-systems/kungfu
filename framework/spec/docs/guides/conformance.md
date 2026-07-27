# Run and interpret the conformance corpus

You are at **Understand evidence**. The corpus is retained, content-addressed
evidence for required-reader outcomes across compatibility axes. It is not a
promise that unsupported future versions will work.

## Verify the installed evidence

Choose one independent path:

```sh
kungfu-spec corpus-verify
```

```js
const {
  inspectConformance,
  verifyConformanceCorpus,
} = require('@kungfu-tech/spec');

const corpus = inspectConformance();
const proof = verifyConformanceCorpus();
console.log(corpus.release, proof.release_root, proof.vector_count);
```

```sh
python3 node_modules/@kungfu-tech/spec/reference-readers/python/portable_format_reader.py --json
```

The current installed corpus declares its own release, release root, and vector
count. Read those values from the package rather than copying a mutable number
from documentation.

## Understand the five outcomes

| Outcome | Meaning |
| --- | --- |
| `read` | All material required by the selected reader profile is structurally and semantically understood. |
| `read-degraded` | The bounded operation completed, while semantic verification is explicitly incomplete. |
| `preserve-only` | Exact well-formed bytes may be retained or copied, but no semantic fold or admission is allowed. |
| `migration-required` | A compatible reader or receipt-bearing migration is required before semantic continuation. |
| `reject` | Corruption or missing required material prevents the selected bounded operation. |

An outcome is always relative to a reader profile and operation. Do not
collapse `read-degraded` or `preserve-only` into success with complete
semantics.

## Understand the compatibility axes

The retained vectors cover the axes declared by their `axes` arrays:

| Axis ID | What changes |
| --- | --- |
| `bundleManifest` | Portable bundle manifest contract |
| `capabilities` | Required or optional capability set |
| `journalEpoch` | Journal container epoch |
| `payloadSchemas` | Payload schema binding |
| `recordSchemas` | Record schema binding |
| `rootProtocols` | Meaning-bearing root protocol |
| `unknownAxis` | A tuple axis unknown to the reader |
| `workspaceLayout` | Workspace layout contract |

One vector may exercise more than one axis.

Use `kungfu-spec corpus` or `inspectConformance()` for the exact installed
axis set. Use `corpus-vector ID` or `conformanceVector(id)` to inspect one
descriptor, including:

- byte path, byte length, and byte root;
- reader profile and expected outcome;
- expected failure code, classification, reason, and write boundary;
- the independent or native oracles that retained the evidence.

## Know what was proved

`corpus-verify` proves the exact retained bytes match the rooted index.
The independent Python reader additionally classifies every retained vector
using its implemented reader contract. Neither check silently promotes the
pre-release authority to stable or replaces the owning protocol sources.

Previous: [Run the independent Python reader](python-reader.md)  
Next: [Complete contract reference](reference.md)
