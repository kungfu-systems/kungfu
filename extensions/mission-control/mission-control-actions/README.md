# Mission Control Actions

Owns the active Mission/Go/Claim domain, assessment orchestration, Atlas
admission, and portable Mission bundle implementation. `adapter.py` is the
exact-root public Profile boundary; `domain/` is loaded only from this member's
content-bound package root.

Core `kungfu.atlas` code remains a source adapter and deprecated compatibility
surface. It does not own or import the active Mission Control implementation.
