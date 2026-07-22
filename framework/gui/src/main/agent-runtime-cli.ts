type AgentRuntimeCliResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string };

type AgentRuntimeCliExec = (
  file: string,
  args: string[],
  options: {
    encoding: 'utf8';
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    timeout: number;
  },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

export type AgentRuntimeCliDeps = {
  bin: string;
  env: NodeJS.ProcessEnv;
  execFile: AgentRuntimeCliExec;
};

export async function executeAgentRuntimeCli(
  payload: unknown,
  deps: AgentRuntimeCliDeps,
): Promise<AgentRuntimeCliResult> {
  const args = (payload as { args?: unknown })?.args;
  if (
    !Array.isArray(args) ||
    args.length < 3 ||
    args[0] !== 'agent' ||
    args[1] !== 'runtime' ||
    !args.every((value) => typeof value === 'string')
  ) {
    return { ok: false, error: 'invalid Agent Runtime CLI request' };
  }
  return await new Promise<AgentRuntimeCliResult>((resolve) => {
    deps.execFile(
      deps.bin,
      args,
      {
        encoding: 'utf8',
        env: deps.env,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, error: stderr.trim() || error.message });
          return;
        }
        resolve({ ok: true, stdout });
      },
    );
  });
}
