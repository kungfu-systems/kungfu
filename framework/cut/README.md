# Core Cut

`kungfu.cut/v1` is Kungfu Core's domain-neutral macro-commitment protocol. A
Cut binds one Domain Profile, parent Cuts, typed authority roots, an admitted
Episode delta, interpretation roots, and explicit uncertainty. It does not own
or reinterpret any underlying authority.

Domain Profiles choose the displayed product name. The software-development
Profile displays a Cut as **Project Cut** and projects Git source, Xinfa Atlas,
and Kungfu Episode roots through typed bindings. Course Production displays the
same Core object as **Course Release Cut** without Core changes.

The public product command remains `kungfu cut`. Existing `project.cut/v1`
artifacts retain their original verifier and roots. `src/project-cut-migration.mjs`
creates a new `kungfu.cut/v1` identity plus a root-bound migration receipt; its
rollback is to read the legacy artifact with the legacy verifier, never to
reinterpret either root.
