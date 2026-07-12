type AtlasCliResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string };

type AtlasCliExec = (
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

export type AtlasCliDeps = {
  bin: string;
  env: NodeJS.ProcessEnv;
  execFile: AtlasCliExec;
};

export async function executeAtlasCli(
  payload: unknown,
  deps: AtlasCliDeps,
): Promise<AtlasCliResult> {
  const args = (payload as { args?: unknown })?.args;
  if (
    !Array.isArray(args) ||
    args.length === 0 ||
    args[0] !== 'atlas' ||
    !args.every((value) => typeof value === 'string')
  ) {
    return { ok: false, error: 'invalid Atlas CLI request' };
  }
  return await new Promise<AtlasCliResult>((resolve) => {
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
