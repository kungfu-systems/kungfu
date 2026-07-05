import {
  type SkillContextEnvelope,
  type SkillManagerView,
  buildSkillContext,
  buildSkillManagerView,
  writeSkillContextFile,
  writeSkillManagerViewFile,
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

export function buildGuiSkillManagerView(options: {
  home: string;
  env?: Record<string, string | undefined>;
}): SkillManagerView {
  return buildSkillManagerView(options.home, {
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
