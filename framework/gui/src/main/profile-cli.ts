type ProfileCliResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string };

type ProfileCliExec = (
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

export type ProfileCliDeps = {
  bin: string;
  env: NodeJS.ProcessEnv;
  execFile: ProfileCliExec;
};

export async function executeProfileCli(
  payload: unknown,
  deps: ProfileCliDeps,
): Promise<ProfileCliResult> {
  const args = (payload as { args?: unknown })?.args;
  if (
    !Array.isArray(args) ||
    args.length < 2 ||
    args[0] !== 'profile' ||
    !args.every((value) => typeof value === 'string')
  ) {
    return { ok: false, error: 'invalid Profile CLI request' };
  }
  return await new Promise<ProfileCliResult>((resolve) => {
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
