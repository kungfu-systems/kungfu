---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0016
decision_status: accepted
implementation_status: partial
review_state: legacy-unreviewed
sensitivity: public
---

# ADR-0016: managed session host placement — a shared durable host for multi-window session workspaces

- Status: accepted
- Date: 2026-07-05
- Category: (architecture) process placement — where the terminal/session
  capability host runs, and how multiple GUI windows reach it.
- Subsystem: the terminal capability (`framework/api/src/capability/terminal.ts`),
  the reference-app window model (`framework/gui` main + renderer), and the
  managed session workspace (`extensions/terminal`).
- Related: ADR-0011 pinned the capability SDK contract — tier declaration and
  the zero-copy-vs-serialized split for the GUI view plane. ADR-0014 pinned the
  uniform capability surface across trust tiers: one source runs unchanged
  whether its capabilities are held in-process or addressed over an async
  capability relay. ADR-0006 pinned the v4 frontend platform. This ADR pins
  where the *session* host lives once the workspace must span more than one OS
  window.

## Context

The managed session workspace is the visual-concurrency wedge: it exists to
replace the seven-to-eight terminal windows a user spreads across monitors to
watch that many agent sessions at once. A single OS window cannot span
monitors, so a real replacement needs more than one OS window — in the limit,
one restorable window per session, placed on the display the user put it on.

Today the reference app is a single `BrowserWindow` with a single renderer. The
terminal/session capability host (`openTerminal` — a node-pty PTY host plus the
tmux durability backend added on this branch) lives in that one renderer, and a
session is addressable only through that renderer's in-memory session map.

Two capabilities already landed on this branch move the problem to exactly one
remaining blocker:

- The tmux durability backend lets a session survive GUI close/crash; `detach`
  keeps the agent running, `discover`/`reattach` bring it back.
- A persisted `WorkspaceLayout` (a journal-backed config fact) restores the open
  set after an app restart via `adopt`, which re-registers a session by runId
  and reattaches to its surviving tmux session.

The blocker: a second `BrowserWindow` is a separate renderer process. It cannot
reach the first renderer's in-memory session host. To show sessions in more than
one OS window, the durable session host must be reachable from every window —
which is a placement question, not a feature.

### Forces

1. **Durability wants the host to outlive any window.** That is the point of the
   whole line. Today the tmux backend keeps the *agent* alive when a window
   closes, but the host *handle* dies with the renderer and must rediscover and
   reattach. A host that outlives windows removes that gap.
2. **The moat (ADR-0011) keeps zero-copy journal/state access in the trusted
   renderer.** But the terminal host is not the zero-copy journal path — it is
   node-pty and tmux, already separable from the kungfu binding, and it already
   exposes a Promise-friendly surface (the view uses one `resolve()` path for
   both the sync and async shapes).
3. **The uniform capability surface (ADR-0014) already tolerates an out-of-process
   host.** A sandboxed view addresses its capabilities over an async relay today;
   the transport and the capability proxy already exist. An out-of-renderer
   terminal host is within that design envelope, not a new IPC invention.

## Options

**A. Host stays in the shell renderer; extra windows relay to it.** Each session
window is a `BrowserWindow` that reaches the shell renderer's host through main
(window → main → shell renderer → host → back). A three-hop relay, and the host
still dies with the shell window — the durability gap in force (1) remains. High
complexity for a worse durability story. Rejected.

**B. Move the session host to the main process.** node-pty + the tmux backend run
in main (main is node, app-lifetime). Every renderer — the shell and each
per-session window — reaches the host through `ipcMain`, reusing the ADR-0014
capability relay; `caps.terminal` becomes an IPC proxy for all consumers.
`onData`/`onExit` become relayed event streams. The host outlives every window,
which is exactly force (1); it reuses the existing relay per force (3); and it
leaves the zero-copy journal moat untouched in the trusted renderer per force
(2), since the terminal host was never on that path.

**C. Stay single-window (the in-view grid only).** No monitor spanning; the wedge
is only partially met (three panes on one screen, not seven across three
monitors). Acceptable as a resting point, not as the destination.

## Decision (proposed)

Adopt **Option B**: the managed session host moves to the main process and is
addressed by every window over the existing capability relay.

Rationale: it is the only option where the durable host genuinely outlives
windows (matching the intent of the whole durability line); it reuses the
ADR-0014 relay rather than inventing transport; and it cleanly separates the
session host (node-pty/tmux) from the zero-copy journal moat that stays in the
trusted renderer under ADR-0011. tmux remains a backend detail; the product
model still speaks "session", never "tmux".

### Migration plan (staged, each stage validated on a real machine)

1. **Extract the host to main, proxy to the renderer.** Move `openTerminal`
   wiring from the renderer runtime into a main-process module; expose it over
   `ipcMain` through the capability transport; keep the renderer `caps.terminal`
   as an IPC proxy of the same `Terminal` interface. Validate parity: the
   existing single-window workspace behaves identically (no product change).
2. **Per-session windows + bounds.** Add `BrowserWindow`-per-session management in
   main and extend `WorkspaceLayout` with `windows[]` carrying display identity
   and bounds. Land F7: a stable display identifier plus clamp rules — an
   off-screen window is pulled back onto a visible display, a window whose saved
   display is gone falls back to the primary.
3. **Session-window entry.** A window renderer that mounts the existing terminal
   view against a single runId over the proxy.
4. **Overview.** Keep the in-shell grid as an at-a-glance overview; the OS windows
   are the working surface.

## Consequences

- **Positive.** Real multi-monitor session windows; a host that survives window
  churn; reuse of the existing relay; the journal moat is untouched.
- **Negative.** The terminal capability now always crosses IPC, so high-throughput
  output pays relay cost — mitigated by the host's existing 256 KiB per-session
  buffer and late-attach replay, but it needs real-machine validation of
  streaming and backpressure. The main-process surface grows (window lifecycle,
  per-session windows). None of this is verifiable without running Electron, so
  each stage lands behind a real-machine check.
- **Neutral.** ADR-0011 is unaffected: journal/state zero-copy stays in the
  trusted renderer. ADR-0014's relay gains a first-party, non-sandbox consumer.

**Accepted** 2026-07-05: the placement is adopted and the migration proceeds
stage by stage, each behind a real-machine check. The single-window workspace,
tmux backend, and layout persistence already on this branch stand on their own
and were not blocked on this decision.

## Implementation note — the relay does not round-trip a subscription's stop()

The obvious way to reach a main-process host is to reuse the existing capability
relay (`createCapabilityHost` / `createCapabilityGuest`). That relay does
marshal callback arguments (an `onData` listener crosses as a callback ref, and
the host emits events back), but it does **not** round-trip a per-subscription
`stop()`: the host returns a `{ __sandboxSubscription }` marker and only drops
subscriptions in bulk when the whole guest disconnects (`host.dispose()`). The
guest proxy hands that marker straight back, so `sub.stop()` is a no-op on a
sandboxed view.

That is fine for a view-lifetime capability, but wrong for the terminal host,
whose subscriptions churn continuously — every pane adds and removes `onData` /
`onExit`, and a `stop()` that does nothing would leak listeners on a long-lived
host and keep writing into disposed terminals. So Stage 1 uses a **terminal-
specific IPC proxy** with an explicit subscribe / unsubscribe protocol
(subscribe returns a real `{ stop }` that calls back to release the host-side
subscription), rather than extending the shared relay. Extending the shared
relay to round-trip `stop()` is a larger change to an ADR-0014 contract module
and is deferred; the terminal proxy stays self-contained.

Stage 1 lands **behind a flag** (`KF_TERMINAL_HOST=main`): the default keeps the
in-renderer host, so the working single-window app is untouched and parity is
preserved by construction, while the main-process path is exercised by flipping
the flag on a real machine. Promoting it to the default happens only after that
real-machine parity check passes.

## Implementation note — stage 2 windows are driven through the shell, not a capability

Stage 2 adds the per-session OS window: a session can be popped out of the
in-shell grid into its own restorable window, placed on the display it was last
on. Three pieces land together — a `windows[]` layer on the persisted
`WorkspaceLayout` (a window references a session by runId, so window identity
stays separate from session identity and a closing window never ends the
session), a pure `placeWindow` geometry that implements F7 (a saved rectangle is
clamped into a currently-connected display's work area; a display that is gone
falls back to the primary, so a stale off-screen origin cannot survive), and a
main-process window registry that owns the BrowserWindows and pushes a layout
snapshot back to the shell on every open / close / move.

The view stays electron-free. Rather than teach the terminal view about
`ipcRenderer` — which would break its "runs identically node-integrated or
sandboxed" property — pop-out is offered as a **shell service**
(`shell.popOutSession` / `restoreSessionWindows` / `onSessionWindowsSnapshot`),
present only on the node-integrated shell that can reach main and absent in a
sandbox, where popping a session into an OS window has no meaning. This keeps the
window host out of the ADR-0011 / ADR-0014 capability contract: it is a shell
concern, not a new capability.

Stage 2 lands **behind a flag** (`KF_SESSION_WINDOWS=1`), default off, so the
single-window app is untouched and parity holds by construction. The window's
content is a placeholder in stage 2; mounting the live terminal view against the
window's runId over the host proxy is stage 3. Promotion and the
terminal-in-window render happen only after a real-machine check of window
placement, restore, and the IPC output path.
