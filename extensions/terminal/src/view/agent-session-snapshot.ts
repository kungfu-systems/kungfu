export type AgentSessionSurfaceSnapshot = {
  retainedTranscript?: boolean;
  terminal?: {
    vt?: {
      lines?: string[];
    };
  };
};

export function agentSessionSnapshotText(
  snapshot: AgentSessionSurfaceSnapshot | null,
): string {
  const lines = snapshot?.terminal?.vt?.lines;
  if (lines) return lines.join('\n');
  if (snapshot?.retainedTranscript === false) {
    return 'Structured provider session active · terminal transcript is intentionally not retained.';
  }
  return 'Waiting for Capsule output…';
}
