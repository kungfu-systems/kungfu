import { createHash } from 'node:crypto';

const provider = process.argv[2] ?? 'codex';
const prompt = provider === 'claude' ? '❯ ' : '› ';
const approval =
  provider === 'claude'
    ? 'Do you want to proceed?'
    : 'Would you like to run this command?';

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');

function ready(message = '') {
  if (message) process.stdout.write(`${message}\r\n`);
  process.stdout.write(prompt);
}

ready(`${provider} qualification fixture`);
process.stdin.on('data', (data) => {
  if (data.includes('__exit__')) process.exit(23);
  if (data.includes('__burst__')) {
    process.stdout.write(`burst:${'x'.repeat(320 * 1024)}\r\n`);
    ready();
    return;
  }
  if (data.includes('__approval__')) {
    process.stdout.write(`${approval}\r\n`);
    return;
  }
  if (data === '\u001b') {
    ready('interrupt acknowledged');
    return;
  }
  const digest = createHash('sha256').update(data).digest('hex');
  ready(`accepted:sha256:${digest}`);
});

process.once('SIGINT', () => ready('interrupt acknowledged'));

