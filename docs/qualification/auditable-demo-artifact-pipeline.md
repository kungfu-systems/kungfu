---
metadata_schema: kungfu.document-metadata/v1
document_status: stable
period: 2026-08-02
theme: declarative-multi-demo-animation
doc_type: engineering-evidence
sources: [local-files, executable-probe, official-upstream, user-consensus]
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-03
ai_provenance: GPT-5 via Codex on 2026-08-02; updated by GPT-5 via Codex on 2026-08-03 to separate non-interactive artifact transport verification from native PTY playback after an exact Build failure; based on checked-in Kungfu, Buildchain, and Build Images contracts plus exact workflow evidence visible to this task; no claim is made for a render that has not passed the retained Gate
---

# Declarative Multi-demo Animation Pipeline

Kungfu consumes Buildchain's generic declarative binary-demo capability. The
product owns only its scenario and its standalone binary distribution;
Buildchain owns capture, Gate qualification, native rendering, evidence,
README materialization, and the update pull request.

The single source of scenario intent is
`.buildchain/auditable-demo.json`. It declares two demos:

| Demo | Exact installed-binary argv | Bound |
| --- | --- | --- |
| Agent Work Lab autoplay | `kungfu agent-work-lab autoplay` | 90 seconds |
| Guided Project Tour | `kungfu agent-work-lab project-tour --speed 0.8` | 180 seconds |

Both playback commands are self-driving, deterministic under the declared
isolated environment, credential-free, and bounded by the `long-form` duration
class. They intentionally run inside native PTYs and are executed directly as
argv, never through a shell command string.

Before upload, a distinct non-interactive transport smoke runs
`kungfu agent-work-lab demo --json` from the copied standalone distribution and
requires the `kungfu.agent-work-lab.report/v1` sentinel. This verifies that
transport retained an executable product without pretending that a pipe is a
PTY or replacing either native playback capture.

## One reusable path

```text
exact same-run Kungfu Linux artifact
-> standalone binary metadata and digest verification
-> declarative scenario validation
-> isolated PTY capture for every demo and rendition
-> required Buildchain Gate
-> immutable Build Images renderer
-> content-addressed media and Release Passport
-> protected README materialization pull request
```

`.github/workflows/build.yml` calls one exact
`.declarative-auditable-demo.yml` revision. Manual Gate-only validation leaves
`render-auditable-demo` disabled. Manual full validation enables it. Alpha and
Release promotion use the same call with full rendering and materialization
enabled automatically; there is no product-specific adapter, trigger-plan
compiler, Passport writer, renderer wrapper, or README updater.

The Linux build artifact contains both `product/release` and the exact
standalone distribution at
`product/dist/cli/kungfu-episodes-cli-linux-x64/`. The latter includes the
launcher and `auditable-demo-binary.json`, which binds the launcher SHA-256,
platform id, metadata contract, and an empty runtime-dependency set. Capture
therefore runs the product binary produced by the same workflow run instead of
rebuilding Kungfu or using npm as an execution layer.

## Native responsive renditions

Every demo is captured twice from the same deterministic replay window:

- `1920x1080` uses its declared wide PTY;
- `1280x720` uses its declared narrow PTY.

The 720p rendition is not a resized 1080p recording. Each PTY receives the
same timed terminal events but independently reflows the real TUI at its own
column and row dimensions. The renderer retains ANSI color and emits GIF,
MP4, WebM, poster, probe, inspection, receipt, and checksum evidence. The
long-form web profile keeps a 10 fps capture budget and rejects duration,
dimension, output-size, native-rendition, or renderer-contract drift.

## Materialization and evidence

For a multi-demo scenario, Buildchain owns one README block per demo:

```text
kungfu:auditable-demo:agent-work-lab-autoplay
kungfu:auditable-demo:project-tour-08x
```

Qualified media is copied under the content-addressed root
`docs/qualification/evidence/auditable-demo/<evidence-root>/<demo-id>/`.
Each block links to its GIF, native 1080p and 720p videos, reduced-motion
poster, `public-evidence.json`, and `release-passport.json`. Re-running the
same evidence is idempotent; a changed source, scenario, capture, Gate, or
media bundle produces a different evidence root.

The workflow token may create the bounded materialization pull request only.
It does not grant package publication, deployment, release-channel promotion,
or arbitrary repository-write authority.

## Authority boundary

The scenario, binary metadata, capture, renderer output, checked-in media,
Product System identity, first-party/System identity, KFD compliance, package
metadata, registry history, scan results, and standalone generation are not
authorization sources. The scenario declares `grants: []`.

Authorization must come from the exact Release Passport, Core policy, Work or
Warrant, an explicit capability grant, and runtime isolation. Product System
is assembly and distribution metadata only. A passing demo proves only that
the exact retained product artifact executed the named deterministic scenario
and that its observations passed the declared Gate and media profile.

## Fail-closed checks

The path rejects, at minimum:

- a missing or mismatched binary metadata digest;
- network or secret use, shell command strings, unsafe paths, or undeclared
  runtime dependencies;
- a timeout beyond the selected duration class;
- missing completion sentinels or unexpected exit codes;
- capture timelines not derived from actual PTY read times;
- identical or scaled native-rendition frame sets;
- an unpinned Buildchain workflow or renderer image;
- checksum, Gate-root, media-root, scenario-root, or source-coordinate drift;
- any implicit authority or capability grant; and
- incomplete or ambiguous README markers.

Only a retained passing run and its content-addressed evidence may update the
README. A failed or cancelled run is diagnostic evidence, never qualification.
