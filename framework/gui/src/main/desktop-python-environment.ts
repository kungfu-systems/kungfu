export function protectPackagedPythonEnvironment(
  env: NodeJS.ProcessEnv,
  isPackaged: boolean,
) {
  if (isPackaged) env.PYTHONDONTWRITEBYTECODE = '1';
}
