import { createDetachedAgentSessionHost } from '@kungfu-tech/agent-session/product-client';
import type { AgentSession } from '@kungfu-tech/api/capability';

import { AGENT_SESSION_CALL_CHANNEL } from '../sandbox/channels';

type IpcMainLike = {
  handle: (
    channel: string,
    listener: (event: unknown, payload: unknown) => unknown,
  ) => void;
  removeHandler: (channel: string) => void;
};

export function createMainAgentSessionHost(runtimeDir: string): AgentSession {
  const host = createDetachedAgentSessionHost({ runtimeDir });
  process.env.KUNGFU_AGENT_SESSION_ENDPOINT = host.endpoint;
  return { invoke: (request) => host.invoke(request) };
}

export function bindElectronAgentSessionHost(
  ipcMain: IpcMainLike,
  host: AgentSession,
) {
  ipcMain.handle(AGENT_SESSION_CALL_CHANNEL, (_event, request) =>
    host.invoke(request as Record<string, unknown> & { operation: string }),
  );
  return {
    dispose() {
      ipcMain.removeHandler(AGENT_SESSION_CALL_CHANNEL);
    },
  };
}
