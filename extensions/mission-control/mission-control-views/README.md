# Mission Control Views

Mission Control owns the five-question reducer and its domain-specific view
contracts. The Core query catalog owns `QueryDefinition`, revision, proof, and
the generic `kind: profile` envelope only; it does not validate Mission, Go, or
goal-card payloads.

The `goal-cards` renderer is declared by this member as
`kungfu.mission-control.goal-card-view/v1`. Work Dashboard validates its
`goalCards` payload and saves it inside the Profile envelope. Historical
`kind: mission-control` saved views remain readable as opaque legacy Profile
views and migrate only when the user explicitly saves them again. No stored
facts or query definitions are rewritten.
