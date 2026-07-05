import {
  type SkillContextEnvelope,
  buildSkillContext,
  writeSkillContextFile,
} from '@kungfu-tech/skill';

export function buildGuiSkillContext(options: {
  home: string;
  profile?: string;
  agent?: string;
  env?: Record<string, string | undefined>;
}): SkillContextEnvelope {
  return buildSkillContext(options.home, {
    source: 'gui',
    manager: 'node',
    profile: options.profile,
    agent: options.agent,
    env: options.env,
  });
}

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
