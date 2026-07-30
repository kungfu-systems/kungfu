// SPDX-License-Identifier: Apache-2.0

import { createEpisodeRuntime, resolveRuntimeDir } from './runtime.mjs';

function eventSessionId(event) {
  const properties = event?.properties || {};
  return (
    properties.sessionID ||
    properties.sessionId ||
    properties.info?.id ||
    properties.session?.id ||
    ''
  );
}

export function createKungfuOpenCodePlugin(options = {}) {
  return async ({ directory, worktree } = {}) => {
    const runtime = createEpisodeRuntime({
      binding: options.binding,
      clock: options.clock,
      runtimeDir: resolveRuntimeDir({
        directory,
        worktree,
        runtimeDir: options.runtimeDir,
      }),
    });

    return {
      event: async ({ event }) => {
        const id = eventSessionId(event);
        if (!id) return;
        if (event.type === 'session.created') {
          runtime.begin(id);
        } else if (
          event.type === 'session.updated' ||
          event.type === 'session.status'
        ) {
          runtime.heartbeat(id, `opencode:${event.type}`);
        } else if (event.type === 'session.idle') {
          runtime.close(id, { reason: 'OpenCode session idle' });
        } else if (event.type === 'session.error') {
          runtime.close(id, {
            aborted: true,
            reason: 'OpenCode session error',
          });
        }
      },
      'tool.execute.before': async (input) => {
        if (input?.sessionID) {
          runtime.heartbeat(input.sessionID, 'opencode:tool.execute.before');
        }
      },
      'tool.execute.after': async (input) => {
        if (input?.sessionID) {
          runtime.heartbeat(input.sessionID, 'opencode:tool.execute.after');
        }
      },
    };
  };
}

export const KungfuEpisodePlugin = createKungfuOpenCodePlugin();
