# Product publication closure

Buildchain owns the four-platform build, `alpha:qualify`, artifact assembly,
signing inputs, and the Release Candidate Passport. Once that Build run is
successful, Kungfu does not insert another semantic, source, KFD, Project Cut,
Warrant, controller, receipt, or predicate admission layer.

The publication tail accepts one successful Build run ID, downloads its
Passport and platform artifacts, prefers the signed macOS payload when present,
and creates or completes the corresponding prerelease GitHub Release. It does
not update a channel index or any other provider.

If GitHub publication stops after the build, dispatch `Release Alpha` again
with only the original `candidate-run-id`. The operation is retryable: an
existing draft or partial Release is reused and assets are uploaded with
replacement enabled.
