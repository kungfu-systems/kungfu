import {
  writeSkillContextFile,
  writeSkillManagerViewFile,
} from '@kungfu-tech/skill';

export function writeGuiSkillContextFile(options: {
  home: string;
  profile?: string;
  agent?: string;
  env?: Record<string, string | undefined>;
}): string {
  return writeSkillContextFile(options.home, {
    source: 'gui',
    manager: 'node',
    profile: options.profile,
    agent: options.agent,
    env: options.env,
  });
}

export function writeGuiSkillManagerViewFile(options: {
  home: string;
  env?: Record<string, string | undefined>;
}): string {
  return writeSkillManagerViewFile(options.home, {
    env: options.env,
  });
}
