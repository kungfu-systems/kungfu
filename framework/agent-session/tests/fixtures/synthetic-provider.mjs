import process from 'node:process';

process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write('\x1b[2J\x1b[Hsynthetic-ready\r\n');
process.stdout.write('\x1b[?1049halternate-screen\x1b[?1049l');
process.stdout.write(`burst:${'x'.repeat(4096)}\r\n`);
process.stdout.write('approval-needed [y/N] ');
process.stdin.on('data', (data) => {
  process.stdout.write(`accepted:${JSON.stringify(data)}\r\n`);
  if (data.includes('exit')) process.exit(23);
});
