// Trusted-renderer side of the sandboxed-ipc capability path. The real
// capabilities are created here, in the node-integrated renderer that holds the
// native binding (runtime.ts). A sandboxed view cannot touch them; instead its
// invokes arrive relayed through main, and this service resolves them against a
// per-view capability host. The host is createCapabilityHost from the api layer,
// so the declared-only enforcement — and the guest<->host callback/subscription
// protocol — is exactly the contract-tested one; only the transport is the
// main relay (see sandbox-manager for the main-side wiring).
import {
  type HostEvent,
  type HostRequest,
  createCapabilityHost,
} from '@kungfu-tech/api/capability';

import {
  HOST_EVENT_CHANNEL,
  HOST_INVOKE_CHANNEL,
  HOST_REPLY_CHANNEL,
} from '../../sandbox/channels';

type IpcRendererLike = {
  on: (
    channel: string,
    listener: (event: unknown, payload: unknown) => void,
  ) => void;
  send: (channel: string, payload: unknown) => void;
};

type Host = {
  handle: (req: HostRequest) => Promise<unknown>;
  dispose: () => void;
};

// One service per trusted renderer. It owns the ipcRenderer relay endpoint and a
// map of per-view hosts; the shell registers a host before it asks main to embed
// the matching sandboxed view.
export class SandboxHostService {
  private readonly ipc: IpcRendererLike;
  private readonly hosts = new Map<string, Host>();

  constructor(ipc: IpcRendererLike) {
    this.ipc = ipc;
    // main forwards a sandboxed view's invoke here; resolve it against that
    // view's host and reply with the correlated reqId.
    ipc.on(HOST_INVOKE_CHANNEL, (_event, payload) => {
      const { id, reqId, req } = payload as {
        id: string;
        reqId: number;
        req: HostRequest;
      };
      const host = this.hosts.get(id);
      if (!host) {
        ipc.send(HOST_REPLY_CHANNEL, {
          reqId,
          ok: false,
          error: `no capability host for sandboxed view '${id}'`,
        });
        return;
      }
      host
        .handle(req)
        .then((value) =>
          ipc.send(HOST_REPLY_CHANNEL, { reqId, ok: true, value }),
        )
        .catch((e: unknown) =>
          ipc.send(HOST_REPLY_CHANNEL, {
            reqId,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          }),
        );
    });
  }

  // Register the capability host for one sandboxed view. `caps` is the real
  // capability subset (only what this renderer holds); `declared` is the
  // manifest declaration. Undeclared capabilities are rejected by the host.
  register(
    id: string,
    caps: Record<string, Record<string, unknown>>,
    declared: readonly string[],
  ): void {
    this.dispose(id);
    const emit = (event: HostEvent) =>
      this.ipc.send(HOST_EVENT_CHANNEL, { id, event });
    this.hosts.set(id, createCapabilityHost(caps, declared, emit));
  }

  dispose(id: string): void {
    const host = this.hosts.get(id);
    if (!host) return;
    host.dispose();
    this.hosts.delete(id);
  }
}
