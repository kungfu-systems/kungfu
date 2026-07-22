type WorkLoopCliResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string };

type WorkLoopCliExec = (
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

export type WorkLoopCliDeps = {
  bin: string;
  env: NodeJS.ProcessEnv;
  execFile: WorkLoopCliExec;
};

function isAllowed(args: unknown): args is string[] {
  if (!Array.isArray(args) || !args.every((value) => typeof value === 'string'))
    return false;
  if (args.join('\0') === ['work', 'capabilities', '--json'].join('\0'))
    return true;
  return (
    args.length === 5 &&
    args[0] === 'work' &&
    (args[1] === 'inspect' || args[1] === 'recover') &&
    args[2] === '--repo' &&
    args[3].length > 0 &&
    args[4] === '--json'
  );
}

export async function executeWorkLoopCli(
  payload: unknown,
  deps: WorkLoopCliDeps,
): Promise<WorkLoopCliResult> {
  const args = (payload as { args?: unknown })?.args;
  if (!isAllowed(args)) {
    return { ok: false, error: 'invalid Work Loop CLI request' };
  }
  return await new Promise<WorkLoopCliResult>((resolve) => {
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
