# Mission Control Actions

Owns the active Initiative/Assignment/Claim domain, assessment orchestration,
Atlas admission, and portable compatibility bundles. Mission/Go records are
legacy read projections and bounded command aliases over the successor domain;
they are not a second writable authority. `adapter.py` is the exact-root public
Profile boundary; `domain/` is loaded only from this member's content-bound
package root.

Core `kungfu.atlas` code remains a source adapter and deprecated compatibility
surface. It does not own or import the active Mission Control implementation.
