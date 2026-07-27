# Work Control Views

Work Control owns the five-question reducer and its domain-specific view
contracts. The Core query catalog owns `QueryDefinition`, revision, proof, and
the generic `kind: profile` envelope only; it does not validate Initiative,
Assignment, or card payloads.

The `assignment-cards` renderer is declared by this member. Work Dashboard
validates its payload and saves it inside the Profile envelope. Historical
`kind: mission-control` saved views remain readable as opaque legacy Profile
views and migrate only when the user explicitly saves them again. No stored
facts or query definitions are rewritten.
