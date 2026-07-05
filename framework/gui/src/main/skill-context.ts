import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type SkillContextEnvelope,
  buildSkillContext,
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
  const envelope = buildGuiSkillContext(options);
  const root = path.join(options.home, 'skill-context');
  mkdirSync(root, { recursive: true });
  const out = path.join(root, `${options.profile || 'default'}.json`);
  writeFileSync(out, JSON.stringify(envelope, null, 2), 'utf8');
  return out;
}
