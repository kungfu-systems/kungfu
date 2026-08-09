import type {
  AgentRuntime,
  AgentRuntimeCatalog,
  AgentRuntimeProfile,
} from '@kungfu-tech/api/capability';

export function availableAgentRuntimeProfiles(
  catalog: AgentRuntimeCatalog | null,
): AgentRuntimeProfile[] {
  if (!catalog) return [];
  const rows = [...catalog.configured];
  const ids = new Set(rows.map((profile) => profile.id));
  for (const candidate of catalog.discovered) {
    if (!ids.has(candidate.profile.id)) rows.push(candidate.profile);
  }
  const preferred = catalog.defaultProfileId ?? catalog.recommendedProfileId;
  return rows.sort((left, right) =>
    left.id === preferred ? -1 : right.id === preferred ? 1 : 0,
  );
}

export async function rememberDiscoveredAgentRuntimeProfile(
  runtime: AgentRuntime,
  profile: AgentRuntimeProfile,
): Promise<boolean> {
  if (profile.source !== 'discovered') return false;
  await runtime.upsert(
    {
      id: profile.id,
      label: profile.label,
      provider: profile.provider,
      executable: profile.launch.executable,
      argv: profile.launch.argv,
      shellMode: profile.launch.shellMode,
      cwdPolicy: profile.cwdPolicy,
      backend: profile.backendDefault,
      envelope: profile.bootstrap.envelope,
    },
    true,
  );
  await runtime.setDefault(profile.id, true);
  return true;
}
