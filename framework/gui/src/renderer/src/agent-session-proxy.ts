import type { AgentSession } from '@kungfu-tech/api/capability';

import { AGENT_SESSION_CALL_CHANNEL } from '../../sandbox/channels';

export type AgentSessionIpcRenderer = {
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
};

export function createAgentSessionProxy(
  ipc: AgentSessionIpcRenderer,
): AgentSession {
  return {
    invoke: (request) =>
      ipc.invoke(AGENT_SESSION_CALL_CHANNEL, request) as Promise<
        Record<string, unknown>
      >,
  };
}
